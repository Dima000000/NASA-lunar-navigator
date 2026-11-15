import {surfacePath,modelStepSeconds} from './drive-navigation.mjs';
import {VEHICLE,solarPower,AU_KM} from './science-core.mjs';
import {ROVER,driveFrame,easeInput,forecastParked,createSolarScan,advanceSolarScan,scanSolarW,roverReason,routeStartIndex} from './rover-sim.mjs';
import {buildCSV} from './csv-export.mjs';
export const DRIVE_START_DISTANCE = 0.025;
const ILLUSTRATIVE_APPROACH_AZIMUTH = 120;

window.NASALComponent = class Component extends DCLogic {
  constructor(...args) {
    super(...args);
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const P = this.presets(), pal = this.palette();
    const mk = (p, i) => ({ id: 's' + (i + 1), key: p.key, name: p.name, lat: p.lat, lon: p.lon, approx: p.approx, color: pal[i] });
    this._nextId = 4;
    this.state = {
      sites: [mk(P[0], 0), mk(P[1], 1), mk(P[2], 2)],
      sel: 's1', start: start, end: start + 30 * 86400000, stepH: 1, ti: Math.max(0, now.getUTCHours()),
      playing: false, speed: 6, view: 'region', model: 'G0', visDef: 'any', layer: 'score', wSun: 50, wEarth: 30, wGap: 20,
      addLat: '', addLon: '', addErr: '', pick: false, landing: false, tprog: 0, tready: '',
      csvUrl: '', csvName: '', csvSumUrl: '', csvSumName: '', csvKey: '', glError: '',
      sheet: null, sitesOpen: false, tipOff: {}, turbo: false, rover: null, landTi: null, target: null, drain: true, driveCard: false, cmpSel: null, cmpMode: 'overlay', bigMap: false, obsH: 2
    };
  }
  presets() {
    return [
      { key: 'cr', name: 'Connecting Ridge', lat: -89.467, lon: -136.667, approx: false },
      { key: 'sdg', name: 'Shackleton–de Gerlache Ridge', lat: -89.684, lon: -163.261, approx: false },
      { key: 'mal', name: 'Malapert Massif', lat: -86.0, lon: 2.9, approx: true },
      { key: 'lbp', name: 'Leibnitz β Plateau', lat: -85.4, lon: 31.7, approx: true },
      { key: 'pole', name: 'South Pole', lat: -90.0, lon: 0.0, approx: false }
    ];
  }
  palette() { return ['#5C9470', '#D9534F', '#5E8FD6', '#F2C94C', '#E3936B', '#8FB7A0']; }

  componentDidMount() {
    this._alive = true;
    this._tick = (now) => {
      if (!this._alive) return;
      this._raf = requestAnimationFrame(this._tick);
      const s = this.state;
      const driving=s.view==='drive'&&!s.landing;
      if (!s.playing&&!driving) { this._lastT = now; this._tf = s.ti; return; }
      // Drive: real elapsed time (up to 0.5 s for slow frames) times the multiplier, so 1 s at 3600x is 1 simulated hour.
      const dt = Math.min(driving ? 0.5 : 0.1, (now - (this._lastT || now)) / 1000);
      this._lastT = now;
      let ser = this._ser; if (driving) { try { ser = this.series(); } catch (err) { } } // a range change (extendMission) must not be judged against the old series
      const n = ser ? ser.n : 2;
      if (this._tf === undefined || this._tf === null) this._tf = s.ti;
      if(driving&&s.missionEnded&&ser&&this._tf<n-1-1e-6)this.setState({missionEnded:false}); // the mission was extended, or the clock moved back
      if(driving&&s.drivePaused){this.renderContinuousTime?.(s.start+this._tf*s.stepH*3600000,now);return;}
      if(driving){
        // Simulated seconds this frame = real seconds x the multiplier in force (driveRate), clipped at a wait target (driveClockLimit)
        // and at the mission end. The rover integrates exactly this amount (advanceDriveClock), so clock, distance and battery agree.
        const stepS=s.stepH*3600,t0=this._tf*stepS,endS=(n-1)*stepS,limitS=((this.driveClockLimit?.()??Infinity)-s.start)/1000;
        let t1=t0+modelStepSeconds(dt,this.driveRate()),atLimit=false,ended=false;
        if(t1>=limitS){t1=Math.max(t0,limitS);atLimit=true;}
        if(ser&&t1>=endS){t1=endS;ended=true;}
        this._tf=t1/stepS;
        this.eng?.advanceDriveClock?.(Math.max(0,t1-t0));
        // The end of the planned stay is a distinct state (roverStatus.reason 'mission-ended'), not a silent freeze.
        if(ended&&!(s.drivePaused&&s.missionEnded))this.setState({drivePaused:true,missionEnded:true});
        if(atLimit||ended)this.onDriveClockLimit?.(ended);
      } else {
        this._tf += dt*s.speed / s.stepH;
        if (this._tf > n - 1) this._tf = 0;
      }
      this.renderContinuousTime?.(s.start+this._tf*s.stepH*3600000,now);
      const ti = Math.floor(this._tf);
      if (ti !== s.ti && now - (this._lastSet || 0) > 45) { this._lastSet = now; this.setState({ ti: ti }); }
    };
    this._raf = requestAnimationFrame(this._tick);
    this.tryEngine();
  }
  componentWillUnmount() {
    this._alive = false;
    cancelAnimationFrame(this._raf);
    if (this._tj) this._tj.cancel = true;
    if (this.eng) { this.eng.destroy(); this.eng = null; }
  }
  componentDidUpdate() { this.ensureTerrain(); this.sync(); this.drawMaps(); }

  // Time multiplier in force this frame. While the rover drives it is capped (by hand 1 s = 2 min, on autopilot 1 s = 1 h — see
  // ROVER.manualMaxScale / autoMaxScale) so 0.7 km/h never looks like a race car; 1 s = 1 day is for a parked rover (charging, Earthrise).
  driveRate() { let r = this.state.driveTimeScale ?? 60; const cap = this.eng?.driveScaleCap?.() ?? Infinity; if (this.state.view === 'drive' && r > cap) { r = cap; this.setState({ driveTimeScale: cap }); } return r; }
  // Any drive control (key, pad button, joystick): resume a paused simulation — but not a finished mission — and apply the cap.
  driveInput() {
    const s = this.state; if (s.view !== 'drive') return;
    if (!s.missionEnded && (s.drivePaused || s.driveTimeScale === 0)) this.setState({ drivePaused: false, driveTimeScale: s.driveTimeScale === 0 ? (this._lastDriveRate || 60) : s.driveTimeScale });
    this.driveRate();
  }
  capDriveRate() { this.driveInput(); }
  // On-screen pad button: behaves like holding the key. The pointer is captured, so sliding off the button or a second finger
  // elsewhere does not release it; a quick tap still nudges the rover (the engine holds a press for at least 220 ms).
  padEvent(name, on, ev) {
    const el = ev && ev.currentTarget, id = ev ? ev.pointerId : undefined, P = (this._padPtr ??= {});
    const apply = (v) => { if (!this.eng) return; if (name === 'stop') this.eng.brake(v); else this.eng.pad(name, v); };
    if (on) {
      if (ev && ev.button > 0) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      try { if (el && id !== undefined) el.setPointerCapture(id); } catch (err) { }
      P[name] = { id: id };
      if (name === 'stop') this.brake ? this.brake(true) : apply(true); else { this.driveInput(); apply(true); }
      return;
    }
    const p = P[name]; if (!p || (id !== undefined && p.id !== undefined && id !== p.id)) return;
    if (ev && ev.type === 'pointerleave' && el && el.hasPointerCapture && el.hasPointerCapture(id)) return;
    delete P[name];
    apply(false);
  }
  refs() {
    if (!this._refs) {
      const k = (name, on) => (ev) => this.padEvent(name, on, ev);
      this._refs = {
        stage: (el) => { this._stageEl = el; this.tryEngine(); },
        gl: (el) => { this._glEl = el; this.tryEngine(); },
        ov: (el) => { this._ovEl = el; this.tryEngine(); },
        mini: (el) => { if (el || !this._miniEl || !this._miniEl.isConnected) this._miniEl = el; if (el) this.drawMaps(); }, // Overview and Terrain/Drive each mount their own map canvas
        big: (el) => { this._bigEl = el; if (el) this.drawMaps(); },
        pad: { upOn: k('up', true), upOff: k('up', false), downOn: k('down', true), downOff: k('down', false), leftOn: k('left', true), leftOff: k('left', false), rightOn: k('right', true), rightOff: k('right', false), stopOn: k('stop', true), stopOff: k('stop', false) }
      };
    }
    return this._refs;
  }
  tryEngine() {
    if (this.eng || this._engFailed || !this._alive) return;
    if (!this._stageEl || !this._glEl || !this._ovEl) return;
    try {
      this.eng = this.engLib().create(this._glEl, this._ovEl, this._stageEl, {
        // Clicking a place pin on the globe flies straight down into its Terrain view.
        onSelect: (id) => { this.setState({ sel: id, sitesOpen: false, csvUrl: '' }, () => this.goView('terrain')); },
        onOpen: (id) => { this.setState({ sel: id }, () => this.goView('terrain')); },
        onPick: (lat, lon) => this.addSiteAt(lat, lon, ''),
        onLanded: () => this.setState({ landing: false, landed: true }),
        onRover: (r) => this.setState({ rover: r, roverStatus: r.status }),
        onDriveInput: () => this.driveInput(),
        onBrake: () => this.onRoverBrake?.(),
        onAutopilot: (on, why) => this.setState({ autopilot: on, autopilotWhy: why }),
        onTarget: (i, j) => {
          // In Drive the default camera sits a few metres behind the rover, so a click on nearby ground resolves to the rover's own cell.
          // Don't set a useless 0 m destination; tell the user how to pick a real one instead.
          const o = this.state.view === 'drive' ? this.reachOrigin() : null;
          if (o && o.from === 'rover' && Math.hypot(i - o.i, j - o.j) < 2) { const t = Date.now(); this.setState({ nearHint: t }); setTimeout(() => { if (this.state.nearHint === t) this.setState({ nearHint: 0 }); }, 4000); return; }
          this.setState({ target: { i: i, j: j, key: this._tj ? this._tj.key : '' }, nearHint: 0 });
        }
      });
      this.ensureTerrain();
      this.sync();
    } catch (err) {
      this._engFailed = true;
      this.setState({ glError: '3D view unavailable: ' + (err && err.message ? err.message.split('\n')[0] : 'WebGL error') + '. The time bar and comparisons still work.' });
    }
  }

  // ---------- ephemeris ----------
  eph() {
    if (this._EPH) return this._EPH;
    const D2R = Math.PI / 180, R2D = 180 / Math.PI, RM = 1737.4, AU = 149597870.7;
    const sind = (x) => Math.sin(x * D2R), cosd = (x) => Math.cos(x * D2R);
    const LT = [
      [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],[0,0,2,0,213618,-569925],
      [0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],[2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],
      [2,0,1,0,53322,-170733],[2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
      [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],[0,0,1,-2,10980,79661],
      [4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],[4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],
      [2,1,0,0,-6766,30824],[1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
      [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],[0,1,-2,0,-2689,-7003],
      [2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],[1,0,1,0,-2348,6322],[2,-2,0,0,2236,-9884]
    ];
    const BT = [
      [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],[2,0,-1,1,55413],
      [2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],[2,0,1,-1,9266],[0,0,2,-1,8822],
      [2,-1,0,-1,8216],[2,0,-2,-1,4324],[2,0,1,1,4200],[2,1,0,-1,-3359],[2,-1,-1,1,2463],
      [2,-1,0,1,2211],[2,-1,-1,-1,2065],[0,1,-1,-1,-1870],[4,0,-1,-1,1828],[0,1,0,1,-1794]
    ];
    function moonGeo(T) {
      const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T;
      const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T;
      const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;
      const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;
      const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T;
      const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T;
      const E = 1 - 0.002516 * T - 0.0000074 * T * T;
      let sl = 0, sr = 0, sb = 0;
      for (let i = 0; i < LT.length; i++) {
        const t = LT[i], arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F;
        const e = Math.abs(t[1]) === 1 ? E : (Math.abs(t[1]) === 2 ? E * E : 1);
        sl += t[4] * e * sind(arg); sr += t[5] * e * cosd(arg);
      }
      for (let i = 0; i < BT.length; i++) {
        const t = BT[i], arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F;
        const e = Math.abs(t[1]) === 1 ? E : (Math.abs(t[1]) === 2 ? E * E : 1);
        sb += t[4] * e * sind(arg);
      }
      sl += 3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2);
      sb += -2235 * sind(Lp) + 382 * sind(A3) + 175 * sind(A1 - F) + 175 * sind(A1 + F) + 127 * sind(Lp - Mp) - 115 * sind(Lp + Mp);
      const prec = (5029.0966 * T + 1.11113 * T * T) / 3600;
      const lam = Lp + sl / 1e6 - prec, bet = sb / 1e6, r = 385000.56 + sr / 1000;
      return [r * cosd(bet) * cosd(lam), r * cosd(bet) * sind(lam), r * sind(bet)];
    }
    function sunGeo(T) {
      const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
      const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
      const e = 0.016708634 - 0.000042037 * T;
      const C = (1.914602 - 0.004817 * T) * sind(M) + (0.019993 - 0.000101 * T) * sind(2 * M) + 0.000289 * sind(3 * M);
      const nu = M + C, R = 1.000001018 * (1 - e * e) / (1 + e * cosd(nu)) * AU;
      const prec = (5029.0966 * T + 1.11113 * T * T) / 3600;
      const lam = L0 + C - prec;
      return [R * cosd(lam), R * sind(lam), 0];
    }
    function ecl2eq(v) { const c = cosd(23.4392911), s = sind(23.4392911); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]; }
    function moonRot(d, T) {
      const E = [0, 125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
        357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d,
        34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d, 25.053 + 12.9590088 * d];
      const a0 = 269.9949 + 0.0031 * T - 3.8787 * sind(E[1]) - 0.1204 * sind(E[2]) + 0.0700 * sind(E[3]) - 0.0172 * sind(E[4])
        + 0.0072 * sind(E[6]) - 0.0052 * sind(E[10]) + 0.0043 * sind(E[13]);
      const d0 = 66.5392 + 0.0130 * T + 1.5419 * cosd(E[1]) + 0.0239 * cosd(E[2]) - 0.0278 * cosd(E[3]) + 0.0068 * cosd(E[4])
        - 0.0029 * cosd(E[6]) + 0.0009 * cosd(E[7]) + 0.0008 * cosd(E[10]) - 0.0009 * cosd(E[13]);
      const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * sind(E[1]) + 0.1208 * sind(E[2]) - 0.0642 * sind(E[3])
        + 0.0158 * sind(E[4]) + 0.0252 * sind(E[5]) - 0.0066 * sind(E[6]) - 0.0047 * sind(E[7]) - 0.0046 * sind(E[8])
        + 0.0028 * sind(E[9]) + 0.0052 * sind(E[10]) + 0.0040 * sind(E[11]) + 0.0019 * sind(E[12]) - 0.0044 * sind(E[13]);
      return { a0: a0, d0: d0, W: W };
    }
    function toBody(v, r) {
      const a = (90 + r.a0) * D2R, b = (90 - r.d0) * D2R, w = r.W * D2R;
      const x = Math.cos(a) * v[0] + Math.sin(a) * v[1], y = -Math.sin(a) * v[0] + Math.cos(a) * v[1], z = v[2];
      const y2 = Math.cos(b) * y + Math.sin(b) * z, z2 = -Math.sin(b) * y + Math.cos(b) * z;
      return [Math.cos(w) * x + Math.sin(w) * y2, -Math.sin(w) * x + Math.cos(w) * y2, z2];
    }
    function state(ms) {
      const jd = ms / 86400000 + 2440587.5 + 69.184 / 86400;
      const d = jd - 2451545.0, T = d / 36525;
      const m = moonGeo(T), s = sunGeo(T), rot = moonRot(d, T);
      return {
        sun: toBody(ecl2eq([s[0] - m[0], s[1] - m[1], s[2] - m[2]]), rot),
        earth: toBody(ecl2eq([-m[0], -m[1], -m[2]]), rot)
      };
    }
    function enu(lat, lon) {
      const la = lat * D2R, lo = lon * D2R;
      return {
        up: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
        east: [-Math.sin(lo), Math.cos(lo), 0],
        north: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)]
      };
    }
    function azel(v, f) {
      const n = Math.hypot(v[0], v[1], v[2]);
      const u = (v[0] * f.up[0] + v[1] * f.up[1] + v[2] * f.up[2]) / n;
      const e = v[0] * f.east[0] + v[1] * f.east[1] + v[2] * f.east[2];
      const no = v[0] * f.north[0] + v[1] * f.north[1] + v[2] * f.north[2];
      let az = Math.atan2(e, no) * R2D; if (az < 0) az += 360;
      return { az: az, el: Math.asin(Math.max(-1, Math.min(1, u))) * R2D, dist: n };
    }
    function topo(st, lat, lon, hkm) {
      const f = enu(lat, lon), rr = RM + (hkm || 0);
      const p = [f.up[0] * rr, f.up[1] * rr, f.up[2] * rr];
      const s = azel([st.sun[0] - p[0], st.sun[1] - p[1], st.sun[2] - p[2]], f);
      const e = azel([st.earth[0] - p[0], st.earth[1] - p[1], st.earth[2] - p[2]], f);
      s.rad = Math.asin(695700 / s.dist) * R2D;
      e.rad = Math.asin(6378.137 / e.dist) * R2D;
      return { sun: s, earth: e };
    }
    this._EPH = { state: state, topo: topo, enu: enu, RM: RM, AU: AU };
    return this._EPH;
  }

  // ---------- visibility helpers ----------
  diskFrac(x, r) {
    if (r <= 0) return x > 0 ? 1 : 0;
    const q = Math.max(-1, Math.min(1, x / r));
    return 1 - (Math.acos(q) - q * Math.sqrt(1 - q * q)) / Math.PI;
  }
  visThr() { const v = this.state.visDef; return v === 'center' ? 0.5 : (v === 'full' ? 0.9995 : 0.0005); }

  // ---------- terrain library ----------
  terrLib() {
    if (this._TL) return this._TL;
    const RM = 1737.4, D2R = Math.PI / 180;
    function hash2(x, y, s) {
      let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
    function vn(x, y, s) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    function fbm(x, y, s, o) { let a = 0.5, f = 1, t = 0; for (let i = 0; i < o; i++) { t += a * (vn(x * f, y * f, s + i * 31) * 2 - 1); a *= 0.5; f *= 2.03; } return t; }
    function ridge(x, y, s, o) { let a = 0.5, f = 1, t = 0; for (let i = 0; i < o; i++) { const n = 1 - Math.abs(vn(x * f, y * f, s + i * 17) * 2 - 1); t += a * n * n; a *= 0.5; f *= 2.1; } return t; }
    function rng(seed) {
      let a = seed >>> 0;
      return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function sstep(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
    function genDEM(seed, ox, oy) {
      ox = ox || 0; oy = oy || 0;
      const N = 241, L = 16, cell = L / (N - 1), h = new Float32Array(N * N), r = rng(seed);
      const cr = [];
      const ba = r() * Math.PI * 2, bd = L * (0.62 + r() * 0.22);
      cr.push({ x: Math.cos(ba) * bd, y: Math.sin(ba) * bd, r: L * (0.36 + r() * 0.2), d: 0 });
      for (let k = 0; k < 150; k++) {
        const rad = 0.06 + Math.pow(r(), 2.8) * 2.4;
        const x = (r() * 2 - 1) * L * 0.62, y = (r() * 2 - 1) * L * 0.62;
        if (Math.hypot(x, y) < rad + 0.9) continue;
        cr.push({ x: x, y: y, r: rad, d: 0 });
      }
      for (let k = 0; k < cr.length; k++) cr[k].d = cr[k].r * 2 * (0.12 + 0.08 * r());
      cr[0].d = cr[0].r * 2 * 0.17;
      const tx = (r() * 2 - 1) * 0.03, ty = (r() * 2 - 1) * 0.03;
      const zAt = (x, y) => {
        let z = 0.6 * ridge(x / 7, y / 7, seed, 4) - 0.05 * Math.hypot(x, y) + 0.3 * fbm(x / 2.4, y / 2.4, seed + 5, 4)
          + 0.05 * fbm(x * 1.6, y * 1.6, seed + 9, 3) + 0.012 * fbm(x * 7, y * 7, seed + 13, 2) + tx * x + ty * y;
        for (let k = 0; k < cr.length; k++) {
          const c = cr[k], dx = x - c.x, lim = 2.6 * c.r;
          if (dx > lim || dx < -lim) continue;
          const dy = y - c.y; if (dy > lim || dy < -lim) continue;
          const d = Math.sqrt(dx * dx + dy * dy) / c.r;
          if (d > 2.6) continue;
          if (d < 1) z += c.d * (d * d - 1) * (1 - 0.25 * (1 - d * d));
          const q = (d - 1) * (d < 1 ? 4 : 2.2);
          z += 0.16 * c.d * Math.exp(-q * q);
        }
        z += 1.0 * Math.exp(-(x * x + y * y) / (2 * 2.6 * 2.6));
        return z;
      };
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = zAt(-L / 2 + i * cell + ox, -L / 2 + j * cell + oy);
      const ci = ((N - 1) / 2) * N + (N - 1) / 2, hc = (ox || oy) ? Math.fround(zAt(0, 0)) : h[ci];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = -L / 2 + i * cell + ox, y = -L / 2 + j * cell + oy, rr = Math.hypot(x, y);
        if (rr < 0.6) { const w = sstep(0.6, 0.2, rr), k = j * N + i; h[k] = h[k] * (1 - w) + (hc + 0.003 * fbm(x * 6, y * 6, seed + 3, 2)) * w; }
      }
      const c0 = h[ci]; let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < h.length; k++) { h[k] -= c0; if (h[k] < mn) mn = h[k]; if (h[k] > mx) mx = h[k]; }
      return { N: N, L: L, cell: cell, h: h, min: mn, max: mx, seed: seed };
    }
    function samp(dem, x, y) {
      const N = dem.N, h = dem.h, xi = x | 0, yi = y | 0, xf = x - xi, yf = y - yi, i0 = yi * N + xi;
      const x1 = xi < N - 1 ? 1 : 0, y1 = yi < N - 1 ? N : 0;
      return (h[i0] * (1 - xf) + h[i0 + x1] * xf) * (1 - yf) + (h[i0 + y1] * (1 - xf) + h[i0 + y1 + x1] * xf) * yf;
    }
    function horizonAt(dem, fi, fj, h0, sa, ca) {
      const N = dem.N, cell = dem.cell; let best = -1e9, s = 1;
      for (;;) {
        const x = fi + sa * s, y = fj + ca * s;
        if (x < 0 || y < 0 || x > N - 1 || y > N - 1) break;
        const dist = s * cell, t = (samp(dem, x, y) - h0 - dist * dist / (2 * RM)) / dist;
        if (t > best) best = t;
        s += s < 30 ? 1 : s * 0.05;
      }
      const dip = -0.087;
      return best === -1e9 ? dip : Math.max(dip, Math.atan(best) / D2R);
    }
    function profile(dem, obs) {
      const c = (dem.N - 1) / 2, h0 = dem.h[c * dem.N + c] + (obs || 0.002), out = new Float32Array(360);
      for (let a = 0; a < 360; a++) out[a] = horizonAt(dem, c, c, h0, Math.sin(a * D2R), Math.cos(a * D2R));
      return out;
    }
    function profAt(p, az) { const f = ((az % 360) + 360) % 360, k = Math.floor(f), w = f - k; return p[k] * (1 - w) + p[(k + 1) % 360] * w; }
    function horizonMapAsync(dem, B, stride, job, onProg, onDone, obs) {
      const N = dem.N, Nc = (N - 1) / stride + 1, out = new Float32Array(Nc * Nc * B), sc = [];
      for (let k = 0; k < B; k++) { const a = k / B * Math.PI * 2; sc.push([Math.sin(a), Math.cos(a)]); }
      let cj = 0;
      function chunk() {
        if (job.cancel) return;
        const t0 = performance.now();
        while (cj < Nc && performance.now() - t0 < 22) {
          for (let ci = 0; ci < Nc; ci++) {
            const i = ci * stride, j = cj * stride, v = cj * Nc + ci, h0 = dem.h[j * N + i] + (obs || 0.002);
            for (let k = 0; k < B; k++) out[v * B + k] = horizonAt(dem, i, j, h0, sc[k][0], sc[k][1]);
          }
          cj++;
        }
        if (cj < Nc) { onProg(cj / Nc); setTimeout(chunk, 0); } else { job.hmap = out; onDone(); }
      }
      setTimeout(chunk, 0);
    }
    function upsample(arr, Nc, stride, N) {
      const cacheKey = Nc + '|' + stride + '|' + N;
      if (upsample.key !== cacheKey) {
        const index = new Uint16Array(N), weight = new Float64Array(N);
        for (let i = 0; i < N; i++) { const f = i / stride; index[i] = Math.min(Nc - 2, Math.floor(f)); weight[i] = f - index[i]; }
        upsample.key = cacheKey; upsample.index = index; upsample.weight = weight;
      }
      const index = upsample.index, weight = upsample.weight;
      const out = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const row = index[j] * Nc, wj = weight[j];
        for (let i = 0; i < N; i++) {
          const wi = weight[i], b = row + index[i];
          out[j * N + i] = (arr[b] * (1 - wi) + arr[b + 1] * wi) * (1 - wj) + (arr[b + Nc] * (1 - wi) + arr[b + Nc + 1] * wi) * wj;
        }
      }
      return out;
    }
    function slopes(dem) {
      const N = dem.N, h = dem.h, c = dem.cell, out = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jd = Math.max(0, j - 1), ju = Math.min(N - 1, j + 1);
        const gx = (h[j * N + ir] - h[j * N + il]) / ((ir - il) * c), gy = (h[ju * N + i] - h[jd * N + i]) / ((ju - jd) * c);
        out[j * N + i] = Math.atan(Math.hypot(gx, gy)) / D2R;
      }
      return out;
    }
    this._TL = { genDEM: genDEM, profile: profile, profAt: profAt, horizonMapAsync: horizonMapAsync, slopes: slopes, samp: samp, upsample: upsample };
    return this._TL;
  }

  hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  siteKey(site) { return site.lat.toFixed(4) + ',' + site.lon.toFixed(4) + ',' + site.name; }
  demFor(site) {
    if (!this._dems) this._dems = {};
    const k = this.siteKey(site);
    if (!this._dems[k]) { const d = window.RealMoon.localDEM(site); d.slope = this.terrLib().slopes(d); d.key = k; this._dems[k] = d; }
    return this._dems[k];
  }
  profileFor(site) { const d = this.demFor(site), h = this.state.obsH || 2; if (!d.profs) d.profs = {}; if (!d.profs[h]) d.profs[h] = this.terrLib().profile(d, h / 1000); return d.profs[h]; }
  // Grid position of the site pin: the patch centre, except in a roaming Drive window that has moved (ox, oy) km away from it.
  pinGrid(dem) { const c = (dem.N - 1) / 2, i = c - (dem.ox || 0) / dem.cell, j = c - (dem.oy || 0) / dem.cell; return { i: i, j: j, inside: i >= 0 && j >= 0 && i <= dem.N - 1 && j <= dem.N - 1 }; }
  selSite() { const s = this.state; return s.sites.find((x) => x.id === s.sel) || s.sites[0]; }

  // ---------- time series ----------
  series() {
    const s = this.state;
    const key = [s.start, s.end, s.stepH, s.model, s.obsH, s.sites.map((x) => x.id + ':' + x.lat + ':' + x.lon + ':' + x.name).join('|')].join('#');
    if (this._ser && this._ser.key === key) return this._ser;
    const E = this.eph(), TL = this.terrLib();
    const stepMs = s.stepH * 3600000;
    let n = Math.floor((s.end - s.start) / stepMs) + 1, trimmed = false;
    if (n > 2500) { n = 2500; trimmed = true; }
    if (n < 2) n = 2;
    const times = new Float64Array(n), st = new Array(n);
    for (let i = 0; i < n; i++) { times[i] = s.start + i * stepMs; st[i] = E.state(times[i]); }
    const sites = {};
    for (const site of s.sites) {
      const prof = s.model === 'G1' ? this.profileFor(site) : null;
      const o = { sAz: new Float32Array(n), sEl: new Float32Array(n), sH: new Float32Array(n), sF: new Float32Array(n), sRad: new Float32Array(n), sDist: new Float32Array(n),
        eAz: new Float32Array(n), eEl: new Float32Array(n), eH: new Float32Array(n), eF: new Float32Array(n), eRad: new Float32Array(n), eDist: new Float32Array(n) };
      for (let i = 0; i < n; i++) {
        const t = E.topo(st[i], site.lat, site.lon, (s.obsH || 2) / 1000);
        const hs = prof ? TL.profAt(prof, t.sun.az) : 0, he = prof ? TL.profAt(prof, t.earth.az) : 0;
        o.sAz[i] = t.sun.az; o.sEl[i] = t.sun.el; o.sH[i] = hs; o.sRad[i] = t.sun.rad; o.sDist[i] = t.sun.dist; o.sF[i] = this.diskFrac(t.sun.el - hs, t.sun.rad);
        o.eAz[i] = t.earth.az; o.eEl[i] = t.earth.el; o.eH[i] = he; o.eRad[i] = t.earth.rad; o.eDist[i] = t.earth.dist; o.eF[i] = this.diskFrac(t.earth.el - he, t.earth.rad);
      }
      sites[site.id] = o;
    }
    this._ser = { key: key, n: n, times: times, st: st, sites: sites, stepH: s.stepH, trimmed: trimmed };
    return this._ser;
  }
  metrics(ser) {
    const s = this.state;
    const key = ser.key + '|' + s.visDef + '|' + s.wSun + '|' + s.wEarth + '|' + s.wGap;
    if (this._met && this._met.key === key) return this._met;
    const thr = this.visThr(), n = ser.n, per = (n - 1) * ser.stepH, res = {};
    const runs = (arr) => {
      const out = []; let i0 = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && arr[i] >= thr;
        if (on && i0 < 0) i0 = i;
        if (!on && i0 >= 0) { const l = i0 / (n - 1) * 100; out.push({ l: l.toFixed(3), w: Math.max(0.15, Math.min(100 - l, (i - i0) / (n - 1) * 100)).toFixed(3) }); i0 = -1; }
      }
      return out;
    };
    const wsum = Math.max(1, s.wSun + s.wEarth + s.wGap);
    for (const site of s.sites) {
      const o = ser.sites[site.id];
      let cs = 0, ce = 0, cb = 0, rd = 0, md = 0, rn = 0, mn = 0;
      for (let i = 0; i < n; i++) {
        const sv = o.sF[i] >= thr, ev = o.eF[i] >= thr;
        if (sv) { cs++; rd = 0; } else { rd += ser.stepH; if (rd > md) md = rd; }
        if (ev) { ce++; rn = 0; } else { rn += ser.stepH; if (rn > mn) mn = rn; }
        if (sv && ev) cb++;
      }
      const sun = cs / n, ear = ce / n, both = cb / n;
      const score = (s.wSun * sun + s.wEarth * ear + s.wGap * (1 - Math.min(1, md / Math.max(per, 1)))) / wsum;
      const seg = []; for (let i = 0; i < n; i++) { const on = o.sF[i] >= 0.5; if (seg.length && seg[seg.length - 1].on === on) seg[seg.length - 1].len++; else seg.push({ on: on, len: 1 }); }
      const merge = (a) => { const out = []; a.forEach((x) => { if (out.length && out[out.length - 1].on === x.on) out[out.length - 1].len += x.len; else out.push({ on: x.on, len: x.len }); }); return out; };
      let q = merge(seg.map((x) => ({ on: x.on && x.len * ser.stepH >= 10, len: x.len })));
      q = merge(q.map((x) => ({ on: x.on || x.len * ser.stepH < 60, len: x.len })));
      let lq = 0; q.forEach((x) => { if (x.on) lq = Math.max(lq, x.len * ser.stepH); });
      res[site.id] = { sun: sun, ear: ear, both: both, dark: md, nocomm: mn, lqcip: lq, score: score, sunRuns: runs(o.sF), earRuns: runs(o.eF) };
    }
    const order = s.sites.map((x) => x.id).sort((a, b) => res[b].score - res[a].score);
    order.forEach((id, i) => { res[id].rank = i + 1; });
    this._met = { key: key, res: res, order: order, per: per };
    return this._met;
  }

  // ---------- terrain job & heat ----------
  ensureTerrain() {
    const s = this.state;
    if (s.view === 'region') return;
    const site = this.selSite(); if (!site) return;
    const obs = this.state.obsH || 2, key = this.siteKey(site) + '|h' + obs;
    if (this._tj && this._tj.key === key) return;
    if (this._tj) this._tj.cancel = true;
    const dem = this.demFor(site);
    if (!dem.hmaps) dem.hmaps = {};
    const job = { key: key, dem: dem, hmap: dem.hmaps[obs] || null, B: 48, stride: 2, Nc: (dem.N - 1) / 2 + 1, cancel: false };
    this._tj = job;
    if (dem.hmaps[obs]) { if (this.state.tready !== key) this.setState({ tready: key, tprog: 1 }); return; }
    this.terrLib().horizonMapAsync(dem, job.B, job.stride, job, (p) => { if (this._tj === job) this.setState({ tprog: p }); }, () => {
      dem.hmaps[obs] = job.hmap;
      if (this._tj === job) this.setState({ tready: key, tprog: 1 });
    }, obs / 1000);
    if (this.state.tprog !== 0) this.setState({ tprog: 0 });
  }
  terrReady() { const j = this._tj; return !!(j && j.hmap && this.state.view !== 'region'); }
  heatAcc() {
    const s = this.state, ser = this.series(), job = this._tj, site = this.selSite();
    const o = ser.sites[site.id]; if (!o) return null;
    const key = job.key + '|' + ser.key + '|' + s.visDef;
    if (this._hacc && this._hacc.key === key) return this._hacc;
    const Nv = job.Nc * job.Nc, B = job.B, hm = job.hmap, n = ser.n;
    const kq = s.visDef === 'any' ? -0.999 : (s.visDef === 'center' ? 0 : 0.999);
    const stride = Math.max(1, Math.ceil(n / 240));
    const sunA = new Float32Array(Nv), earA = new Float32Array(Nv), run = new Float32Array(Nv), mrun = new Float32Array(Nv);
    let cnt = 0;
    for (let k = 0; k < n; k += stride) {
      cnt++;
      const fs = o.sAz[k] / 360 * B, ks0 = Math.floor(fs) % B, ks1 = (ks0 + 1) % B, ws = fs - Math.floor(fs);
      const fe = o.eAz[k] / 360 * B, ke0 = Math.floor(fe) % B, ke1 = (ke0 + 1) % B, we = fe - Math.floor(fe);
      const sLim = o.sEl[k] - kq * o.sRad[k], eLim = o.eEl[k] - kq * o.eRad[k], dh = stride * ser.stepH;
      for (let v = 0; v < Nv; v++) {
        const b = v * B;
        if (sLim > hm[b + ks0] * (1 - ws) + hm[b + ks1] * ws) { sunA[v]++; run[v] = 0; } else { run[v] += dh; if (run[v] > mrun[v]) mrun[v] = run[v]; }
        if (eLim > hm[b + ke0] * (1 - we) + hm[b + ke1] * we) earA[v]++;
      }
    }
    for (let v = 0; v < Nv; v++) { sunA[v] /= cnt; earA[v] /= cnt; }
    this._hacc = { key: key, sun: sunA, earth: earA, mrun: mrun, per: Math.max(1, (n - 1) * ser.stepH) };
    return this._hacc;
  }
  heat() {
    if (!this.terrReady()) return null;
    const s = this.state, job = this._tj, dem = job.dem, TL = this.terrLib();
    const A = this.heatAcc(); if (!A) return null;
    const key = A.key + '|' + s.wSun + '|' + s.wEarth + '|' + s.wGap;
    if (this._heat && this._heat.key === key) return this._heat;
    const Nc = job.Nc, Ncv = Nc * Nc, wsum = Math.max(1, s.wSun + s.wEarth + s.wGap), raw = new Float32Array(Ncv);
    for (let v = 0; v < Ncv; v++) raw[v] = (s.wSun * A.sun[v] + s.wEarth * A.earth[v] + s.wGap * (1 - Math.min(1, A.mrun[v] / A.per))) / wsum;
    const N = dem.N, Nv = N * N;
    const sc = TL.upsample(raw, Nc, job.stride, N), sun = TL.upsample(A.sun, Nc, job.stride, N), ear = TL.upsample(A.earth, Nc, job.stride, N), slope = new Float32Array(Nv);
    let best = null; const c = (N - 1) / 2, pg = this.pinGrid(dem), pc = pg.inside ? pg : { i: c, j: c };
    for (let v = 0; v < Nv; v++) {
      const sl = dem.slope[v];
      slope[v] = sl > 15 ? -1 : sl / 15;
      if (sl > 15) sc[v] = -1; else if (sl > 5) sc[v] *= 1 - 0.6 * (sl - 5) / 10;
      const i = v % N, j = (v - i) / N, dk = Math.hypot(i - pc.i, j - pc.j) * dem.cell;
      if (dk <= 2.5 && sl <= 8 && sc[v] >= 0 && (!best || sc[v] > best.score)) best = { i: i, j: j, score: sc[v], dist: dk, slope: sl };
    }
    const site0 = this.selSite(), hm = job.hmap, B = job.B, psrC = new Float32Array(Ncv);
    for (let cj = 0; cj < Nc; cj++) for (let ci = 0; ci < Nc; ci++) {
      const vv = cj * Nc + ci; let mn = 1e9;
      for (let k = 0; k < B; k++) { const hv = hm[vv * B + k]; if (hv < mn) mn = hv; }
      const lat = site0.lat + (cj * job.stride - c) * dem.cell / 1737.4 * 57.29578;
      psrC[vv] = mn > 90 - Math.abs(lat) + 1.543 + 0.267 ? 1 : 0;
    }
    const psrF = TL.upsample(psrC, Nc, job.stride, N), psr = new Uint8Array(Nv); let psrN = 0;
    for (let v = 0; v < Nv; v++) if (psrF[v] >= 0.5) { psr[v] = 1; psrN++; }
    this._heat = { key: key, score: sc, sun: sun, earth: ear, slope: slope, best: best, psr: psr, psrKm2: psrN * dem.cell * dem.cell };
    return this._heat;
  }

  sync() {
    const e = this.eng; if (!e) return;
    const s = this.state, ser = this.series(), ti = Math.min(s.ti, ser.n - 1), st = ser.st[ti], site = this.selSite();
    e.set({ sunB: st.sun, earthB: st.earth, sites: s.sites, sel: s.sel, pick: s.pick, turbo: s.turbo, drain: s.drain !== false, target: s.target && this._tj && s.target.key === this._tj.key ? { i: s.target.i, j: s.target.j } : null });
    const o = site ? ser.sites[site.id] : null;
    if (o) e.set({ tSun: { az: o.sAz[ti], el: o.sEl[ti], rad: o.sRad[ti] }, tEarth: { az: o.eAz[ti], el: o.eEl[ti], rad: o.eRad[ti] }, siteName: site.name, siteColor: site.color });
    e.setView(s.view);
    if (s.view !== 'region' && this._tj && site) {
      const job = this._tj;
      if (e.terrainKey() !== job.key) { e.setTerrain(job.dem, job.key); this._shadeKey = ''; this._heatKey = ''; this._hzKey = ''; }
      if (job.hmap && this._hzKey !== job.key) { e.setHorizon(job.hmap, job.Nc, job.B, job.stride); this._hzKey = job.key; }
      if (o && job.hmap && !job.scienceShade) {
        const k = ser.key + '|' + ti + '|' + job.key;
        if (this._shadeKey !== k) {
          const Ncv = job.Nc * job.Nc, B = job.B, hm = job.hmap, arr = new Float32Array(Ncv);
          const f = o.sAz[ti] / 360 * B, k0 = Math.floor(f) % B, k1 = (k0 + 1) % B, w = f - Math.floor(f), el = o.sEl[ti], r = o.sRad[ti];
          for (let v = 0; v < Ncv; v++) arr[v] = this.diskFrac(el - (hm[v * B + k0] * (1 - w) + hm[v * B + k1] * w), r);
          this._shadeFull = this.terrLib().upsample(arr, job.Nc, job.stride, job.dem.N); e.setShade(this._shadeFull); this._shadeKey = k;
        }
      }
      const H = this.heat();
      const hk = (H ? H.key : 'none') + '|' + s.layer;
      if (this._heatKey !== hk) {
        this._heatKey = hk;
        let ha = null;
        if (H && s.layer !== 'off') { ha = Float32Array.from(H[s.layer]); for (let v = 0; v < ha.length; v++) if (H.psr[v]) ha[v] = -2; }
        e.setHeat(ha);
        e.set({ best: H && H.best ? { i: H.best.i, j: H.best.j, score: H.best.score } : null });
      }
    }
  }

  // ---------- actions ----------
  reachGrid(dem, oi, oj) {
    const N = dem.N, sl = dem.slope, h = dem.h, cell = dem.cell, NN = N * N;
    const v = new Float32Array(NN); for (let k = 0; k < NN; k++) v[k] = sl[k] > 20 ? 0 : 0.7 * (1 - 0.7 * sl[k] / 20);
    const T = new Float32Array(NN).fill(Infinity), prev = new Int32Array(NN).fill(-1);
    const hk = [], hv = [];
    const push = (k, t) => { let i = hk.length; hk.push(k); hv.push(t); while (i > 0) { const p = (i - 1) >> 1; if (hv[p] <= t) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = t; };
    const pop = () => { const k0 = hk[0], last = hk.length - 1, lk = hk[last], lv = hv[last]; hk.pop(); hv.pop(); if (last > 0) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= last) break; if (c + 1 < last && hv[c + 1] < hv[c]) c++; if (hv[c] >= lv) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = lk; hv[i] = lv; } return k0; };
    const s0 = oj * N + oi; T[s0] = 0; push(s0, 0); if (!v[s0]) v[s0] = 0.2;
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
    while (hk.length) {
      const t0 = hv[0], k = pop(); if (t0 > T[k]) continue; if (t0 > 24) break;
      const i = k % N, j = (k - i) / N;
      for (let m = 0; m < 8; m++) {
        const ii = i + DI[m], jj = j + DJ[m]; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const kk = jj * N + ii; if (!v[kk]) continue;
        const dxy = cell * (m < 4 ? 1 : 1.41421356), dz = h[kk] - h[k], dist = Math.sqrt(dxy * dxy + dz * dz);
        const nt = t0 + dist * 2 / (v[k] + v[kk]);
        if (nt < T[kk]) { T[kk] = nt; prev[kk] = k; push(kk, nt); }
      }
    }
    return { T: T, prev: prev };
  }
  reachOrigin() {
    const s = this.state, jb = this._tj; if (!jb) return null;
    const d = jb.dem, N = d.N, cl = (x) => Math.max(0, Math.min(N - 1, Math.round(x)));
    if (s.view === 'drive' && s.rover && s.rover.x !== undefined) return { i: cl((s.rover.x + d.L / 2) / d.cell), j: cl((-s.rover.z + d.L / 2) / d.cell), from: 'rover' };
    if (this._landAt && this._landAt.key === jb.key) return { i: this._landAt.i, j: this._landAt.j, from: 'landing' };
    const H = this.terrReady() ? this.heat() : null;
    if (H && H.best) return { i: H.best.i, j: H.best.j, from: 'best' };
    return { i: (N - 1) / 2, j: (N - 1) / 2, from: 'pin' };
  }
  reach() {
    const jb = this._tj, o = this.reachOrigin(); if (!jb || !o) return null;
    const k = jb.dem.key + '|' + o.i + ',' + o.j;
    if (!this._reach || this._reach.k !== k) { const r = this.reachGrid(jb.dem, o.i, o.j); this._reach = { k: k, T: r.T, prev: r.prev, o: o, img: null }; }
    this._reach.o = o; return this._reach;
  }
  fmtH(hh) { if (!isFinite(hh)) return '—'; const m = Math.round(hh * 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }
  doLand() {
    { const s0 = this.state, jb = this._tj, H0 = this.terrReady() ? this.heat() : null; if (jb) { if (s0.target && s0.target.key === jb.key) this._landAt = { i: s0.target.i, j: s0.target.j, key: jb.key }; else if (H0 && H0.best) this._landAt = { i: H0.best.i, j: H0.best.j, key: jb.key }; } }
    const run = () => { const lt = this._landTi || 0; if (this.eng && this.terrReady() && !this.state.landing && this.eng.land()) { this._tf = lt; this.setState({ landing: true, landed: false, ti: lt, playing: false }); return true; } return false; };
    if (this.state.view !== 'terrain') this.goView('terrain');
    let k = 0; const tick = () => { if (run() || ++k > 60) return; setTimeout(tick, 150); }; setTimeout(tick, 120);
  }
  addTargetPlace() {
    const s = this.state, jb = this._tj, site = this.selSite();
    if (!jb || !s.target || s.target.key !== jb.key || !site) return;
    if (s.sites.length >= 6) { this.setState({ addErr: 'You can compare up to 6 places.' }); return; }
    const d = jb.dem, c = (d.N - 1) / 2, dx = (s.target.i - c) * d.cell, dy = (s.target.j - c) * d.cell;
    const R = 1737.4, Dg = Math.PI / 180, la0 = site.lat * Dg, lo0 = site.lon * Dg;
    const rho0 = R * (Math.PI / 2 + la0), nU = [Math.cos(lo0), Math.sin(lo0)], eU = [-Math.sin(lo0), Math.cos(lo0)];
    const Px = rho0 * nU[0] + dx * eU[0] + dy * nU[0], Py = rho0 * nU[1] + dx * eU[1] + dy * nU[1];
    const lat = Math.hypot(Px, Py) / R / Dg - 90, lon = Math.atan2(Py, Px) / Dg;
    const dist = Math.round(Math.hypot(dx, dy) * 1000), az = (Math.atan2(dx, dy) / Dg + 360) % 360;
    const nm = dist < 60 ? site.name + ' (spot)' : (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km ' : dist + ' m ') + this.compass(az) + ' of ' + site.name;
    const used = s.sites.map((x) => x.color), color = this.palette().find((cc) => used.indexOf(cc) < 0) || '#98989F';
    const id = 's' + (this._nextId++);
    const base = site.demOf || { seed: d.seed, ox: 0, oy: 0 };
    const ns = { id: id, key: '', name: nm, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000, approx: false, color: color, demOf: { seed: base.seed, ox: base.ox + dx, oy: base.oy + dy } };
    this.setState({ sites: s.sites.concat([ns]), sel: id, target: null, bigMap: false, mapPick: false, landed: false, addErr: '' });
  }
  selectSite(id) {
    this.setState({ sel: id, sitesOpen: false, csvUrl: '' });
    const site = this.state.sites.find((x) => x.id === id);
    if (this.eng && site && this.state.view === 'region') this.eng.flyTo(site.lat, site.lon, false, null);
  }
  // `ready` (optional promise): terrain data still loading. The fly-in starts at once and the
  // globe holds the final pose until the data is there, so the hand-over never shows a black frame.
  goView(v, ready) {
    const s = this.state; if (v === s.view) return;
    this.setState({ sheet: null, sitesOpen: false, pick: false, landing: false, landed: false });
    if (s.view === 'region' && this.eng) {
      if (this._flyView === v && performance.now() - this._flyAt < 2500) return; // double-click on a pin
      this._flyView = v; this._flyAt = performance.now();
      const site = this.selSite(), token = (this._flyToken = (this._flyToken || 0) + 1);
      const warm = Promise.resolve(ready).then(() => { try { const st = this.selSite(); if (st) this.demFor(st); } catch (e) { } });
      this.eng.flyTo(site.lat, site.lon, true, () => warm.then(() => { if (this._flyToken === token && this.state.view === 'region') this.setState({ view: v }); }, () => { if (this._flyToken === token && this.eng && this.state.view === 'region') this.eng.flyTo(site.lat, site.lon, false, null); }));
    }
    else this.setState({ view: v });
  }
  setRange(start, end) {
    if (end <= start) end = start + 86400000;
    if (end - start > 730 * 86400000) end = start + 730 * 86400000;
    const days = (end - start) / 86400000;
    const stepH = days <= 45 ? 1 : (days <= 120 ? 2 : (days <= 400 ? 6 : 12));
    this._tf = 0;
    this.setState({ start: start, end: end, stepH: stepH, ti: 0 });
  }
  addSiteAt(lat, lon, name) {
    const s = this.state;
    if (s.sites.length >= 6) { this.setState({ addErr: 'You can compare up to 6 places.' }); return; }
    if (!(lat >= -90 && lat <= 90)) { this.setState({ addErr: 'Latitude must be between −90 and 90.' }); return; }
    if (!(lon >= -180 && lon <= 360)) { this.setState({ addErr: 'Longitude must be between −180 and 360.' }); return; }
    if (lon > 180) lon -= 360;
    const used = s.sites.map((x) => x.color), color = this.palette().find((c) => used.indexOf(c) < 0) || '#98989F';
    const id = 's' + (this._nextId++);
    const site = { id: id, key: '', name: (name || '').trim() || ('My place ' + id.slice(1)), lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000, approx: false, color: color };
    this.setState({ sites: s.sites.concat([site]), sel: id, addErr: '', addLat: '', addLon: '', pick: false });
    if (this.eng && s.view === 'region') this.eng.flyTo(site.lat, site.lon, false, null);
  }
  timelineModel(ser, o, fbTicks) {
    const n = ser.n, key = n + '|' + ser.times[0] + '|' + ser.times[n - 1];
    if (o._tl && o._tl.key === key) return o._tl.v;
    const d3 = window.d3, W = 1000, Hh = 24, M = Math.min(n, 400), t0 = ser.times[0], t1 = ser.times[n - 1];
    const pick = (f, el, h, rad) => {
      const v = new Float32Array(M); let mx = 0;
      for (let k = 0; k < M; k++) {
        const a = Math.floor(k * n / M), b = Math.max(a + 1, Math.floor((k + 1) * n / M)); let best = 0;
        for (let i = a; i < b && i < n; i++) { if (f[i] <= 0.0005) continue; const up = el[i] - (h ? h[i] : 0); const y = Math.max(0, up + rad[i]) * Math.min(1, f[i] * 1.0001); if (y > best) best = y; }
        v[k] = best; if (best > mx) mx = best;
      }
      return { v: v, mx: mx };
    };
    const S = pick(o.sF, o.sEl, o.sH, o.sRad), E = pick(o.eF, o.eEl, o.eH, o.eRad);
    const X = (k) => (M <= 1 ? 0 : k / (M - 1) * W);
    const mk = (P) => {
      const top = Math.max(0.5, P.mx), Y = (y) => Hh - (y / top) * (Hh - 2);
      if (d3 && d3.area) {
        const ar = d3.area().x((d, k) => X(k)).y0(Hh).y1((d) => Y(d)).defined((d, k) => true).curve(d3.curveMonotoneX);
        const ln = d3.line().x((d, k) => X(k)).y((d) => Y(d)).defined((d) => d > 0).curve(d3.curveMonotoneX);
        const arr = Array.from(P.v);
        return { area: ar(arr) || '', line: ln(arr) || '' };
      }
      let a = 'M0 ' + Hh, l = '';
      for (let k = 0; k < M; k++) { a += 'L' + X(k).toFixed(1) + ' ' + Y(P.v[k]).toFixed(2); }
      a += 'L' + W + ' ' + Hh + 'Z';
      return { area: a, line: l };
    };
    const sp = mk(S), ep = mk(E);
    let ticks = [], labels = [], major = '', minor = '';
    const xp = (t) => (t1 > t0 ? (t - t0) / (t1 - t0) : 0);
    if (d3 && d3.scaleUtc) {
      const sc = d3.scaleUtc().domain([new Date(t0), new Date(t1)]).range([0, 1]);
      const days = (t1 - t0) / 86400000;
      const minI = days <= 3 ? d3.utcHour.every(6) : (days <= 45 ? d3.utcDay : (days <= 180 ? d3.utcWeek : d3.utcMonth));
      const maj = sc.ticks(6), mnr = sc.ticks(minI);
      const majSet = new Set(maj.map((d) => +d));
      const fmt = days <= 3 ? d3.utcFormat('%-d %b %H:%M') : d3.utcFormat('%-d %b');
      mnr.forEach((d) => { const x = sc(d); if (majSet.has(+d)) return; minor += 'M' + (x * W).toFixed(1) + ' 0V' + Hh; ticks.push({ l: (x * 100).toFixed(3), cls: 'tk' }); });
      maj.forEach((d) => { const x = sc(d); major += 'M' + (x * W).toFixed(1) + ' 0V' + Hh; ticks.push({ l: (x * 100).toFixed(3), cls: 'tk mj' }); labels.push({ l: (x * 100).toFixed(3), label: fmt(d) }); });
    } else {
      labels = fbTicks; fbTicks.forEach((t) => { major += 'M' + (parseFloat(t.l) * 10).toFixed(1) + ' 0V' + Hh; ticks.push({ l: t.l, cls: 'tk mj' }); });
    }
    const fine = [];
    if (d3 && d3.scaleUtc) {
      const sc2 = d3.scaleUtc().domain([new Date(t0), new Date(t1)]).range([0, 100]); const dd = (t1 - t0) / 86400000;
      const fI = dd <= 3 ? d3.utcHour : (dd <= 20 ? d3.utcHour.every(6) : (dd <= 60 ? d3.utcHour.every(12) : d3.utcDay));
      const dayT = new Set((dd <= 60 ? sc2.ticks(d3.utcDay) : sc2.ticks(d3.utcWeek)).map((d) => +d));
      const majT = new Set(labels.length ? sc2.ticks(6).map((d) => +d) : []);
      sc2.ticks(fI).slice(0, 400).forEach((d) => fine.push({ l: sc2(d).toFixed(3), cls: majT.has(+d) ? 'wt mj' : (dayT.has(+d) ? 'wt md' : 'wt') }));
    } else { for (let k = 0; k <= 60; k++) fine.push({ l: (k / 60 * 100).toFixed(3), cls: k % 10 ? 'wt' : 'wt mj' }); }
    const v = {
      fine: fine,
      sunArea: sp.area, sunLine: sp.line, earArea: ep.area, earLine: ep.line, major: major, minor: minor, ticks: ticks, labels: labels,
      sunMax: S.mx > 0 ? 'max ' + S.mx.toFixed(1) + '°' : 'below horizon', earMax: E.mx > 0 ? 'max ' + E.mx.toFixed(1) + '°' : 'below horizon',
      sunTitle: 'Height of the Sun above the local horizon; brighter = higher, empty = Sun not visible.',
      earTitle: 'Height of the Earth above the local horizon; brighter = higher, empty = Earth not visible.'
    };
    o._tl = { key: key, v: v };
    return v;
  }
  removeSite(id) {
    const s = this.state;
    if (s.sites.length <= 1) return;
    const sites = s.sites.filter((x) => x.id !== id);
    this.setState({ sites: sites, sel: s.sel === id ? sites[0].id : s.sel });
  }
  csv() {
    const s=this.state,{rows,sum,ser,met}=buildCSV(this,site=>this.terrainResolution(site));
    if (s.csvUrl) { try { URL.revokeObjectURL(s.csvUrl); URL.revokeObjectURL(s.csvSumUrl); } catch (err) { } }
    const d0 = new Date(ser.times[0]).toISOString().slice(0, 10);
    this.setState({
      csvUrl: URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })), csvName: 'lunar-sites-timeseries-' + d0 + '.csv',
      csvSumUrl: URL.createObjectURL(new Blob([sum.join('\n')], { type: 'text/csv' })), csvSumName: 'lunar-sites-summary-' + d0 + '.csv',
      csvKey: met.key + '|' + s.model
    });
  }

  // ---------- formatting ----------
  fmtLat(v) { return Math.abs(v).toFixed(3) + '°' + (v < 0 ? 'S' : 'N'); }
  fmtLon(v) { return Math.abs(v).toFixed(3) + '°' + (v < 0 ? 'W' : 'E'); }
  fmtCoords(site) { return (site.approx ? '≈ ' : '') + this.fmtLat(site.lat) + ' · ' + this.fmtLon(site.lon); }
  fmtDur(h) { if (h <= 0) return '0 h'; if (h < 72) return Math.round(h) + ' h'; return (h / 24).toFixed(1) + ' d'; }
  pct(x) { return Math.round(x * 100) + '%'; }
  compass(az) { const d = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; return d[Math.round(((az % 360) + 360) % 360 / 45) % 8]; }
  fmtTime(ms) {
    const d = new Date(ms), D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = (x) => (x < 10 ? '0' : '') + x;
    return D[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' · ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }
  hzUrl(cmd, site, ms) {
    const iso = (x) => new Date(x).toISOString().slice(0, 16).replace('T', ' ');
    const lonE = ((site.lon % 360) + 360) % 360;
    const q = { format: 'text', COMMAND: "'" + cmd + "'", OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'", CENTER: "'coord@301'", COORD_TYPE: "'GEODETIC'",
      SITE_COORD: "'" + lonE.toFixed(7) + ',' + site.lat.toFixed(7) + ',' + ((this.demFor(site).centerHeightM + (this.state.obsH || 2))/1000).toFixed(6) + "'", START_TIME: "'" + iso(ms) + "'", STOP_TIME: "'" + iso(ms + 3600000) + "'", STEP_SIZE: "'1h'", QUANTITIES: "'4'", ANG_FORMAT: "'DEG'", APPARENT:"'AIRLESS'", EXTRA_PREC:"'YES'" };
    return 'https://ssd.jpl.nasa.gov/api/horizons.api?' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
  }

  // ---------- render ----------
  nextChange(arr, ti, thr, n, stepH) {
    const on = arr[ti] >= thr;
    for (let i = ti + 1; i < n; i++) if ((arr[i] >= thr) !== on) return (i - ti) * stepH;
    return null;
  }
  // Top-down map field of view: zoom 0 = whole patch, 1 = half, 2 = quarter; centred on the rover (Drive) or the pin, clamped to the patch.
  regionJob() { return null; } // Overview map source (set by the science layer once the place's terrain is loaded)
  mapWindow(job = this._tj) {
    const dem = job.dem, N = dem.N, z = this.state.view === 'region' ? 0 : Math.max(0, Math.min(2, this.state.mapZoom | 0)), f = 1 / (1 << z), sp = (N - 1) * f;
    let ci = (N - 1) / 2, cj = ci; const s = this.state;
    if (z) {
      if (s.view === 'drive' && s.rover && s.rover.x !== undefined) { ci = (s.rover.x + dem.L / 2) / dem.cell; cj = (-s.rover.z + dem.L / 2) / dem.cell; }
      else { const pg = this.pinGrid(dem); ci = pg.i; cj = pg.j; }
      if (!isFinite(ci) || !isFinite(cj)) ci = cj = (N - 1) / 2;
    }
    const cl = (v) => Math.max(0, Math.min(N - 1 - sp, v - sp / 2));
    return { f: f, sp: sp, i0: cl(ci), j0: cl(cj) };
  }
  mapGridAt(ev) {
    const r = ev.currentTarget.getBoundingClientRect(), mw = this.mapWindow();
    return { i: mw.i0 + (ev.clientX - r.left) / r.width * mw.sp, j: mw.j0 + (1 - (ev.clientY - r.top) / r.height) * mw.sp };
  }
  drawMaps() {
    const els = [this._miniEl, this._bigEl].filter(Boolean), region = this.state.view === 'region';
    const job = region ? this.regionJob() : this._tj;
    if (!els.length || !job) return;
    const dem = job.dem, N = dem.N, H = this.terrReady() ? this.heat() : null;
    if (!dem.hs) {
      const hs = new Float32Array(N * N), c = dem.cell, L = [-0.5, 0.5, 0.707];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jd = Math.max(0, j - 1), ju = Math.min(N - 1, j + 1);
        const gx = (dem.h[j * N + ir] - dem.h[j * N + il]) / ((ir - il) * c) * 2.5, gy = (dem.h[ju * N + i] - dem.h[jd * N + i]) / ((ju - jd) * c) * 2.5;
        const l = Math.hypot(gx, gy, 1); hs[j * N + i] = Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) / l);
      }
      dem.hs = hs;
    }
    const mapStep = els.some(el => el.clientWidth > 300) ? 1 : 2, mapN = Math.ceil((N - 1) / mapStep) + 1;
    const key = job.key + '|' + (this._shadeKey || '') + '|' + (H ? H.key : '') + '|' + mapStep;
    if (!this._mapOff) this._mapOff = document.createElement('canvas');
    const off = this._mapOff;
    if (job.mapPixels && this._mapKey !== key) { const m=job.mapPixels;off.width=m.M;off.height=m.M;off.getContext('2d').putImageData(new ImageData(m.data,m.M,m.M),0,0);this._mapKey=key; }
    else if (this._mapKey !== key) {
      this._mapKey = key; off.width = mapN; off.height = mapN;
      const g = off.getContext('2d'), img = g.createImageData(mapN, mapN), d = img.data, sh = region ? null : this._shadeFull;
      for (let y = 0; y < mapN; y++) for (let x = 0; x < mapN; x++) {
        const v = Math.min(N - 1, y * mapStep) * N + Math.min(N - 1, x * mapStep), p = ((mapN - 1 - y) * mapN + x) * 4, base = 0.25 + 0.75 * dem.hs[v];
        let r, gg, b;
        if (H && H.psr[v]) { r = 40 + 50 * base; gg = 105 + 70 * base; b = 220 + 35 * base; }
        else {
          const lit = sh ? sh[v] : 1, Lm = 26 + 205 * base * (0.18 + 0.82 * lit);
          r = Lm; gg = Lm; b = Lm + 5;
          if (dem.slope[v] > 20) { r = r * 0.45 + 201 * 0.55; gg = gg * 0.45 + 87 * 0.55; b = b * 0.45 + 75 * 0.55; }
        }
        d[p] = r; d[p + 1] = gg; d[p + 2] = b; d[p + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    const s = this.state, site = this.selSite(), dpr = Math.min(2, window.devicePixelRatio || 1);
    els.forEach((el) => {
      const W = el.clientWidth || 216, px = Math.round(W * dpr);
      if (el.width !== px) { el.width = px; el.height = px; }
      const ctx = el.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = true;
      const mw = this.mapWindow(job), crop = (im) => { const k = im.width / (N - 1); ctx.drawImage(im, mw.i0 * k, (N - 1 - mw.j0 - mw.sp) * k, mw.sp * k, mw.sp * k, 0, 0, W, W); };
      ctx.clearRect(0, 0, W, W); crop(off);
      const X = (i) => (i - mw.i0) / mw.sp * W, Y = (j) => (1 - (j - mw.j0) / mw.sp) * W, c = (N - 1) / 2;
      const ring = (i, j, col, r, fill) => { ctx.beginPath(); ctx.arc(X(i), Y(j), r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); } else { ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke(); } };
      if (H && H.best) ring(H.best.i, H.best.j, '#FFFFFF', W > 300 ? 9 : 6, false);
      if (s.target && s.target.key === job.key) ring(s.target.i, s.target.j, '#FF9F0A', W > 300 ? 9 : 6, false);
      { const pg = this.pinGrid(dem); ring(pg.i, pg.j, site.color, W > 300 ? 6 : 4.5, true); }
      if (s.view === 'drive' && s.rover && s.rover.x !== undefined) {
        const i = (s.rover.x + dem.L / 2) / dem.cell, j = (-s.rover.z + dem.L / 2) / dem.cell, hx = Math.sin(s.rover.heading), hy = -Math.cos(s.rover.heading), k = W > 300 ? 11 : 8;
        const x0 = X(i), y0 = Y(j);
        ctx.beginPath(); ctx.moveTo(x0 + hx * k, y0 + hy * k); ctx.lineTo(x0 - hx * k * 0.6 + hy * k * 0.55, y0 - hy * k * 0.6 - hx * k * 0.55); ctx.lineTo(x0 - hx * k * 0.6 - hy * k * 0.55, y0 - hy * k * 0.6 + hx * k * 0.55); ctx.closePath();
        ctx.fillStyle = '#BF5AF2'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (s.mapReach && s.view === 'drive' && this._tj) {
        const rc = this.reach();
        if (rc) {
          if(!rc.img){const cv=document.createElement('canvas'),K=31;cv.width=cv.height=K;const g=cv.getContext('2d'),im=g.createImageData(K,K),bands=[[1,92,148,112],[3,242,201,76],[6,227,147,107],[Infinity,217,83,79]];for(let y=0;y<K;y++)for(let x=0;x<K;x++){const t=rc.T[Math.round(y*(N-1)/(K-1))*N+Math.round(x*(N-1)/(K-1))];if(!Number.isFinite(t))continue;const col=bands.find(b=>t<=b[0]),p=((K-1-y)*K+x)*4;im.data.set([col[1],col[2],col[3],125],p);}g.putImageData(im,0,0);rc.img=cv;}

          if(this._rangeImage!==rc.img){const now=performance.now(),f=Math.min(1,(now-this._rangeFadeAt)/400);if(this._rangeImage&&this._rangePrevious&&f<1){const cv=document.createElement('canvas');cv.width=cv.height=31;const g=cv.getContext('2d');g.globalAlpha=1-f;g.drawImage(this._rangePrevious,0,0);g.globalAlpha=f;g.drawImage(this._rangeImage,0,0);this._rangePrevious=cv;}else this._rangePrevious=this._rangeImage;this._rangeImage=rc.img;this._rangeFadeAt=now;}
          const fade=Math.min(1,(performance.now()-this._rangeFadeAt)/400);
          if(this._rangePrevious&&fade<1){ctx.globalAlpha=1-fade;crop(this._rangePrevious);}
          ctx.globalAlpha=fade;crop(rc.img);ctx.globalAlpha=1;
          if(fade<1&&!this._rangeFadeRAF)this._rangeFadeRAF=requestAnimationFrame(()=>{this._rangeFadeRAF=0;this.drawMaps();});
          if (s.target && s.target.key === job.key && !s.navigationActive) { const target=s.target.j*N+s.target.i; if(rc.routePointsFor&&isFinite(rc.T[target])){const points=rc.routePointsFor(target);for(let a=1;a<points.length;a++){const p=points[a-1],q=points[a];ctx.beginPath();ctx.moveTo(X(p.i),Y(p.j));ctx.lineTo(X(q.i),Y(q.j));ctx.strokeStyle=p.earth>.0005?'#30D158':'#FF9F0A';ctx.lineWidth=W>300?3:2;ctx.stroke();}}else if(isFinite(rc.T[target])){let p=target;ctx.beginPath();let first=true;while(p>=0){const a=p%N,b=(p-a)/N;if(first){ctx.moveTo(X(a),Y(b));first=false;}else ctx.lineTo(X(a),Y(b));p=rc.prev[p];}ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();} }
          const ox = X(rc.o.i), oy = Y(rc.o.j); ctx.beginPath(); ctx.arc(ox, oy, W > 300 ? 6 : 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
      const nav=region?null:this.navigationMapPoints?.();if(nav?.length){ctx.beginPath();nav.forEach((p,i)=>{if(i)ctx.lineTo(X(p.i),Y(p.j));else ctx.moveTo(X(p.i),Y(p.j));});ctx.strokeStyle='#071822';ctx.lineWidth=W>300?5:4;ctx.stroke();ctx.strokeStyle='#40A8FF';ctx.lineWidth=W>300?3:2;ctx.stroke();}
      for(const [rank,p]of ((!region&&s.bestSpots)||[]).entries()){const x=X(p.i*(N-1)/30),y=Y(p.j*(N-1)/30);ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fillStyle='#F2C94C';ctx.fill();ctx.fillStyle='#111';ctx.font='bold 11px Inter';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(rank+1),x,y);}
      const fs = W > 300 ? 13 : 11;
      ctx.font = '700 ' + fs + 'px -apple-system, Inter, sans-serif'; ctx.fillStyle = '#FF6961'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      if (dem.northTurn) { const a = dem.northTurn * Math.PI / 180, cx = W - 22, cy = 25; ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.strokeStyle = '#FF6961'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -1); ctx.stroke(); ctx.fillText('N', 0, -13); ctx.restore(); } // roaming window: true north is turned from the grid's up
      else ctx.fillText('N', W - 14, 6);
      const spanKm = dem.L * mw.f, barKm = spanKm > 10 ? 2 : (spanKm > 5 ? 1 : 0.5), kmPx = W / spanKm * barKm, bx = 10, by = W - 10;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + kmPx, by); ctx.lineTo(bx + kmPx, by - 4); ctx.stroke();
      ctx.font = '600 ' + (fs - 1) + 'px -apple-system, Inter, sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText((barKm < 1 ? barKm * 1000 + ' m' : barKm + ' km'), bx, by - 6);
    });
  }
  runsOf(test, n) {
    const out = []; let i0 = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && test(i);
      if (on && i0 < 0) i0 = i;
      if (!on && i0 >= 0) { const l = i0 / (n - 1) * 100; out.push({ l: l.toFixed(3), w: Math.max(0.15, Math.min(100 - l, (i - i0) / (n - 1) * 100)).toFixed(3), i0: i0, i1: i }); i0 = -1; }
    }
    return out;
  }
  autoLand(o, thr, n) {
    const r = this.runsOf((i) => o.sF[i] >= thr && o.eF[i] >= thr, n);
    let best = null; r.forEach((x) => { if (!best || x.i1 - x.i0 > best.i1 - best.i0) best = x; });
    return best ? best.i0 : 0;
  }
  dur(h) { if (h < 1) return 'under an hour'; if (h < 48) return Math.round(h) + ' h'; return (h / 24).toFixed(1) + ' days'; }

  renderVals() {
    const s = this.state, R = this.refs();
    const ser = this.series(), met = this.metrics(ser);
    const n = ser.n, ti = Math.min(s.ti, n - 1);
    const site = this.selSite();
    const v = s.view, isRegion = v === 'region', isTerrain = v === 'terrain', isDrive = v === 'drive';
    const thr = this.visThr();
    const set = (o) => () => this.setState(o);
    const ready = this.terrReady();
    const days = (ser.times[n - 1] - ser.times[0]) / 86400000;
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const pad2 = (x) => (x < 10 ? '0' : '') + x;

    // current state at the selected place
    const o = ser.sites[site.id], m = met.res[site.id];
    const sEl = o.sEl[ti], sAz = o.sAz[ti], sF = o.sF[ti], eEl = o.eEl[ti], eAz = o.eAz[ti], eF = o.eF[ti];
    const sunOn = sF >= thr, earOn = eF >= thr;
    const sNext = this.nextChange(o.sF, ti, thr, n, ser.stepH), eNext = this.nextChange(o.eF, ti, thr, n, ser.stepH);
    const hz = s.model === 'G1' ? 'skyline' : 'horizon';
    const sunSub = (sunOn ? Math.max(0, sEl).toFixed(1) + '° up' : Math.abs(sEl).toFixed(1) + '° down') + ' · ' +
      (sNext === null ? (sunOn ? 'up all period' : 'no sunrise in period') : (sunOn ? 'sets in ' : 'rises in ') + this.dur(sNext));
    const earSub = (earOn ? Math.max(0, eEl).toFixed(1) + '° up' : Math.abs(eEl).toFixed(1) + '° down') + ' · ' +
      (eNext === null ? (earOn ? 'up all period' : 'no Earthrise in period') : (earOn ? 'sets in ' : 'rises in ') + this.dur(eNext));

    // sites popover
    const siteRows = s.sites.map((x) => ({ name: x.name, color: x.color, coords: this.fmtCoords(x), cls: 'prow' + (x.id === s.sel ? ' on' : ''),
      select: () => this.selectSite(x.id), remove: () => this.removeSite(x.id), removeLabel: 'Remove ' + x.name }));
    const have = s.sites.map((x) => x.key);
    const presetChips = this.presets().filter((p) => have.indexOf(p.key) < 0).map((p) => ({
      name: (p.approx ? '≈ ' : '') + p.name, disabled: s.sites.length >= 6,
      add: () => {
        if (this.state.sites.length >= 6) return;
        const used = this.state.sites.map((x) => x.color), color = this.palette().find((c) => used.indexOf(c) < 0) || '#98989F';
        const id = 's' + (this._nextId++);
        this.setState({ sites: this.state.sites.concat([{ id: id, key: p.key, name: p.name, lat: p.lat, lon: p.lon, approx: p.approx, color: color }]), sel: id });
        if (this.eng && this.state.view === 'region') this.eng.flyTo(p.lat, p.lon, false, null);
      }
    }));

    // ranking
    const ranked = met.order.map((id) => s.sites.find((x) => x.id === id)).filter(Boolean);
    let bestSun = 0, bestEar = 0;
    s.sites.forEach((x) => { bestSun = Math.max(bestSun, met.res[x.id].sun); bestEar = Math.max(bestEar, met.res[x.id].ear); });
    const rankRows = ranked.map((x, i) => {
      const r = met.res[x.id], vv = [];
      if (i === 0) vv.push('Best overall');
      if (r.sun === bestSun && i !== 0) vv.push('Most sunlight');
      if (r.ear === bestEar && i !== 0) vv.push('Best Earth contact');
      if (r.dark >= 48) vv.push('Dark for up to ' + this.dur(r.dark));
      return { rank: i + 1, name: x.name, color: x.color, cls: 'rbtn' + (x.id === s.sel ? ' on' : ''), selected: x.id === s.sel,
        sunPct: Math.round(r.sun * 100), earPct: Math.round(r.ear * 100), sunTxt: this.pct(r.sun), earTxt: this.pct(r.ear), verdict: vv.join(' · '), dark: r.dark > 0 ? this.dur(r.dark) : 'none', nocomm: r.nocomm > 0 ? this.dur(r.nocomm) : 'none',
        select: () => this.selectSite(x.id) };
    });

    // time
    const tms = ser.times[ti], dt = new Date(tms);
    const stepD = [1, 2, 5, 7, 10, 14, 30, 60, 90].find((k) => days / k <= 6) || 120;
    const tjGo = (dd) => () => { const i = Math.max(0, Math.min(n - 1, Math.round(dd * 24 / ser.stepH))); this._tf = i; this.setState({ ti: i, playing: false }); };
    const ticks = [];
    for (let d = 0; d <= days + 1e-6; d += stepD) { const t = new Date(ser.times[0] + d * 86400000); ticks.push({ l: (d / Math.max(days, 1e-6) * 100).toFixed(3), label: t.getUTCDate() + ' ' + MN[t.getUTCMonth()], cls: 'tlab tjump' + (d === 0 ? ' first' : ''), go: tjGo(d), title: 'Jump to ' + t.getUTCDate() + ' ' + MN[t.getUTCMonth()] + ' 00:00 UTC' }); }
    if (ticks.length && days - (ticks.length - 1) * stepD > stepD * 0.45) { const t = new Date(ser.times[n - 1]); ticks.push({ l: '100', label: t.getUTCDate() + ' ' + MN[t.getUTCMonth()], cls: 'tlab tjump last', go: tjGo(days), title: 'Jump to the end of the period' }); } else if (ticks.length > 1) { ticks[ticks.length - 1].cls = 'tlab tjump last'; }
    const phases = [];
    {
      const pang = (i) => { const a = ser.st[i].sun, b = ser.st[i].earth; const cc = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])); return Math.acos(Math.max(-1, Math.min(1, cc))) * 180 / Math.PI; };
      const P = []; for (let i = 0; i < n; i++) P.push(pang(i));
      const FULL = 'M7 1a6 6 0 1 1 0 12a6 6 0 1 1 0-12z', FQ = 'M7 1a6 6 0 0 1 0 12z', LQ = 'M7 1a6 6 0 0 0 0 12z';
      const add = (i, kind) => { const d = new Date(ser.times[i]); const nm = { new: 'New Moon', fq: 'First quarter', full: 'Full Moon', lq: 'Last quarter' }[kind]; phases.push({ l: (i / Math.max(1, n - 1) * 100).toFixed(2), d: { new: '', fq: FQ, full: FULL, lq: LQ }[kind], title: nm + ' (as seen from Earth) · ' + d.getUTCDate() + ' ' + MN[d.getUTCMonth()] + ', lunar night/day on the far/near side' }); };
      for (let i = 1; i < n - 1; i++) {
        if (P[i] < P[i - 1] && P[i] <= P[i + 1] && P[i] < 30) add(i, 'full');
        else if (P[i] > P[i - 1] && P[i] >= P[i + 1] && P[i] > 150) add(i, 'new');
        else if (P[i - 1] > 90 && P[i] <= 90) add(i, 'fq');
        else if (P[i - 1] < 90 && P[i] >= 90) add(i, 'lq');
      }
    }
    const speeds = [[1, '1 h/s'], [6, '6 h/s'], [24, '1 day/s'], [72, '3 days/s']];
    const si = Math.max(0, speeds.findIndex((x) => x[0] === s.speed));
    const presetsR = [['Next 30 days', 30], ['Next 90 days', 90], ['Next year', 365]].map((p) => ({ label: p[1] === 365 ? '1 year' : p[1] + ' days', on: Math.round(days) === p[1], pick: () => this.setRange(this.state.start, this.state.start + p[1] * 86400000) }));

    // terrain
    const H = !isRegion ? this.heat() : null;
    const layers = [['off', 'None', 'M12 3a9 9 0 1 0 0.01 0M5.6 18.4L18.4 5.6', 'Plain ground'], ['score', 'Landing', 'M12 2v5M12 17v5M2 12h5M17 12h5M12 8a4 4 0 1 0 0.01 0', 'Landing suitability'], ['sun', 'Sun', 'M12 8a4 4 0 1 0 0.01 0M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', 'Sunlight over the period'], ['earth', 'Earth', 'M12 3a9 9 0 1 0 0.01 0M3 12h18M12 3c3.5 3.5 3.5 14.5 0 18M12 3c-3.5 3.5-3.5 14.5 0 18', 'Earth in view over the period'], ['slope', 'Slope', 'M3 20h18L3 7zM8 20a5 5 0 0 0-1.2-3.4', 'Ground slope']].map((l) => ({ label: l[1], ic: l[2], tip: l[3], on: s.layer === l[0], pick: set({ layer: l[0] }) }));
    const legend = { score: ['Poor', 'Great place to land', 'Too steep (over 15°)'], sun: ['Always dark', 'Always sunlit', ''], earth: ['Never sees Earth', 'Always sees Earth', ''], slope: ['Flat', '15°', 'Too steep (over 15°)'] }[s.layer] || ['', '', ''];
    let bestTxt = '';
    if (H && H.best) {
      const d = this._tj.dem, c = this.pinGrid(d), dx = (H.best.i - c.i) * d.cell, dy = (H.best.j - c.j) * d.cell;
      const dist = Math.round(Math.hypot(dx, dy) * 1000), az = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      bestTxt = (dist < 60 ? 'right at the pin' : (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km ' : dist + ' m ') + this.compass(az) + ' of the pin') + ', slope ' + H.best.slope.toFixed(0) + '°';
    }

    // landing plan, events, both-visible runs
    const landTi = s.landTi !== null && s.landTi < n ? s.landTi : this.autoLand(o, thr, n);
    const fmtT = (i) => { const d = new Date(ser.times[i]); return DN[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MN[d.getUTCMonth()] + ', ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC'; };
    const bothRuns = this.runsOf((i) => o.sF[i] >= thr && o.eF[i] >= thr, n);
    const lSun = o.sF[landTi] >= thr, lEar = o.eF[landTi] >= thr;
    const nS = this.nextChange(o.sF, landTi, thr, n, ser.stepH), nE = this.nextChange(o.eF, landTi, thr, n, ser.stepH);
    const pc = (i) => (i / Math.max(1, n - 1) * 100);
    const evs = [{ i: landTi, label: 'Landing', color: '#000', cls: 'ev land', title: 'Planned landing: ' + fmtT(landTi) + '. Click to jump there.' }];
    if (nS !== null) { const i = landTi + Math.round(nS / ser.stepH); evs.push({ i: i, label: lSun ? 'Sunset' : 'Sunrise', color: '#FFD60A', cls: 'ev', title: (lSun ? 'First sunset' : 'First sunrise') + ' after landing: ' + fmtT(i) }); }
    if (nE !== null) { const i = landTi + Math.round(nE / ser.stepH); evs.push({ i: i, label: lEar ? 'Earthset' : 'Earthrise', color: '#64D2FF', cls: 'ev', title: (lEar ? 'Earth sets' : 'Earth rises') + ' after landing: ' + fmtT(i) }); }
    evs.sort((a, b) => a.i - b.i);
    const events = []; let lastL = -99;
    evs.forEach((e) => { const l = pc(e.i); if (l - lastL < 14 && e.label !== 'Landing') return; lastL = l; events.push({ l: Math.min(96, Math.max(4, l)).toFixed(2), wc: e.label === 'Landing' ? '#F5F5F7' : e.color, label: e.label, color: e.color, cls: e.cls, title: e.title, go: () => { this._tf = e.i; this.setState({ ti: e.i, playing: false }); } }); });
    const plan = {
      when: fmtT(landTi),
      txt: 'At touchdown the Sun is ' + (lSun ? 'up' : 'down') + ' and Earth is ' + (lEar ? 'in view' : 'hidden') + '. ' +
        (lSun ? (nS === null ? 'Daylight lasts the whole period.' : 'Daylight lasts ' + this.dur(nS) + '.') : (nS === null ? 'No sunrise in this period.' : 'Sunrise ' + this.dur(nS) + ' later.')) + ' ' +
        (lEar ? (nE === null ? 'Earth stays up all period.' : 'Direct contact for ' + this.dur(nE) + '.') : (nE === null ? 'No Earthrise in this period.' : 'Earth rises ' + this.dur(nE) + ' later.')) +
        (s.landTi === null ? ' (Auto: start of the longest Sun + Earth window. Use “Land at this time” to change.)' : '')
    };

    // your landing point
    const tv = s.target && this._tj && s.target.key === this._tj.key && H ? s.target : null;
    const hasTarget = !!tv;
    let targetTxt = '', tgt = { sun: '–', earth: '–', slope: '–', score: '–', verdict: '' };
    if (tv) {
      const d = this._tj.dem, c = this.pinGrid(d), v = tv.j * d.N + tv.i, dx = (tv.i - c.i) * d.cell, dy = (tv.j - c.j) * d.cell;
      const dist = Math.round(Math.hypot(dx, dy) * 1000), az = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, sl = d.slope[v], sc = H.score[v];
      targetTxt = (dist < 60 ? 'At the pin' : (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km ' : dist + ' m ') + this.compass(az) + ' of the pin') + ', ' + Math.round(d.h[v] * 1000) + ' m relative height';
      tgt = { sun: this.pct(H.sun[v]), earth: this.pct(H.earth[v]), slope: sl.toFixed(0) + '°', score: sc < 0 ? '—' : sc.toFixed(2),
        verdict: sl > 15 ? 'Outside the 15° landing scenario limit. Try flatter ground nearby.' : (sc >= (H.best ? H.best.score * 0.9 : 1) ? 'Excellent — about as good as the best spot nearby.' : (sc >= 0.5 ? 'Workable, but the white-ring spot gets more sun/Earth time.' : 'Poor: little sunlight or Earth contact over the period.')) };
      tgt.drive = '';
      { const rc = this.state.mapReach && this.state.view === 'drive' ? this.reach() : null; if (rc) { const k = tv.j * d.N + tv.i, tt = rc.T[k]; let pl = 0, p = k; while (rc.prev[p] >= 0) { const q = rc.prev[p], a = p % d.N, b = (p - a) / d.N, a2 = q % d.N, b2 = (q - a2) / d.N; pl += Math.hypot(a - a2, b - b2) * d.cell; p = q; } const fromW = rc.o.from === 'rover' ? 'the rover' : (rc.o.from === 'landing' ? 'the landing site' : 'the best landing spot'); if(rc.routePointsFor&&isFinite(tt)){const pts=rc.routePointsFor(k);pl=0;for(let a=1;a<pts.length;a++)pl+=Math.hypot(pts[a].i-pts[a-1].i,pts[a].j-pts[a-1].j)*d.cell;} tgt.drive = isFinite(tt) && tt <= (rc.maxHours||24) ? (tt < 0.02 ? 'You are here' : 'Drive from ' + fromW + ': ' + this.fmtH(tt) + ' · ' + pl.toFixed(1) + ' km route') : 'No drivable route from ' + fromW + ' within '+(rc.maxHours||24)+' h (20° slope limit; scenario assumption)'; } }
    }

    // charts page
    let charts = [];
    if (s.sheet === 'charts-old') {
      const X0 = 48, X1 = 590, Y0 = 14, Y1 = 176;
      const xi = (i) => (X0 + i / Math.max(1, n - 1) * (X1 - X0)).toFixed(1);
      const mkY = (lo, hi) => (val) => (Y1 - (Math.max(lo, Math.min(hi, val)) - lo) / (hi - lo) * (Y1 - Y0)).toFixed(1);
      const series = (fn, Y) => { const k = Math.max(1, Math.ceil(n / 500)); let d = ''; for (let i = 0; i < n; i += k) d += (i === 0 ? 'M' : 'L') + xi(i) + ' ' + Y(fn(i)); return d; };
      const shade = (runs) => runs.map((r) => 'M' + xi(r.i0) + ' ' + Y0 + 'H' + xi(Math.min(n - 1, r.i1)) + 'V' + Y1 + 'H' + xi(r.i0) + 'Z').join('');
      const nd = Math.max(1, Math.round(days));
      const daily = (sid, test) => { const oo = ser.sites[sid], acc = new Float32Array(nd), cnt = new Float32Array(nd); for (let i = 0; i < n; i++) { const d = Math.min(nd - 1, Math.floor((ser.times[i] - ser.times[0]) / 86400000)); cnt[d]++; if (test(oo, i)) acc[d]++; } return Array.from(acc).map((a, k) => (cnt[k] ? a / cnt[k] : 0)); };
      const dailyPath = (arr, Y) => arr.map((v2, k) => (k === 0 ? 'M' : 'L') + (X0 + (k + 0.5) / nd * (X1 - X0)).toFixed(1) + ' ' + Y(v2 * 100)).join('');
      const xs = { xStart: fmtT(0).split(',')[0], xMid: fmtT(Math.floor((n - 1) / 2)).split(',')[0], xEnd: fmtT(n - 1).split(',')[0] };
      const marks = { cur: 'M' + xi(ti) + ' ' + Y0 + 'V' + Y1, land: 'M' + xi(landTi) + ' ' + Y0 + 'V' + Y1 };
      const click = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); const vx = (ev.clientX - r.left) / r.width * 600; const f = Math.max(0, Math.min(1, (vx - X0) / (X1 - X0))); const t2 = Math.round(f * (n - 1)); this._tf = t2; this.setState({ ti: t2, playing: false }); };
      const blank = { l0: '', l1: '', l2: '', l3: '', l4: '', l5: '', c0: '#fff', c1: '#fff', c2: '#fff', c3: '#fff', c4: '#fff', c5: '#fff', fill: '', fillColor: '#fff', zero: '' };
      const elY = mkY(-12, 12), pY = mkY(0, 100), azY = mkY(0, 360);
      const hzLbl = s.model === 'G1' ? 'skyline' : 'horizon';
      const multi = (test) => { const o2 = {}; s.sites.slice(0, 6).forEach((x, k) => { o2['l' + k] = dailyPath(daily(x.id, test), pY); o2['c' + k] = x.color; }); return o2; };
      const siteLegend = s.sites.slice(0, 6).map((x) => ({ name: x.name, color: x.color }));
      const grid4 = 'M' + X0 + ' ' + pY(25) + 'H' + X1 + 'M' + X0 + ' ' + pY(50) + 'H' + X1 + 'M' + X0 + ' ' + pY(75) + 'H' + X1;
      charts = [
        Object.assign({}, blank, xs, marks, { title: 'Sun height above the ' + hzLbl, sub: 'Degrees over time. Shaded = Sun visible (power possible).', l0: series((i) => o.sEl[i] - o.sH[i], elY), c0: '#FFD60A', fill: shade(this.runsOf((i) => o.sF[i] >= thr, n)), fillColor: '#FFD60A', zero: 'M' + X0 + ' ' + elY(0) + 'H' + X1, grid: 'M' + X0 + ' ' + elY(6) + 'H' + X1 + 'M' + X0 + ' ' + elY(-6) + 'H' + X1, yTop: '+12°', yMid: '0°', yBot: '−12°', legend: [{ name: 'Sun', color: '#FFD60A' }] }),
        Object.assign({}, blank, xs, marks, { title: 'Earth height above the ' + hzLbl, sub: 'Degrees over time. Shaded = Earth visible (direct radio geometry).', l0: series((i) => o.eEl[i] - o.eH[i], elY), c0: '#40A8FF', fill: shade(this.runsOf((i) => o.eF[i] >= thr, n)), fillColor: '#40A8FF', zero: 'M' + X0 + ' ' + elY(0) + 'H' + X1, grid: 'M' + X0 + ' ' + elY(6) + 'H' + X1 + 'M' + X0 + ' ' + elY(-6) + 'H' + X1, yTop: '+12°', yMid: '0°', yBot: '−12°', legend: [{ name: 'Earth', color: '#40A8FF' }] }),
        Object.assign({}, blank, xs, marks, multi((oo, i) => oo.sF[i] >= thr), { title: 'Sunlight per day — all places', sub: 'Share of each day with the Sun up.', grid: grid4, yTop: '100%', yMid: '50%', yBot: '0%', legend: siteLegend }),
        Object.assign({}, blank, xs, marks, multi((oo, i) => oo.eF[i] >= thr), { title: 'Earth contact per day — all places', sub: 'Share of each day with Earth in view.', grid: grid4, yTop: '100%', yMid: '50%', yBot: '0%', legend: siteLegend }),
        Object.assign({}, blank, xs, marks, multi((oo, i) => oo.sF[i] >= thr && oo.eF[i] >= thr), { title: 'Sun + Earth together per day — all places', sub: 'Best moments for powered operations with direct contact.', grid: grid4, yTop: '100%', yMid: '50%', yBot: '0%', legend: siteLegend }),
        Object.assign({}, blank, xs, marks, { title: 'Where to look: azimuth', sub: 'Compass direction of the Sun and Earth (0° = north, 90° = east).', l0: series((i) => o.sAz[i], azY), c0: '#FFD60A', l1: series((i) => o.eAz[i], azY), c1: '#40A8FF', grid: 'M' + X0 + ' ' + azY(90) + 'H' + X1 + 'M' + X0 + ' ' + azY(180) + 'H' + X1 + 'M' + X0 + ' ' + azY(270) + 'H' + X1, yTop: '360°', yMid: '180°', yBot: '0°', legend: [{ name: 'Sun', color: '#FFD60A' }, { name: 'Earth', color: '#40A8FF' }] })
      ].map((c) => Object.assign(c, { click: click, yTopY: Y0 + 4, yMidY: ((Y0 + Y1) / 2 + 4).toFixed(1), yBotY: Y1 + 4 }));
    }

    // landing score breakdown
    const per = Math.max(1, (n - 1) * ser.stepH), wsum = Math.max(1, s.wSun + s.wEarth + s.wGap);
    const grade = (x) => x >= 0.8 ? 'Excellent' : (x >= 0.65 ? 'Good' : (x >= 0.5 ? 'Fair' : 'Poor'));
    const gColor = (x) => x >= 0.65 ? '#30D158' : (x >= 0.5 ? '#FFD60A' : '#FF6961');
    const sunReason0 = (x) => x >= 0.9 ? 'Sunlit almost all the time — steady solar power.' : (x >= 0.6 ? 'Lit most of the time, with some dark spells.' : (x >= 0.3 ? 'Often in shadow — power is limited.' : 'Mostly dark — solar power is not practical.'));
    const earReason0 = (x) => x >= 0.9 ? 'Earth is almost always in view — direct radio link.' : (x >= 0.4 ? 'Earth in view about half the time; a relay is needed for the rest.' : (x > 0.05 ? 'Earth is usually hidden — mostly needs a relay satellite.' : 'Earth never rises here — a relay satellite is required.'));
    const sunReason = (x) => sunReason0(x) + (x > 0.65 ? ' Meets the NASA base-camp screen (>65%).' : ' Below the NASA base-camp screen (>65%).');
    const earReason = (x) => earReason0(x) + (x >= 0.5 ? ' Passes the ≥50% Earth-visibility screen.' : ' Fails the ≥50% Earth-visibility screen.');
    const darkReason0 = (h) => h <= 0 ? 'Never dark in this period.' : (h < 48 ? 'Short nights — small batteries are enough.' : (h < 24 * 7 ? 'Must survive ' + this.dur(h) + ' without sunlight.' : 'Must survive ' + this.dur(h) + ' of darkness — very demanding.'));
    const openMap = s.open || {}; const isOpen = (id) => !!openMap[id];
    const fShort = (h) => h === null ? null : (h < 1 ? '<1 h' : (h < 48 ? Math.round(h) + ' h' : (h / 24).toFixed(1) + ' d'));
    const places = s.sites.map((x) => {
      const o2 = ser.sites[x.id], r = met.res[x.id]; if (!o2 || !r) return null;
      const sOn = o2.sF[ti] >= thr, eOn = o2.eF[ti] >= thr;
      const sN = fShort(this.nextChange(o2.sF, ti, thr, n, ser.stepH)), eN = fShort(this.nextChange(o2.eF, ti, thr, n, ser.stepH));
      const sUp = o2.sEl[ti] - (o2.sH ? o2.sH[ti] : 0), eUp = o2.eEl[ti] - (o2.eH ? o2.eH[ti] : 0);
      const rows = [
        { name: 'Sunlight', value: this.pct(r.sun), pct: Math.round(r.sun * 100), color: '#FFD60A', tgt: 65, reason: sunReason(r.sun) },
        { name: 'Earth contact', value: this.pct(r.ear), pct: Math.round(r.ear * 100), color: '#40A8FF', tgt: 50, reason: earReason(r.ear) },
        { name: 'Longest dark', value: r.dark > 0 ? this.dur(r.dark) : 'none', pct: Math.round((1 - Math.min(1, r.dark / per)) * 100), color: '#BF5AF2', tgt: -10, reason: darkReason0(r.dark) }
      ];
      if (x.id === s.sel && H && H.best) rows.push({ tgt: -10, name: 'Flattest ground', value: H.best.slope.toFixed(0) + '°', pct: Math.round(Math.max(0, 1 - H.best.slope / 15) * 100), color: '#98989F', reason: 'Flattest well-lit spot within 2.5 km of the pin (LOLA point terrain, not in the score).' });
      const op = isOpen(x.id);
      return {
        name: x.name, color: x.color, coords: this.fmtCoords(x), sun: this.pct(r.sun), ear: this.pct(r.ear), num: Math.round(r.score * 100), scColor: gColor(r.score),
        grade: grade(r.score) + ' · #' + r.rank, cls: 'pl' + (x.id === s.sel ? ' sel' : ''), open: op, chev: op ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6',
        sunCls: 'nchip sun' + (sOn ? ' on' : ''), earCls: 'nchip ear' + (eOn ? ' on' : ''),
        sunNow: (sOn ? sUp.toFixed(1) + '°' : 'dark') + (sN ? (sOn ? ' · sets ' : ' · rises ') + sN : ''),
        earNow: (eOn ? eUp.toFixed(1) + '°' : 'hidden') + (eN ? (eOn ? ' · sets ' : ' · rises ') + eN : ''),
        rg0: ((Math.max(0.5, rows[0].pct) / 100) * 2 * Math.PI * 27).toFixed(1) + ' ' + (2 * Math.PI * 27).toFixed(1),
        rg1: ((Math.max(0.5, rows[1].pct) / 100) * 2 * Math.PI * 19).toFixed(1) + ' ' + (2 * Math.PI * 19).toFixed(1),
        rg2: ((Math.max(0.5, rows[2].pct) / 100) * 2 * Math.PI * 11).toFixed(1) + ' ' + (2 * Math.PI * 11).toFixed(1),
        ringsLabel: 'Activity rings for ' + x.name + ': sunlight ' + rows[0].value + ', Earth contact ' + rows[1].value + ', longest darkness ' + rows[2].value,
        sRuns: op ? this.runsOf((i) => o2.sF[i] >= thr, n) : [], eRuns: op ? this.runsOf((i) => o2.eF[i] >= thr, n) : [], bRuns: op ? this.runsOf((i) => o2.sF[i] >= thr && o2.eF[i] >= thr, n) : [],
        select: () => this.selectSite(x.id), isSel: x.id === s.sel,
        gid: String(x.id).replace(/[^A-Za-z0-9_-]/g, '_'),
        ...((() => { const E0 = { a: '', l: '', z: '', aria: '', now: '' }; if (!op) return { sRib: E0, eRib: E0 }; const mk = (EL, HZ, nm) => { const W2 = 300, Hh = 36, k = Math.max(1, Math.ceil(n / 240)); let lo = 0, hi = 0; for (let i = 0; i < n; i += k) { const v2 = EL[i] - HZ[i]; if (v2 < lo) lo = v2; if (v2 > hi) hi = v2; } hi = Math.max(hi, 0.5); lo = Math.min(lo, -0.5); const pd = (hi - lo) * 0.08; hi += pd; lo -= pd; const Y = (v2) => 2 + (hi - v2) / (hi - lo) * (Hh - 4); let l = '', a = 'M0 ' + Hh; for (let i = 0; i < n; i += k) { const xx = (i / Math.max(1, n - 1) * W2).toFixed(1), yy = Y(EL[i] - HZ[i]).toFixed(1); l += (i ? 'L' : 'M') + xx + ' ' + yy; a += 'L' + xx + ' ' + yy; } a += 'L' + W2 + ' ' + Hh + 'Z'; const v0 = EL[ti] - HZ[ti]; return { a: a, l: l, z: 'M0 ' + Y(0).toFixed(1) + 'H' + W2, aria: nm + ' height above the horizon over time at ' + x.name + ', range ' + lo.toFixed(1) + '° to ' + hi.toFixed(1) + '°', now: (v0 >= 0 ? '+' : '') + v0.toFixed(1) + '°' }; }; return { sRib: mk(o2.sEl, o2.sH, 'Sun'), eRib: mk(o2.eEl, o2.eH, 'Earth') }; })()),
        curM: 'M' + (ti / Math.max(1, n - 1) * 300).toFixed(1) + ' 0V36', landM: 'M' + (landTi / Math.max(1, n - 1) * 300).toFixed(1) + ' 0V36',
        info: () => { const mp = Object.assign({}, this.state.open || {}); mp[x.id] = !op; this.setState({ open: mp }); },
        infoLabel: (op ? 'Hide' : 'Show') + ' full report for ' + x.name,
        rows: rows, noRemove: s.sites.length <= 1, remove: () => this.removeSite(x.id),
        toggle: () => { const mp = Object.assign({}, this.state.open || {}); const cur = mp[x.id] === undefined ? x.id === this.state.sel : !!mp[x.id];
          if (x.id !== this.state.sel) { mp[x.id] = true; this.setState({ open: mp }); this.selectSite(x.id); } else { mp[x.id] = !cur; this.setState({ open: mp }); } }
      };
    }).filter(Boolean);
    const sc = (function (self) {
      const r = m, num = Math.round(r.score * 100);
      const rows = [
        { name: 'Sunlight', value: self.pct(r.sun), pct: Math.round(r.sun * 100), color: '#FFD60A', reason: sunReason(r.sun) },
        { name: 'Earth contact', value: self.pct(r.ear), pct: Math.round(r.ear * 100), color: '#40A8FF', reason: earReason(r.ear) },
        { name: 'Longest darkness', value: r.dark > 0 ? self.dur(r.dark) : 'none', pct: Math.round((1 - Math.min(1, r.dark / per)) * 100), color: '#BF5AF2', reason: darkReason0(r.dark) + ' Batteries are sized for this; the best polar sites see only 3–5 days.' }
      ];
      rows.forEach((row, k) => { row.tgt = k === 0 ? 65 : (k === 1 ? 50 : -10); });
      if (H && H.best) rows.push({ tgt: -10, name: 'Ground near the pin', value: H.best.slope.toFixed(0) + '° slope', pct: Math.round(Math.max(0, 1 - H.best.slope / 15) * 100), color: '#98989F', reason: 'Flattest well-lit spot within 2.5 km (LOLA point terrain, not counted in the score).' });
      return { num: num, deg: Math.round(r.score * 360), color: gColor(r.score), grade: grade(r.score) + ' for landing', sub: 'Rank ' + r.rank + ' of ' + s.sites.length + ' · over ' + Math.round(days) + ' days', rows: rows };
    })(this);
    rankRows.forEach((row) => { const x = s.sites.find((q) => q.name === row.name && q.color === row.color); const r = x ? met.res[x.id] : null; if (!r) return; row.num = Math.round(r.score * 100); row.deg = Math.round(r.score * 360); row.ringColor = gColor(r.score); row.darkPct = Math.round((1 - Math.min(1, r.dark / per)) * 100); });

    const rEl = (el) => Math.max(0, Math.min(104, 104 * (30 - el) / 38));
    const pxy = (az, el) => { const r = rEl(el), a = az * Math.PI / 180; return [110 + r * Math.sin(a), 110 - r * Math.cos(a)]; };
    // compare page
    const cmpIds = (s.cmpSel || met.order.slice(0, 3)).filter((id) => s.sites.some((x) => x.id === id));
    const cmpSites = cmpIds.map((id) => s.sites.find((x) => x.id === id));
    const cmpChips = s.sites.map((x) => ({ name: x.name, color: x.color, on: cmpIds.indexOf(x.id) >= 0, toggle: () => {
      let a = cmpIds.slice(); const k = a.indexOf(x.id);
      if (k >= 0) { if (a.length > 1) a.splice(k, 1); } else { if (a.length >= 3) a.pop(); a.push(x.id); }
      this.setState({ cmpSel: a });
    } }));
    const cmpCols = cmpSites.map((x) => {
      const r = met.res[x.id];
      const rows = [
        { name: 'Sunlight', value: this.pct(r.sun), raw: r.sun, hi: true },
        { name: 'Earth contact', value: this.pct(r.ear), raw: r.ear, hi: true },
        { name: 'Sun + Earth together', value: this.pct(r.both), raw: r.both, hi: true },
        { name: 'Longest darkness', value: r.dark > 0 ? this.dur(r.dark) : 'none', raw: r.dark, hi: false },
        { name: 'Longest without Earth', value: r.nocomm > 0 ? this.dur(r.nocomm) : 'none', raw: r.nocomm, hi: false },
        { name: 'Quasi-continuous light', value: r.lqcip > 0 ? this.dur(r.lqcip) : 'none', raw: r.lqcip, hi: true }
      ];
      rows[0].mk = r.sun > 0.65 ? '✓ >65%' : '✗ <65%'; rows[0].mkCls = 'mk ' + (r.sun > 0.65 ? 'pass' : 'fail');
      rows[1].mk = r.ear >= 0.5 ? '✓ ≥50%' : '✗ <50%'; rows[1].mkCls = 'mk ' + (r.ear >= 0.5 ? 'pass' : 'fail');
      rows.forEach((row) => { if (!row.mk) { row.mk = ''; row.mkCls = 'mk'; } });
      rows.forEach((row, ri) => {
        const vals = cmpSites.map((y) => [met.res[y.id].sun, met.res[y.id].ear, met.res[y.id].both, met.res[y.id].dark, met.res[y.id].nocomm, met.res[y.id].lqcip][ri]);
        const bestV = row.hi ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
        row.cls = cmpSites.length > 1 && Math.abs(row.raw - bestV) < 1e-9 && vals.some((q) => Math.abs(q - bestV) > 1e-9) ? 'best' : '';
      });
      let sky2 = null;
      if (s.sheet === 'charts') {
        const o2 = ser.sites[x.id], prof2 = s.model === 'G1' ? this.profileFor(x) : null;
        const trk = (azA, elA) => { const k2 = Math.max(1, Math.ceil(n / 260)); let d = ''; for (let i = 0; i < n; i += k2) { const pp = pxy(azA[i], elA[i]); d += (i === 0 ? 'M' : 'L') + pp[0].toFixed(1) + ' ' + pp[1].toFixed(1); } return d; };
        let tr = ''; for (let a = 0; a <= 360; a += 4) { const pp = pxy(a % 360, prof2 ? this.terrLib().profAt(prof2, a) : 0); tr += (a === 0 ? 'M' : 'L') + pp[0].toFixed(1) + ' ' + pp[1].toFixed(1); }
        tr += 'Z M6 110 A104 104 0 1 0 214 110 A104 104 0 1 0 6 110 Z';
        sky2 = { terrain: tr, sunTrack: trk(o2.sAz, o2.sEl), earTrack: trk(o2.eAz, o2.eEl), r0: rEl(0).toFixed(1), y0: (110 - rEl(0) - 3).toFixed(1), label: 'Sky as seen from ' + x.name + ': Sun and Earth paths over the period against the horizon' };
      } else sky2 = { terrain: '', sunTrack: '', earTrack: '', r0: 0, y0: 0, label: '' };
      return { sky: sky2, name: x.name, color: x.color, num: Math.round(r.score * 100), deg: Math.round(r.score * 360), ringColor: gColor(r.score), grade: grade(r.score), rank: r.rank, coords: this.fmtCoords(x), rows: rows };
    });
    let chartRows = [];
    if (s.sheet === 'charts') {
      const sep = s.cmpMode === 'separate' && cmpSites.length > 1;
      const W = 400, X0 = 48, X1 = W - 70, Y0 = 14, Y1 = sep ? 74 : 104;
      const xi = (i) => (X0 + i / Math.max(1, n - 1) * (X1 - X0)).toFixed(1);
      const dlab = (i) => { const d = new Date(ser.times[i]); return d.getUTCDate() + ' ' + MN[d.getUTCMonth()]; };
      const nd = Math.max(1, Math.round(days));
      const click = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); const vx = (ev.clientX - r.left) / r.width * W; const f = Math.max(0, Math.min(1, (vx - X0) / (X1 - X0))); const t2 = Math.round(f * (n - 1)); this._tf = t2; this.setState({ ti: t2, playing: false }); };
      const xAxis = { xt: 'M' + X0 + ' ' + Y1 + 'H' + X1 };
      for (let k = 0; k < 7; k++) xAxis['t' + k] = { x: -99, label: '' };
      { const t0 = ser.times[0], t1 = ser.times[n - 1], d3 = window.d3; const xs = (t) => X0 + (t - t0) / Math.max(1, t1 - t0) * (X1 - X0);
        let maj = [], mnr = [], fmt = (d) => d.getUTCDate() + ' ' + MN[d.getUTCMonth()];
        if (d3 && d3.scaleUtc) { const sc = d3.scaleUtc().domain([new Date(t0), new Date(t1)]); maj = sc.ticks(5); mnr = sc.ticks(days <= 45 ? d3.utcDay : d3.utcWeek); if (days <= 3) fmt = d3.utcFormat('%-d %b %H:%M'); else fmt = d3.utcFormat('%-d %b'); }
        else { const sd = [1, 2, 5, 7, 10, 14, 30, 60, 90].find((k) => days / k <= 4) || 120; for (let d = 0; d <= days + 1e-6; d += sd) maj.push(new Date(t0 + d * 86400000)); if (days <= 60) for (let d = 0; d <= days + 1e-6; d++) mnr.push(new Date(t0 + d * 86400000)); else for (let d = 0; d <= days + 1e-6; d += 7) mnr.push(new Date(t0 + d * 86400000)); }
        mnr.forEach((d) => { xAxis.xt += 'M' + xs(+d).toFixed(1) + ' ' + Y1 + 'v3'; });
        maj.slice(0, 7).forEach((d, k) => { const x = xs(+d); xAxis.xt += 'M' + x.toFixed(1) + ' ' + Y1 + 'v6'; xAxis['t' + k] = { x: Math.max(X0 + 16, Math.min(X1 - 16, x)).toFixed(1), label: fmt(d) }; });
      }
      const defs = [
        { title: 'Sun height above the ' + (s.model === 'G1' ? 'skyline' : 'horizon'), sub: 'Above the dashed line the Sun is up and solar power is possible.', yTitle: 'Elevation (°)', el: (o2, i) => o2.sEl[i] - o2.sH[i], vis: (o2, i) => o2.sF[i] >= thr },
        { title: 'Earth height above the ' + (s.model === 'G1' ? 'skyline' : 'horizon'), sub: 'Above the dashed line Earth is in view and direct radio contact is possible.', yTitle: 'Elevation (°)', el: (o2, i) => o2.eEl[i] - o2.eH[i], vis: (o2, i) => o2.eF[i] >= thr },
        { title: 'Sunlight per day', sub: 'Share of each day with the Sun up. Dashed green = NASA base-camp target (>65%).', yTitle: 'Sunlit (% of day)', thr: 65, thrT: 'target 65%', daily: (o2, i) => o2.sF[i] >= thr },
        { title: 'Earth contact per day', sub: 'Share of each day with Earth in view. Dashed green = screening target (≥50%).', yTitle: 'Earth in view (%)', thr: 50, thrT: 'target 50%', daily: (o2, i) => o2.eF[i] >= thr },
        { title: 'Sun + Earth together per day', sub: 'The best time for powered work with direct contact.', yTitle: 'Both (% of day)', daily: (o2, i) => o2.sF[i] >= thr && o2.eF[i] >= thr }
      ];
      const pathOf = (def, o2) => {
        const d3 = window.d3, pts = [];
        let base;
        if (def.el) { const Yv = (v2) => Y1 - (Math.max(-12, Math.min(12, v2)) + 12) / 24 * (Y1 - Y0); base = Yv(0); const k = Math.max(1, Math.ceil(n / 300)); for (let i = 0; i < n; i += k) { const v2 = def.el(o2, i); pts.push([X0 + i / Math.max(1, n - 1) * (X1 - X0), Yv(v2), Yv(Math.max(0, v2))]); } }
        else {
          base = Y1; const acc = new Float32Array(nd), cnt = new Float32Array(nd);
          for (let i = 0; i < n; i++) { const d = Math.min(nd - 1, Math.floor((ser.times[i] - ser.times[0]) / 86400000)); cnt[d]++; if (def.daily(o2, i)) acc[d]++; }
          for (let k = 0; k < nd; k++) { const v2 = cnt[k] ? acc[k] / cnt[k] : 0, y = Y1 - v2 * (Y1 - Y0); pts.push([X0 + (k + 0.5) / nd * (X1 - X0), y, y]); }
        }
        if (d3 && d3.line) {
          const ln = d3.line().x((q) => q[0]).y((q) => q[1]).curve(d3.curveMonotoneX), ar = d3.area().x((q) => q[0]).y0(base).y1((q) => q[2]).curve(d3.curveMonotoneX);
          return { l: ln(pts) || '', a: ar(pts) || '' };
        }
        let l = '', ar = 'M' + pts[0][0].toFixed(1) + ' ' + base.toFixed(1);
        pts.forEach((q, k) => { l += (k ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); ar += 'L' + q[0].toFixed(1) + ' ' + q[2].toFixed(1); });
        return { l: l, a: ar + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base.toFixed(1) + 'Z' };
      };
      let gidN = 0;
      const mkPanel = (def, list, named) => {
        const q = { thr: '', thrY: 0, thrT: '', vb: '0 0 ' + W + ' ' + (Y1 + 24), xLY: Y1 + 17, click: click, l0: '', l1: '', l2: '', c0: '#fff', c1: '#fff', c2: '#fff', fill: '', fillColor: '#fff', hasName: named, name: named ? list[0].name : '', color: list[0].color,
          aria: def.title + (named ? ' at ' + list[0].name : ' for ' + list.map((x) => x.name).join(', ')),
          axes: 'M' + X0 + ' ' + Y0 + 'V' + Y1 + 'H' + X1, cur: 'M' + xi(ti) + ' ' + Y0 + 'V' + Y1, land: 'M' + xi(landTi) + ' ' + Y0 + 'V' + Y1,
          yLx: X0 - 6, yTY: Y0 + 4, yMY: ((Y0 + Y1) / 2 + 4).toFixed(1), yBY: Y1 + 4, x0: X0, x1: X1, xm: ((X0 + X1) / 2).toFixed(1), xA: dlab(0), xB: dlab(Math.floor((n - 1) / 2)), xC: dlab(n - 1) };
        { const evx = (l) => X0 + l / 100 * (X1 - X0); q.evp = ''; for (let k = 0; k < 3; k++) q['e' + k] = { x: -99, label: '', c: '#fff' };
          events.slice(0, 3).forEach((e, k) => { const isL = e.label === 'Landing', x = isL ? +xi(landTi) : evx(+e.l); if (!isL) q.evp += 'M' + x.toFixed(1) + ' ' + Y0 + 'V' + Y1; q['e' + k] = { x: Math.max(X0 + 22, Math.min(X1 - 22, x)).toFixed(1), label: e.label, c: isL ? '#FFFFFF' : e.color }; }); }
        Object.assign(q, xAxis);
        q.ga = list.length > 1 ? 0.32 : 0.75; for (let k = 0; k < 3; k++) { q['g' + k] = 'cg' + (gidN++); q['a' + k] = ''; }
        list.forEach((x, k) => { const pp = pathOf(def, ser.sites[x.id]); q['l' + k] = pp.l; q['a' + k] = pp.a; q['c' + k] = x.color; });
        if (def.el) {
          const mid = ((Y0 + Y1) / 2).toFixed(1);
          q.zero = 'M' + X0 + ' ' + mid + 'H' + X1; q.grid = 'M' + X0 + ' ' + (Y0 + (Y1 - Y0) / 4).toFixed(1) + 'H' + X1 + 'M' + X0 + ' ' + (Y0 + 3 * (Y1 - Y0) / 4).toFixed(1) + 'H' + X1;
          q.yT = '+12°'; q.yM = '0°'; q.yB = '−12°';
          if (list.length === 1) { const o2 = ser.sites[list[0].id]; q.fill = ''; void this.runsOf((i) => def.vis(o2, i), n).map((r) => 'M' + xi(r.i0) + ' ' + Y0 + 'H' + xi(Math.min(n - 1, r.i1)) + 'V' + Y1 + 'H' + xi(r.i0) + 'Z').join(''); q.fillColor = list[0].color; }
        } else {
          if (def.thr) { const ty = (Y1 - def.thr / 100 * (Y1 - Y0)).toFixed(1); q.thr = 'M' + X0 + ' ' + ty + 'H' + X1; q.thrY = (Number(ty) + 3).toFixed(1); q.thrT = def.thrT; }
          q.zero = ''; q.grid = [0.25, 0.5, 0.75].map((f) => 'M' + X0 + ' ' + (Y1 - f * (Y1 - Y0)).toFixed(1) + 'H' + X1).join(''); q.yT = '100%'; q.yM = '50%'; q.yB = '0%';
        }
        return q;
      };
      chartRows = defs.map((def) => {
        const panels = sep ? cmpSites.map((x) => mkPanel(def, [x], true)) : [mkPanel(def, cmpSites, false)];
        return { title: def.title, sub: def.sub, yTitle: def.yTitle, n: panels.length, panels: panels, legend: cmpSites.map((x) => ({ name: x.name, color: x.color })) };
      });
    }
    const sct = { zone: '', grid: '', axes: 'M64 16V250H620', thr: '', t65x: 0, t50y: 0, aria: '' };
    for (let k = 0; k < 6; k++) sct['p' + k] = { x: -50, y: -50, r: 0, c: '#000', lx: -50, ly: -50, t: '', ta: 'start' };
    if (s.sheet === 'charts') {
      const SX = (v2) => 64 + v2 * 556, SY = (v2) => 250 - v2 * 234;
      sct.zone = 'M' + SX(0.65) + ' 16H620V' + SY(0.5) + 'H' + SX(0.65) + 'Z';
      sct.grid = [0.25, 0.5, 0.75].map((f) => 'M64 ' + SY(f) + 'H620M' + SX(f) + ' 16V250').join('');
      sct.thr = 'M' + SX(0.65) + ' 16V250M64 ' + SY(0.5) + 'H620'; sct.t65x = (SX(0.65) + 4).toFixed(1); sct.t50y = (SY(0.5) - 5).toFixed(1);
      const pts = s.sites.slice(0, 6).map((x) => ({ x: SX(met.res[x.id].sun), y: SY(met.res[x.id].ear), name: x.name, color: x.color }));
      pts.forEach((pt, k) => {
        let ly = pt.y + 4; for (let m2 = 0; m2 < k; m2++) if (Math.abs(pts[m2].x - pt.x) < 120 && Math.abs(pts[m2].ly - ly) < 14) ly += 15;
        pt.ly = ly; const right = pt.x > 470;
        sct['p' + k] = { x: pt.x.toFixed(1), y: pt.y.toFixed(1), r: 8, c: pt.color, lx: (right ? pt.x - 13 : pt.x + 13).toFixed(1), ly: ly.toFixed(1), t: pt.name + ' · ' + this.pct(met.res[s.sites[k].id].sun) + ' / ' + this.pct(met.res[s.sites[k].id].ear), ta: right ? 'end' : 'start' };
      });
      sct.aria = 'Scatter plot of sunlight versus Earth visibility: ' + s.sites.map((x) => x.name + ' ' + this.pct(met.res[x.id].sun) + ' sun, ' + this.pct(met.res[x.id].ear) + ' Earth').join('; ');
    }
    const bandAll = s.sheet === 'charts' ? s.sites.map((x) => { const o2 = ser.sites[x.id]; return { name: x.name, color: x.color,
      both: this.runsOf((i) => o2.sF[i] >= thr && o2.eF[i] >= thr, n), sun: this.runsOf((i) => o2.sF[i] >= thr && o2.eF[i] < thr, n), ear: this.runsOf((i) => o2.eF[i] >= thr && o2.sF[i] < thr, n) }; }) : [];
    const dl2 = (i) => { const d = new Date(ser.times[i]); return d.getUTCDate() + ' ' + MN[d.getUTCMonth()]; };
    const psrStat = H && H.psrKm2 !== undefined ? H.psrKm2.toFixed(1) + ' km² (' + Math.round(H.psrKm2 / 256 * 100) + '%)' : '–';
    const onMapClick = (ev) => {
      if (!this._tj) return;
      const N = this._tj.dem.N, g = this.mapGridAt(ev);
      this.setState({ target: { i: Math.max(0, Math.min(N - 1, Math.round(g.i))), j: Math.max(0, Math.min(N - 1, Math.round(g.j))), key: this._tj.key } });
    };

    // actions per view
    let pri, sec;
    if (isRegion) { pri = ['Explore the terrain', () => this.goView('terrain'), false]; sec = ['Drive a rover here', () => this.goView('drive'), false]; }
    else if (isTerrain) {
      pri = ['Drive a rover here', () => this.goView('drive'), false];
      sec = [s.landing ? 'Landing…' : (hasTarget ? 'Watch a landing at your point' : 'Watch a landing at the best spot'), () => { if (this.eng && this.terrReady() && !this.state.landing && this.eng.land()) { this._tf = landTi; this.setState({ landing: true, ti: landTi, playing: false }); } }, !ready || s.landing];
    } else { pri = ['Back to terrain view', () => this.goView('terrain'), false]; sec = ['Return rover to the pin', () => this.eng && this.eng.resetRover(), false]; }

    // rover HUD
    let eRise = null, eRiseTi = -1;
    for (let i = ti + 1; i < n; i++) if (o.eF[i] >= thr && o.eF[i - 1] < thr) { eRise = (i - ti) * ser.stepH; eRiseTi = i; break; }
    const rv = s.rover || { batt: 80, sun: 1, earth: true, kmh: 0, dist: 0, blocked: false };
    const hud = {
      batt: s.drain === false ? '∞' : Math.round(rv.batt) + '%',
      rate: s.drain === false ? '' : (() => { const w = rv.netW !== undefined ? rv.netW : 0, hm = (h) => h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : (h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' d'); if (w >= 0.5) return 'charging +' + Math.round(w) + ' W' + (rv.batt < 99.5 ? ' · full in ' + hm((100 - rv.batt) / 100 * 160 / w) : ''); if (w <= -0.5) return 'draining −' + Math.round(-w) + ' W' + (rv.batt > 0.5 ? ' · empty in ' + hm(rv.batt / 100 * 160 / -w) : ''); return 'holding'; })(), battPct: Math.max(2, Math.round(rv.batt)), battCls: 'hi ' + (rv.batt > 50 ? 'ok' : (rv.batt > 20 ? 'warn' : 'bad')),
      sun: rv.sun > 0.6 ? 'In sunlight' : (rv.sun > 0.02 ? 'Partly shaded' : 'In shadow'), sunCls: 'hi ' + (rv.sun > 0.02 ? 'sun' : 'dim'),
      earth: rv.earth ? 'Earth link' : (rv.earthWhy === 'hill' ? 'Earth behind a hill' : 'Earth below horizon'), earthCls: 'hi ' + (rv.earth ? 'ok' : 'bad'),
      canSkip: !rv.earth && eRise !== null, skipLabel: eRise !== null ? 'Skip to Earthrise (' + this.dur(eRise) + ')' : '',
      battLabel: s.drain === false ? 'Unlimited battery — click to use the battery model' : 'Battery model: 160 Wh, solar panel about 190 W in full sun, uses 10 W idle and 55 W while driving. Charges in sunlight, drains in shadow. Click to make it unlimited.',
      kmh: rv.kmh.toFixed(1) + ' km/h', dist: rv.dist < 1 ? Math.round(rv.dist * 1000) + ' m driven' : rv.dist.toFixed(2) + ' km driven',
      msg: rv.batt <= 0.5 ? 'Battery empty — speed up time until the Sun returns' : (rv.blocked ? 'Too steep to climb here — try another way' : ''),
      hasMsg: rv.batt <= 0.5 || !!rv.blocked
    };
    const tips = { region: 'Drag to turn the Moon · scroll to zoom · click a pin', terrain: 'Drag to orbit · scroll to zoom · click the ground to choose a landing spot', drive: s.nearHint ? 'That spot is right next to the rover. Click the top-down map, or zoom out and click farther away.' : 'Drive with W A S D or the arrow keys, Space to brake · click the top-down map or distant ground to set a destination' };

    // sky chart & details
    const track = (azA, elA) => { const k = Math.max(1, Math.ceil(n / 320)); let d = ''; for (let i = 0; i < n; i += k) { const p = pxy(azA[i], elA[i]); d += (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); } return d; };
    let terr = '';
    const prof = s.model === 'G1' && s.sheet === 'expert' ? this.profileFor(site) : null;
    for (let a = 0; a <= 360; a += 4) { const p = pxy(a % 360, prof ? this.terrLib().profAt(prof, a) : 0); terr += (a === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }
    terr += 'Z M6 110 A104 104 0 1 0 214 110 A104 104 0 1 0 6 110 Z';
    const sp = pxy(sAz, sEl), ep = pxy(eAz, eEl);
    const sky = s.sheet === 'expert' ? {
      terrain: terr, sunTrack: track(o.sAz, o.sEl), earTrack: track(o.eAz, o.eEl), sx: sp[0].toFixed(1), sy: sp[1].toFixed(1), ex: ep[0].toFixed(1), ey: ep[1].toFixed(1),
      r0: rEl(0).toFixed(1), r10: rEl(10).toFixed(1), r20: rEl(20).toFixed(1), y0: (110 - rEl(0) - 2).toFixed(1), y10: (110 - rEl(10) - 2).toFixed(1),
      label: 'Sky chart: Sun at azimuth ' + sAz.toFixed(1) + '°, elevation ' + sEl.toFixed(2) + '°; Earth at azimuth ' + eAz.toFixed(1) + '°, elevation ' + eEl.toFixed(2) + '°.'
    } : { terrain: '', sunTrack: '', earTrack: '', sx: 0, sy: 0, ex: 0, ey: 0, r0: 0, r10: 0, r20: 0, y0: 0, y10: 0, label: '' };
    const stx = ser.st[ti], sub = Math.hypot(stx.sun[0], stx.sun[1], stx.sun[2]);
    const sslat = Math.asin(stx.sun[2] / sub) * 180 / Math.PI, sslon = Math.atan2(stx.sun[1], stx.sun[0]) * 180 / Math.PI;
    const proRows = [
      { k: 'Sun azimuth / elevation', v: sAz.toFixed(2) + '° / ' + sEl.toFixed(3) + '°' },
      { k: 'Horizon at Sun azimuth', v: o.sH[ti].toFixed(3) + '°' }, { k: 'Sun disk visible', v: (sF * 100).toFixed(1) + '%' },
      { k: 'Earth azimuth / elevation', v: eAz.toFixed(2) + '° / ' + eEl.toFixed(3) + '°' },
      { k: 'Horizon at Earth azimuth', v: o.eH[ti].toFixed(3) + '°' }, { k: 'Earth disk visible', v: (eF * 100).toFixed(1) + '%' },
      { k: 'Earth distance', v: Math.round(o.eDist[ti]).toLocaleString('en-US') + ' km' },
      { k: 'Sub-solar point', v: Math.abs(sslat).toFixed(2) + '°' + (sslat < 0 ? 'S' : 'N') + ' ' + Math.abs(sslon).toFixed(2) + '°' + (sslon < 0 ? 'W' : 'E') },
      { k: 'Score · rank', v: m.score.toFixed(2) + ' · ' + m.rank + ' of ' + s.sites.length },
      { k: 'Time step', v: ser.stepH + ' h, ' + n + ' steps (UTC)' }
    ];
    const ex = s.sheet === 'expert';
    const X = (i) => (30 + i / Math.max(1, n - 1) * 286).toFixed(1), Y = (el) => (65 - clamp(el, -12, 12) * 4.8).toFixed(1);
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const line = (arr, harr) => { if (!ex) return ''; const k = Math.max(1, Math.ceil(n / 300)); let d = ''; for (let i = 0; i < n; i += k) d += (i === 0 ? 'M' : 'L') + X(i) + ' ' + Y(arr[i] - (harr ? harr[i] : 0)); return d; };
    const elc = { sun: line(o.sEl, s.model === 'G1' ? o.sH : null), ear: line(o.eEl, s.model === 'G1' ? o.eH : null), zero: 'M30 ' + Y(0) + 'H316', grid: 'M30 ' + Y(10) + 'H316M30 ' + Y(-10) + 'H316',
      cur: 'M' + X(ti) + ' 6V124', y10: (+Y(10) + 3).toFixed(1), y0: (+Y(0) - 3).toFixed(1), ym10: (+Y(-10) + 3).toFixed(1) };
    const wins = []; let wcount = 0, wtot = 0;
    for (let i = 0, i0 = -1; i <= n; i++) {
      const on = i < n && o.sF[i] >= thr && o.eF[i] >= thr;
      if (on && i0 < 0) i0 = i;
      if (!on && i0 >= 0) { const h = (i - i0) * ser.stepH; wcount++; wtot += h; if (wins.length < 6) { const d0 = new Date(ser.times[i0]); wins.push({ k: DN[d0.getUTCDay()] + ' ' + d0.getUTCDate() + ' ' + MN[d0.getUTCMonth()] + ', ' + pad2(d0.getUTCHours()) + ':00 UTC', v: this.dur(h) }); } i0 = -1; }
    }
    const csvReady = !!s.csvUrl && s.csvKey === met.key + '|' + s.model;
    const sheet = s.sheet;
    const toggleSheet = (name) => () => this.setState({ sheet: this.state.sheet === name ? null : name, sitesOpen: false });

    return {
      stageRef: R.stage, glRef: R.gl, ovRef: R.ov, pad: R.pad,
      glError: s.glError, hasGlError: !!s.glError,
      stageLabel: isRegion ? '3D view of the lunar south pole with ' + s.sites.length + ' places' : (isDrive ? 'Rover driving view near ' + site.name : '3D terrain around ' + site.name),
      isRegion: isRegion, isTerrain: isTerrain, isDrive: isDrive, notDrive: !isDrive, isTerrainOrDrive: !isRegion,
      cardShown: !isDrive || s.driveCard, showPill: isDrive && !s.driveCard, showCard: set({ driveCard: true }), hideCard: set({ driveCard: false, sitesOpen: false }),
      goRegion: () => this.goView('region'), goTerrain: () => this.goView('terrain'), goDrive: () => this.goView('drive'),
      sheetCompare: sheet === 'compare', sheetExpert: sheet === 'expert', sheetDates: sheet === 'dates',
      openCompare: toggleSheet('compare'), openExpert: toggleSheet('expert'), openDates: toggleSheet('dates'), closeSheet: set({ sheet: null }),
      showTip: (!s.tipOff[v] || (v === 'drive' && !!s.nearHint)) && !sheet, tipText: tips[v], closeTip: () => { const t = Object.assign({}, this.state.tipOff); t[v] = true; this.setState({ tipOff: t }); },
      zoomIn: () => this.eng && this.eng.zoom(0.8), zoomOut: () => this.eng && this.eng.zoom(1.25), resetView: () => this.eng && this.eng.reset(),
      cur: { name: site.name, color: site.color, coords: this.fmtCoords(site) },
      sitesOpen: s.sitesOpen, toggleSites: set({ sitesOpen: !s.sitesOpen, sheet: null }), chevPath: s.sitesOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6',
      siteRows: siteRows, presetChips: presetChips,
      addLat: s.addLat, addLon: s.addLon, addErr: s.addErr, hasAddErr: !!s.addErr,
      onAddLat: (ev) => this.setState({ addLat: ev.target.value, addErr: '' }), onAddLon: (ev) => this.setState({ addLon: ev.target.value, addErr: '' }),
      addSite: () => {
        const la = parseFloat(this.state.addLat), lo = parseFloat(this.state.addLon);
        if (isNaN(la) || isNaN(lo)) { this.setState({ addErr: 'Enter latitude and longitude in degrees, e.g. −89.5 and −137.' }); return; }
        this.addSiteAt(la, lo, '');
      },
      full: s.sites.length >= 6, pick: s.pick, pickDisabled: s.sites.length >= 6 || !isRegion,
      pickLabel: s.pick ? 'Click the Moon…' : 'Pick on the Moon', togglePick: set({ pick: !s.pick }),
      sunTileCls: 'tile sun' + (sunOn ? ' on' : ''), earTileCls: 'tile earth' + (earOn ? ' on' : ''),
      sunBig: sunOn ? (sF < 0.9995 ? 'Rising' : 'Sunlit') : (sF > 0.0005 ? 'Setting' : 'Dark'), earBig: earOn ? 'Visible' : 'Hidden',
      sunSub: sunSub, earSub: earSub,
      periodShort: Math.round(days) + ' days',
      m: { sun: this.pct(m.sun), earth: this.pct(m.ear), sunPct: Math.round(m.sun * 100), earPct: Math.round(m.ear * 100), dark: m.dark > 0 ? this.dur(m.dark) : 'none' },
      layers: layers, showLegend: s.layer !== 'off', legendLo: legend[0], legendHi: legend[1], legendNoGo: legend[2], showNoGo: !!legend[2],
      computing: !isRegion && !ready, terrainStatus: 'Calculating shadows… ' + Math.round(s.tprog * 100) + '%',
      hasBest: !!(H && H.best) && s.layer !== 'off', bestTxt: bestTxt,
      primaryLabel: pri[0], primaryAction: pri[1], primaryDisabled: pri[2], secondaryLabel: sec[0], secondaryAction: sec[1], secondaryDisabled: sec[2],
      htipOn: !!s.htip, htipX: s.htip ? s.htip.x : 0, htipY: s.htip ? s.htip.y : 0,
      hinfoShow: (e) => { const t = e && e.currentTarget; if (!t || !t.getBoundingClientRect) return; const r = t.getBoundingClientRect(); const cd = t.closest ? t.closest('aside') : null; const cr = cd ? cd.getBoundingClientRect() : r; this.setState({ htip: { x: Math.round(cr.right + 12), y: Math.round(Math.max(12, r.top - 40)) } }); },
      hinfoHide: () => { if (this.state.htip) this.setState({ htip: null }); },
      _lt: (this._landTi = landTi),
      reachOn: !!s.mapReach, toggleReach: () => this.setState({ mapReach: !this.state.mapReach }),
      reachFrom: (() => { const o = this._tj ? this.reachOrigin() : null; return !o ? 'the landing site' : (o.from === 'rover' ? 'the rover' : (o.from === 'landing' ? 'your landing site' : (o.from === 'best' ? 'the best landing spot (white ring)' : 'the place pin'))); })(),
      landHere: () => { this.setState({ bigMap: false, mapPick: false }); this.doLand(); },
      addTgt: () => this.addTargetPlace(), addTgtDisabled: !hasTarget || s.sites.length >= 6, addTgtLabel: s.sites.length >= 6 ? 'Compare is full (6)' : 'Add to compare',
      modeCaption: (s.landing || (s.landed && isTerrain)) ? 'Choose a landing spot and watch the descent' : isTerrain ? 'Inspect sunlight, Earth view and slopes' : isDrive ? 'Drive the rover and plan routes' : 'Pick places and mission dates',
      isLanding: !!s.landing || (!!s.landed && isTerrain), terrainTabOn: isTerrain && !s.landing && !s.landed, showLandBar: !!s.landed && isTerrain && !s.landing && !s.bigMap,
      goTerrainTab: () => { if (this.state.landed) this.setState({ landed: false }); this.goView('terrain'); },
      landAgain: () => { if (this.eng && this.terrReady() && !this.state.landing && this.eng.land()) { this._tf = landTi; this.setState({ landing: true, landed: false, ti: landTi, playing: false }); } },
      pickAnother: () => this.setState({ bigMap: true, mapPick: true, sheet: null }), landTabTitle: hasTarget ? 'Watch a landing at your point' : 'Watch a landing at the best spot',
      goLand: () => { const run = () => { if (this.eng && this.terrReady() && !this.state.landing && this.eng.land()) { this._tf = landTi; this.setState({ landing: true, ti: landTi, playing: false }); return true; } return false; }; if (!isTerrain) { this.goView('terrain'); let k = 0; const tick = () => { if (run() || ++k > 60) return; setTimeout(tick, 150); }; setTimeout(tick, 250); } else run(); },
      sct: sct, bandAll: bandAll, bandStart: dl2(0), bandMid: dl2(Math.floor((n - 1) / 2)), bandEnd: dl2(n - 1),
      obsOpts: [2, 10, 20].map((h) => ({ label: h + ' m', on: (s.obsH || 2) === h, pick: () => this.setState({ obsH: h }) })),
      cmpChips: cmpChips, cmpCols: cmpCols, cmpN: Math.max(1, cmpCols.length), chartRows: chartRows,
      cmpOverlay: s.cmpMode !== 'separate', cmpSeparate: s.cmpMode === 'separate', setOverlay: set({ cmpMode: 'overlay' }), setSeparate: set({ cmpMode: 'separate' }),
      cmpHint: 'Pick up to 3 places. Green ● marks the best value in each row. Over ' + Math.round(days) + ' days, ' + (s.model === 'G1' ? 'with LOLA relief (G1).' : 'flat-horizon model (G0).'),
      showMini: !isRegion && ready && !s.bigMap && !s.sheet, bigMap: !!s.bigMap && !isRegion, openBigMap: set({ bigMap: true, sheet: null }), closeBigMap: set({ bigMap: false, mapPick: false }), bigMapPre: s.mapPick ? 'Choose a landing spot' : 'Top-down map',
      miniRef: R.mini, bigRef: R.big, onMapClick: onMapClick, psrStat: psrStat,
      appCls: 'app' + (s.tlFull ? '' : ' tlc'), timeCls: 'time mat' + (s.tlFull ? '' : ' compact'), tlExpanded: !!s.tlFull,
      toggleTl: () => this.setState({ tlFull: !this.state.tlFull }), tlToggleLabel: s.tlFull ? 'Less' : 'Sun & Earth', tlToggleTitle: s.tlFull ? 'Hide the Sun and Earth strips' : 'Show Sun and Earth height strips', tlToggleIcon: s.tlFull ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6',
      sc: sc, places: places, addLabel: s.sitesOpen ? 'Done' : '+ Add place', showReasons: isRegion, targetCls: hasTarget ? 'target' : 'target empty',
      events: events, landPct: pc(landTi).toFixed(3), bothRuns: bothRuns, plan: plan,
      setLanding: () => this.setState({ landTi: this.state.ti }),
      sheetCharts: s.sheet === 'charts', openCharts: () => this.setState({ sheet: this.state.sheet === 'charts' ? null : 'charts', sitesOpen: false }), charts: charts,
      chartsHint: 'Scores use the weights in Science details. Click a chart to jump to that moment. Solid white line = time shown now, dashed = planned landing (' + fmtT(landTi) + ').',
      hasTarget: hasTarget, noTarget: !hasTarget, targetTxt: targetTxt, tgt: tgt, clearTarget: () => this.setState({ target: null }),
      hud: hud, noDrain: s.drain === false, toggleDrain: () => this.setState({ drain: this.state.drain === false }), skipEarth: () => { if (eRiseTi >= 0) { this._tf = eRiseTi; this.setState({ ti: eRiseTi }); } }, turbo: s.turbo, toggleTurbo: set({ turbo: !s.turbo }), resetRover: () => this.eng && this.eng.resetRover(),
      playing: s.playing, notPlaying: !s.playing, playLabel: s.playing ? 'Pause' : 'Play',
      togglePlay: () => { this._tf = this.state.ti; this.setState({ playing: !this.state.playing }); },
      dateBig: dt.getUTCDate() + ' ' + MN[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear(),
      timeSmall: pad2(dt.getUTCHours()) + ':' + pad2(dt.getUTCMinutes()) + ' UTC · day ' + (Math.floor((tms - ser.times[0]) / 86400000) + 1) + ' of ' + Math.max(1, Math.round(days)),
      timeAria: this.fmtTime(tms),
      sunRuns: m.sunRuns, earRuns: m.earRuns, ticks: ticks, phases: phases, timeMenu: !!s.timeMenu, ...((() => { const dTi = s.departTi !== null && s.departTi !== undefined && s.departTi > landTi && s.departTi < n ? s.departTi : Math.min(n - 1, landTi + Math.round(156 / ser.stepH)); const lp = landTi / Math.max(1, n - 1) * 100, dp = dTi / Math.max(1, n - 1) * 100; const dd = new Date(ser.times[dTi]); const fmtT = (ms) => { const d2 = new Date(ms); return d2.getUTCDate() + ' ' + MN[d2.getUTCMonth()] + ', ' + String(d2.getUTCHours()).padStart(2, '0') + ':' + String(d2.getUTCMinutes()).padStart(2, '0'); }; return { landTxt: fmtT(ser.times[landTi]), departTxt: fmtT(ser.times[dTi]), departPct: dp.toFixed(3), missionW: Math.max(0.3, dp - lp).toFixed(3), missionTitle: 'Surface stay: ' + this.dur((dTi - landTi) * ser.stepH) + ' (liftoff ' + dd.getUTCDate() + ' ' + MN[dd.getUTCMonth()] + ')', setDepart: () => { if (this.state.ti > landTi) this.setState({ departTi: this.state.ti }); } }; })()), showLegendBox: !isRegion && s.layer !== 'off' && !s.sheet, switchChips: s.sites.map((x) => ({ name: x.name, color: x.color, on: x.id === s.sel, pick: () => this.selectSite(x.id) })), plistShown: true, showStats: !!s.showStats, toggleStats: () => this.setState({ showStats: !this.state.showStats }), statsLabel: s.showStats ? 'Hide stats' : 'Stats', toggleTimeMenu: () => this.setState({ timeMenu: !this.state.timeMenu }), tl: this.timelineModel(ser, o, ticks),
      cursorPct: (ti / Math.max(1, n - 1) * 100).toFixed(3), maxTi: n - 1, ti: ti,
      onScrub: (ev) => { const x = parseInt(ev.target.value, 10) || 0; this._tf = x; this.setState({ ti: x }); },
      speedLabel: speeds[si][1], cycleSpeed: () => this.setState({ speed: speeds[(si + 1) % speeds.length][0] }),
      rangePresets: presetsR, startStr: new Date(s.start).toISOString().slice(0, 10), endStr: new Date(s.end).toISOString().slice(0, 10),
      onStart: (ev) => { const x = Date.parse(ev.target.value + 'T00:00:00Z'); if (!isNaN(x)) this.setRange(x, Math.max(this.state.end, x + 86400000)); },
      onEnd: (ev) => { const x = Date.parse(ev.target.value + 'T00:00:00Z'); if (!isNaN(x)) this.setRange(Math.min(this.state.start, x - 86400000), x); },
      stepTxt: ser.stepH === 1 ? 'hour' : ser.stepH + ' hours',
      rankHint: 'Over ' + Math.round(days) + ' days from ' + new Date(ser.times[0]).getUTCFullYear() + '-' + pad2(new Date(ser.times[0]).getUTCMonth() + 1) + '-' + pad2(new Date(ser.times[0]).getUTCDate()) + '. Tap a place to select it.',
      rankRows: rankRows,
      isG0: s.model === 'G0', isG1: s.model === 'G1', setG0: set({ model: 'G0' }), setG1: set({ model: 'G1' }),
      horizonWord: s.model === 'G1' ? 'skyline' : 'horizon', sky: sky, proRows: proRows, elc: elc, wins: wins, hasWin: wins.length > 0,
      winNote: wcount ? wcount + ' window' + (wcount > 1 ? 's' : '') + ', ' + this.dur(wtot) + ' in total' + (wcount > 6 ? ' (first 6 shown)' : '') + '. Full list in the CSV export.' : 'No time in this period when both are up at once.',
      modelNote: s.model === 'G1' ? 'Using measured LOLA relief (G1; local 16 km horizon) to block the Sun and Earth behind hills.' : 'Flat-horizon model (G0): hills are not included. Change in Details.',
      visDef: s.visDef, onVisDef: (ev) => this.setState({ visDef: ev.target.value }),
      wSun: s.wSun, wEarth: s.wEarth, wGap: s.wGap,
      onWSun: (ev) => this.setState({ wSun: +ev.target.value }), onWEarth: (ev) => this.setState({ wEarth: +ev.target.value }), onWGap: (ev) => this.setState({ wGap: +ev.target.value }),
      prepCsv: () => this.csv(), csvReady: csvReady, csvUrl: s.csvUrl, csvName: s.csvName, csvSumUrl: s.csvSumUrl, csvSumName: s.csvSumName,
      hzSun: this.hzUrl('10', site, tms), hzEarth: this.hzUrl('399', site, tms)
    };
  }

  // ---------- WebGL engine ----------
  engLib() {
    if (this._EL) return this._EL;
    const D2R = Math.PI / 180;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    function persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]); }
    function lookAt(e, c, up) {
      const z = norm(sub(e, c)), x = norm(cross(up, z)), y = cross(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]);
    }
    function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
    function proj(m, p) {
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [x / w, y / w, w];
    }
    function model(pos, yaw, tilt, s) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
      return new Float32Array([cy * s, 0, -sy * s, 0, sy * st * s, ct * s, cy * st * s, 0, sy * ct * s, -st * s, cy * ct * s, 0, pos[0], pos[1], pos[2], 1]);
    }
    function basisModel(pos, r, u, f, s) { return new Float32Array([r[0] * s, r[1] * s, r[2] * s, 0, u[0] * s, u[1] * s, u[2] * s, 0, f[0] * s, f[1] * s, f[2] * s, 0, pos[0], pos[1], pos[2], 1]); }

    const NOISE = `
float h3(vec3 p){ p = fract(p*0.3183099 + vec3(0.1,0.2,0.3)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1.0,0.0,0.0)), f.x), mix(h3(i+vec3(0.0,1.0,0.0)), h3(i+vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(h3(i+vec3(0.0,0.0,1.0)), h3(i+vec3(1.0,0.0,1.0)), f.x), mix(h3(i+vec3(0.0,1.0,1.0)), h3(i+vec3(1.0,1.0,1.0)), f.x), f.y), f.z); }
`;
    const SKY_VS = `attribute vec2 aP; varying vec2 vUV; void main(){ vUV = aP; gl_Position = vec4(aP, 0.999, 1.0); }`;
    const SKY_FS = `precision highp float;
varying vec2 vUV;
uniform vec3 uR; uniform vec3 uU; uniform vec3 uF; uniform vec3 uSunDir;
uniform float uTan; uniform float uAsp; uniform float uGround;
` + NOISE + `
void main(){
  vec3 d = normalize(uF + vUV.x*uTan*uAsp*uR + vUV.y*uTan*uU);
  vec3 col = vec3(0.0);
  vec3 p = d*240.0; vec3 c = floor(p); vec3 f = fract(p);
  float h = h3(c);
  if (h > 0.982) {
    vec3 sp = vec3(h3(c+1.3), h3(c+2.7), h3(c+5.1))*0.6 + 0.2;
    float b = (h - 0.982)/0.018;
    float m = 1.0 - smoothstep(0.0, 0.16, length(f - sp));
    vec3 tint = mix(vec3(0.72,0.8,1.0), vec3(1.0,0.86,0.72), h3(c+9.0));
    col += tint*m*(0.15 + 1.1*b*b*b);
  }
  float bd = dot(d, normalize(vec3(0.35,0.55,0.76)))*3.2;
  col += vec3(0.035,0.04,0.055)*exp(-bd*bd)*(0.4 + 0.9*vn(d*7.0)*vn(d*23.0));
  if (uGround > 0.5) {
    float g = 1.0 - smoothstep(-0.004, 0.002, d.y);
    vec3 hd = normalize(vec3(d.x, 0.0, d.z) + vec3(0.0001, 0.0, 0.0));
    vec3 sd = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0001, 0.0, 0.0));
    float lit = pow(max(dot(hd, sd), 0.0), 2.0)*clamp(uSunDir.y*25.0 + 0.6, 0.0, 1.0);
    vec3 gc = vec3(0.018,0.019,0.022) + vec3(0.07,0.064,0.056)*lit*smoothstep(-0.25, 0.0, d.y);
    col = mix(col, gc, g);
  }
  gl_FragColor = vec4(col, 1.0);
}`;
    // Measured LOLA geometry and normals; no procedural lunar features.
    const MOON_VS = `attribute vec3 aP;attribute vec3 aN;uniform mat4 uPV;varying vec3 vP;varying vec3 vN;void main(){vP=aP;vN=aN;gl_Position=uPV*vec4(aP,1.);}`;
    const MOON_FS = window.RealMoon.fragmentShader;
    const BB_VS = `attribute vec2 aP; uniform mat4 uPV; uniform vec3 uC; uniform vec3 uRt; uniform vec3 uUp; uniform float uSize; varying vec2 vUV; varying vec3 vW;
void main(){ vUV = aP; vec3 w = uC + (uRt*aP.x + uUp*aP.y)*uSize; vW = w; gl_Position = uPV*vec4(w, 1.0); }`;
    const BB_FS = `precision highp float;
varying vec2 vUV; varying vec3 vW;
uniform float uMode; uniform vec3 uSunL; uniform vec3 uCamPos; uniform float uGround; uniform float uSpin;
` + NOISE + `
void main(){
  vec3 dir = normalize(vW - uCamPos);
  float hz = uGround > 0.5 ? smoothstep(-0.0015, 0.0015, dir.y) : 1.0;
  float r = length(vUV);
  if (uMode < 0.5) {
    float core = 1.0 - smoothstep(0.06, 0.075, r);
    float glow = 0.55*exp(-r*9.0) + 0.16*exp(-r*3.0);
    float streak = 0.22*exp(-abs(vUV.y)*80.0)*exp(-abs(vUV.x)*2.5);
    vec3 c = vec3(1.0, 0.97, 0.9)*core*3.0 + vec3(1.0, 0.85, 0.6)*(glow + streak)*(1.0 - smoothstep(0.85, 1.0, r));
    gl_FragColor = vec4(c*hz, 1.0);
  } else {
    float rr = r/0.88;
    if (rr > 1.12) discard;
    float z = sqrt(max(0.0, 1.0 - rr*rr));
    vec3 n = vec3(vUV/0.88, z);
    float lam = dot(n, uSunL);
    float ca = cos(uSpin); float sa = sin(uSpin);
    vec3 q = vec3(n.x*ca + n.z*sa, n.y, -n.x*sa + n.z*ca);
    float land = smoothstep(0.5, 0.56, vn(q*2.2 + 3.0)*0.65 + vn(q*5.0)*0.35);
    float ice = smoothstep(0.8, 0.88, abs(q.y));
    float cloud = smoothstep(0.55, 0.78, vn(q*4.0 + 11.0)*0.6 + vn(q*11.0)*0.4);
    vec3 base = mix(vec3(0.03, 0.09, 0.24), vec3(0.2, 0.26, 0.12), land);
    base = mix(base, vec3(0.85), ice);
    base = mix(base, vec3(0.92), cloud*0.8);
    float day = smoothstep(-0.08, 0.12, lam);
    vec3 col = base*max(lam, 0.0)*1.9*day + base*0.01;
    col += vec3(0.25, 0.5, 1.0)*pow(1.0 - z, 2.5)*day*0.8;
    col = pow(vec3(1.0) - exp(-col*1.5), vec3(1.0/2.2));
    float edge = 1.0 - smoothstep(0.97, 1.0, rr);
    float halo = (1.0 - smoothstep(1.0, 1.12, rr))*(1.0 - edge)*0.5*smoothstep(-0.3, 0.3, dot(normalize(vUV + vec2(0.0001)), uSunL.xy));
    gl_FragColor = vec4(col*edge + vec3(0.3, 0.55, 1.0)*halo, max(edge, halo)*hz);
  }
}`;
    const TER_VS = `attribute vec3 aP; attribute vec3 aN; attribute vec4 aD; uniform mat4 uPV; uniform float uShadeMix;
varying vec3 vW; varying vec3 vN; varying float vS; varying float vH; varying float vTravel;
void main(){ vW = aP; vN = aN; vS = mix(aD.z,aD.x,uShadeMix); vH = aD.y; vTravel=aD.w; gl_Position = uPV*vec4(aP, 1.0); }`;
    const TER_FS = `precision highp float;
varying vec3 vW; varying vec3 vN; varying float vS; varying float vH; varying float vTravel;
uniform vec3 uSun; uniform vec3 uCam; uniform float uHeat; uniform float uHalf; uniform sampler2D uImagery; uniform float uHasImagery; uniform float uSurfaceDetail; uniform float uTravel; uniform vec2 uOrigin; uniform vec3 uFade;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
float n2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y); }
// Cosmetic Drive regolith: value noise with analytic gradient (xy = d/dp) and one sparse bowl crater per cell (x = rim/bowl height, yz = slope). Not measured data.
vec3 nd(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0 - 2.0*f); vec2 du = 6.0*f*(1.0 - f);
  float a = h12(i), b = h12(i + vec2(1.0, 0.0)), c = h12(i + vec2(0.0, 1.0)), d = h12(i + vec2(1.0, 1.0)); float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1*u.x + k2*u.y + k4*u.x*u.y, du*vec2(k1 + k4*u.y, k2 + k4*u.x)); }
vec3 crater(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); if (h12(i + 17.3) < 0.68) return vec3(0.0);
  float R = 0.1 + 0.2*h12(i + 71.7); vec2 d = (f - (vec2(1.5*R) + (1.0 - 3.0*R)*vec2(h12(i + 3.1), h12(i + 9.7))))/R; float t = length(d);
  if (t > 1.5) return vec3(0.0);
  float rim = 0.22*exp(-10.0*(t - 1.0)*(t - 1.0)), w = max(1.0 - t*t, 0.0);
  float dh = (t < 1.0 ? 4.0*t*w : 0.0) - 20.0*(t - 1.0)*rim;
  return vec3(rim - w*w, dh*d/max(t, 0.001)); }
vec3 viridis(float t){
  vec3 a = vec3(0.180, 0.227, 0.361); vec3 b = vec3(0.369, 0.561, 0.839);
  vec3 c = vec3(0.361, 0.580, 0.439); vec3 d = vec3(0.949, 0.788, 0.298);
  if (t < 0.33) return mix(a, b, t / 0.33);
  if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
  return mix(c, d, (t - 0.66) / 0.34);
}
void main(){
  vec3 n = normalize(vN);
  vec2 q = vW.xz + uOrigin; // site-anchored, so procedural detail does not move when Drive loads the next terrain window
  float camd = length(uCam - vW);
  float dk = 1.0 - smoothstep(0.25, 2.5, camd);
  // Measured DEM normals with the actual LROC WAC 100 m observation mosaic. Acquisition shadows are fixed in the texture; lighting masks remain calculated independently.
  float observed=texture2D(uImagery,vec2(vW.x/(2.0*uHalf)+0.5,0.5-vW.z/(2.0*uHalf))).r;
  float alb=0.16*mix(1.0,0.3+1.2*observed,uHasImagery);
  vec3 V = normalize(uCam - vW);
  float detailFade=uSurfaceDetail*(1.0-smoothstep(0.25,0.9,camd));
  if(detailFade>0.001){
    // Cosmetic regolith detail in site metres. Each octave fades once a pixel covers about half its wavelength, so it never shimmers; distant ground keeps the measured brightness.
    vec2 metres=q*1000.0;float px=camd*1.3/max(dot(n,V),0.12); // approximate ground metres per pixel
    float w0=1.0-smoothstep(1.2,4.0,px),w1=1.0-smoothstep(0.3,1.0,px),w2=1.0-smoothstep(0.08,0.26,px),w3=1.0-smoothstep(0.02,0.07,px);
    vec3 o0=nd(metres/7.0)*w0,o1=nd(metres/1.7+vec2(31.7,11.3))*w1,o2=nd(metres/0.43+vec2(5.1,47.9))*w2,o3=nd(metres/0.11+vec2(19.3,3.7))*w3;
    vec2 m2=vec2(0.8*metres.x+0.6*metres.y,-0.6*metres.x+0.8*metres.y)/2.6;
    vec3 c0=crater(metres/11.0)*w0,c1=crater(m2)*w1;
    vec2 slope=o0.yz*0.05+o1.yz*0.08+o2.yz*0.09+o3.yz*0.09+c0.yz*0.16+vec2(0.8*c1.y-0.6*c1.z,0.6*c1.y+0.8*c1.z)*0.16;
    float mottle=(o0.x-0.5*w0)*0.14+(o1.x-0.5*w1)*0.10+(o2.x-0.5*w2)*0.07+(o3.x-0.5*w3)*0.07+(c0.x+c1.x)*0.06;
    alb*=1.0+clamp(mottle,-0.16,0.16)*detailFade;
    n=normalize(n-vec3(slope.x,0.0,slope.y)*detailFade); // lit below by the real Sun direction: low Sun gives long micro-shadows; lit/shadow state itself stays vS
  }
  float mu0 = max(dot(n, uSun), 0.0); float mu = max(dot(n, V), 0.03);
  float br = mix(2.0*mu0/(mu0 + mu), mu0, 0.35);
  vec3 col = mix(vec3(1.0,0.975,0.94),vec3(1.0),uSurfaceDetail)*alb*br*vS*3.0;
  col += alb*vec3(0.45, 0.55, 0.75)*0.03*(0.5 + 0.5*n.y);
  col = vec3(1.0) - exp(-col*1.7);
  col = pow(col, vec3(1.0/2.2));
  if (uHeat > 0.5) {
    float hs = 0.45 + 0.55*clamp(dot(n, normalize(vec3(-0.45, 0.8, -0.4))), 0.0, 1.0);
    vec3 hc; float hk = 0.72;
    if (vH < -1.5) { hc = mix(vec3(0.2, 0.5, 0.98), vec3(0.72, 0.9, 1.0), n2(q*4.0)*0.55); }
    else if (vH < -0.5) { hc = vec3(0.60, 0.30, 0.27); hk = 0.38; } // too steep: plain muted red tint (no stripes), as on the top-down map
    else { hc = viridis(clamp(vH, 0.0, 1.0)); hk *= 1.0 - 0.6*uSurfaceDetail*(1.0 - smoothstep(0.04, 0.3, camd)); } // Drive: let neutral regolith show near the rover; hazard tints (steep, PSR) stay full strength
    col = mix(col, hc*hs, hk*(1.0 - 0.5*dk)) + col*0.25;
  }
  if(uTravel>.5&&vTravel>=0.0){vec3 travelColor;{float t=clamp(vTravel,0.0,1.0);travelColor=t<.33?mix(vec3(.98,.84,.3),vec3(.88,.4,.13),t/.33):t<.66?mix(vec3(.88,.4,.13),vec3(.48,.13,.48),(t-.33)/.33):mix(vec3(.48,.13,.48),vec3(.08,.10,.24),(t-.66)/.34);}col=mix(col,travelColor*(.65+.35*max(dot(n,normalize(vec3(-.45,.8,-.4))),0.0)),.7);}
  // Terrain view fades at the square's border; Drive fades around the rover, inside the loaded window, so re-centring the window is invisible.
  float edge = uFade.z > 0.0 ? length(vW.xz - uFade.xy)/uFade.z : max(abs(vW.x), abs(vW.z))/uHalf;
  col = mix(col, vec3(0.018, 0.019, 0.022), smoothstep(0.82, 1.0, edge));
  gl_FragColor = vec4(col, 1.0);
}`;
    const ROUTE_VS=`attribute vec3 aP;attribute vec3 aPrev;attribute vec3 aNext;attribute float aSide;attribute float aDist;uniform mat4 uPV;uniform vec3 uViewport;uniform float uWidth;uniform vec3 uCam;varying float vSide;varying float vDist;varying float vEye;
// Lift the ribbon about one pixel above the ground (in world space) so it never z-fights, while hills in front still hide it.
vec3 lift(vec3 q){return q+vec3(0.0,clamp(distance(uCam,q)*0.0012,0.00015,0.02),0.0);}
void main(){vec4 p=uPV*vec4(lift(aP),1.0),a=uPV*vec4(lift(aPrev),1.0),b=uPV*vec4(lift(aNext),1.0);vec2 direction=(b.xy/max(b.w,.00001)-a.xy/max(a.w,.00001))*uViewport.xy;direction/=max(length(direction),.00001);vec2 n=vec2(-direction.y,direction.x);p.xy+=n*aSide*uWidth*2.0/uViewport.xy*p.w;vSide=aSide;vDist=aDist;vEye=distance(uCam,aP);gl_Position=p;}`;
    const ROUTE_FS=`#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying float vSide;varying float vDist;varying float vEye;uniform float uTime;uniform float uMode;uniform float uRemain;
// Premultiplied output. Mode 1: driven trail fading behind the rover. Mode 0: glowing ribbon whose core keeps the exact route blue (occlusion review counts it) with bright chevrons flowing toward the destination.
void main(){float s=abs(vSide);
if(uMode>.5){float a=exp(-max(vDist-uRemain,0.0)*7.0)*(1.0-smoothstep(.45,1.0,s))*.5;gl_FragColor=vec4(vec3(.55,.8,1.0)*a,a);return;}
if(s>.62){float a=.85*(1.0-smoothstep(.62,1.0,s))+.08;gl_FragColor=vec4(vec3(.12,.45,.9)*a,a);return;}
float sp=max(.008,vEye*.05);float f=fract((vDist-s*sp*.45)/sp+uTime*1.3);float c=step(f,.26)*step(s,.5);
gl_FragColor=vec4(mix(vec3(.25,.66,1.0),vec3(.82,.95,1.0),c),1.0);}`;
    const OBJ_VS = `attribute vec3 aP; attribute vec3 aN; attribute vec3 aC; uniform mat4 uPV; uniform mat4 uM;
varying vec3 vN; varying vec3 vC; varying vec3 vW;
void main(){ vec4 w = uM*vec4(aP, 1.0); vW = w.xyz; vN = (uM*vec4(aN, 0.0)).xyz; vC = aC; gl_Position = uPV*w; }`;
    const OBJ_FS = `precision highp float;
varying vec3 vN; varying vec3 vC; varying vec3 vW;
uniform vec3 uSun; uniform vec3 uCam; uniform float uLit;
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(uCam - vW);
  if (dot(n, v) < 0.0) n = -n;
  float d = max(dot(n, uSun), 0.0)*uLit;
  vec3 hh = normalize(uSun + v);
  float sp = pow(max(dot(n, hh), 0.0), 40.0)*uLit;
  vec3 col = vC*(d*2.2 + 0.07 + 0.05*max(n.y, 0.0)) + vec3(1.0, 0.95, 0.85)*sp*0.8;
  col = vec3(1.0) - exp(-col*1.6);
  gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), 1.0);
}`;
    const PL_VS = `attribute vec3 aP; attribute float aT; uniform mat4 uPV; uniform mat4 uM; uniform float uLen; varying float vT;
void main(){ vT = aT; vec3 p = vec3(aP.x, 0.9 + aP.y*uLen, aP.z); gl_Position = uPV*(uM*vec4(p, 1.0)); }`;
    const PL_FS = `precision highp float; varying float vT; uniform float uThr; uniform float uTime;
void main(){ vec3 c = mix(vec3(1.0, 0.9, 0.72), vec3(0.45, 0.6, 1.0), vT);
  float a = (1.0 - vT)*(1.0 - vT)*uThr*(0.75 + 0.25*sin(uTime*70.0 + vT*25.0));
  gl_FragColor = vec4(c*a*0.9, 1.0); }`;
    const DU_VS = `attribute vec4 aD; uniform mat4 uPV; uniform vec3 uO; uniform float uT; uniform float uPx; uniform float uS; varying float vA;
void main(){
  float tau = uT - aD.z; vA = 0.0; vec3 p = uO;
  if (tau > 0.0) { float r = aD.y*tau*(1.0 - 0.18*tau)*uS; p = uO + vec3(cos(aD.x)*r, (0.004 + aD.w*tau*0.03)*uS, sin(aD.x)*r); vA = clamp(1.0 - tau/2.4, 0.0, 1.0)*0.5; }
  vec4 c = uPV*vec4(p, 1.0); gl_Position = c;
  gl_PointSize = clamp(uPx*(0.012 + 0.02*max(tau, 0.0))*uS/max(c.w, 0.0001), 1.0, 64.0);
}`;
    const DU_FS = `precision mediump float; varying float vA;
void main(){ vec2 q = gl_PointCoord*2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; gl_FragColor = vec4(vec3(0.62, 0.58, 0.52)*vA*(1.0 - r), 1.0); }`;

    function create(cv, ov, stageEl, cb) {
      const gl = cv.getContext('webgl', { antialias: true, alpha: false, stencil: true });
      if (!gl) throw new Error('WebGL is not supported here');
      if(!gl.getExtension('OES_element_index_uint'))throw new Error('This device lacks 32-bit terrain index support.');
      const g2 = ov.getContext('2d');
      ov.tabIndex = 0;
      function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s)); return s; }
      function prog(vs, fs) {
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
        const u = {}, a = {};
        const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < nu; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name] = gl.getUniformLocation(p, inf.name); }
        const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); for (let i = 0; i < na; i++) { const inf = gl.getActiveAttrib(p, i); a[inf.name] = gl.getAttribLocation(p, inf.name); }
        return { p: p, u: u, a: a };
      }
      function buf(data, target, usage) { const b = gl.createBuffer(); gl.bindBuffer(target || gl.ARRAY_BUFFER, b); gl.bufferData(target || gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); return b; }
      let enabled = [];
      function use(P, attrs) {
        gl.useProgram(P.p);
        for (let i = 0; i < enabled.length; i++) gl.disableVertexAttribArray(enabled[i]);
        enabled = [];
        for (let i = 0; i < attrs.length; i++) {
          const loc = P.a[attrs[i][0]]; if (loc === undefined || loc < 0) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, attrs[i][1]); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, attrs[i][2], gl.FLOAT, false, 0, 0); enabled.push(loc);
        }
      }
      function U(P, name, v) {
        const l = P.u[name]; if (!l) return;
        if (typeof v === 'number') gl.uniform1f(l, v);
        else if (v.length === 3) gl.uniform3fv(l, v);
        else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
      }
      const P = {
        sky: prog(SKY_VS, SKY_FS), moon: prog(MOON_VS, MOON_FS), bb: prog(BB_VS, BB_FS), ter: prog(TER_VS, TER_FS),
        route:prog(ROUTE_VS,ROUTE_FS), obj: prog(OBJ_VS, OBJ_FS), pl: prog(PL_VS, PL_FS), du: prog(DU_VS, DU_FS)
      };
      const quad = buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      const realMoonMeshes=window.RealMoon.meshes.map(m=>({pos:buf(m.pos),nrm:buf(m.nrm),idx:buf(m.idx,gl.ELEMENT_ARRAY_BUFFER),count:m.idx.length}));
      const moonTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,moonTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,window.RealMoon.albedo);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
      const heightTextures=window.RealMoon.heightImages.map((image,i)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,i===0?gl.REPEAT:gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);return t});
      gl.bindTexture(gl.TEXTURE_2D,moonTexture);
      const anis=gl.getExtension('EXT_texture_filter_anisotropic');if(anis)gl.texParameterf(gl.TEXTURE_2D,anis.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(anis.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));

      function Builder() {
        const Pp = [], Nn = [], Cc = [];
        function tri(a, b, c, col) { const nn = norm(cross(sub(b, a), sub(c, a))); [a, b, c].forEach((p) => { Pp.push(p[0], p[1], p[2]); Nn.push(nn[0], nn[1], nn[2]); Cc.push(col[0], col[1], col[2]); }); }
        function q4(a, b, c, d, col) { tri(a, b, c, col); tri(a, c, d, col); }
        function cyl(r0, r1, y0, y1, seg, col, ox, oz) {
          ox = ox || 0; oz = oz || 0;
          for (let k = 0; k < seg; k++) {
            const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
            const p00 = [ox + r0 * Math.cos(a0), y0, oz + r0 * Math.sin(a0)], p01 = [ox + r0 * Math.cos(a1), y0, oz + r0 * Math.sin(a1)];
            const p10 = [ox + r1 * Math.cos(a0), y1, oz + r1 * Math.sin(a0)], p11 = [ox + r1 * Math.cos(a1), y1, oz + r1 * Math.sin(a1)];
            q4(p00, p10, p11, p01, col); tri([ox, y1, oz], p11, p10, col); tri([ox, y0, oz], p00, p01, col);
          }
        }
        function cylX(cx, cy, cz, r, w, seg, col) {
          for (let k = 0; k < seg; k++) {
            const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
            const p = (a, x) => [x, cy + r * Math.cos(a), cz + r * Math.sin(a)];
            const xl = cx - w / 2, xr = cx + w / 2;
            q4(p(a0, xl), p(a1, xl), p(a1, xr), p(a0, xr), col); tri([xl, cy, cz], p(a0, xl), p(a1, xl), col); tri([xr, cy, cz], p(a1, xr), p(a0, xr), col);
          }
        }
        function beam(a, b, w, col) {
          const ax = norm(sub(b, a)), t = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const u = scl(norm(cross(ax, t)), w), v = scl(norm(cross(ax, norm(cross(ax, t)))), w);
          const c = [add(add(a, u), v), add(sub(a, u), v), sub(sub(a, u), v), sub(add(a, u), v)], d = [add(add(b, u), v), add(sub(b, u), v), sub(sub(b, u), v), sub(add(b, u), v)];
          for (let k = 0; k < 4; k++) q4(c[k], c[(k + 1) % 4], d[(k + 1) % 4], d[k], col);
          q4(c[0], c[1], c[2], c[3], col); q4(d[0], d[1], d[2], d[3], col);
        }
        function box(cx, cy, cz, sx, sy, sz, col) {
          const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
          q4([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], col); q4([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], col);
          q4([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], col); q4([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col);
          q4([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], col); q4([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], col);
        }
        function done() { return { pos: buf(new Float32Array(Pp)), nrm: buf(new Float32Array(Nn)), col: buf(new Float32Array(Cc)), n: Pp.length / 3 }; }
        return { tri: tri, q4: q4, cyl: cyl, cylX: cylX, beam: beam, box: box, done: done };
      }
      const LM = (function () {
        const b = Builder(), gold = [0.74, 0.56, 0.2], white = [0.8, 0.81, 0.84], dark = [0.14, 0.14, 0.16], grey = [0.55, 0.56, 0.58];
        b.cyl(2.3, 2.3, 1.6, 3.4, 8, gold); b.cyl(1.75, 1.35, 3.4, 5.6, 12, white); b.cyl(0.55, 0.12, 5.6, 6.3, 10, grey); b.cyl(0.35, 0.8, 1.6, 0.9, 12, dark);
        for (let k = 0; k < 4; k++) {
          const a = Math.PI / 4 + k * Math.PI / 2, c = Math.cos(a), s = Math.sin(a), pad = [3.9 * c, 0.18, 3.9 * s];
          b.beam([1.9 * c, 2.9, 1.9 * s], pad, 0.11, grey); b.beam([2.1 * c, 1.7, 2.1 * s], pad, 0.07, grey);
          b.cyl(0.55, 0.55, 0, 0.15, 8, grey, pad[0], pad[2]);
        }
        return b.done();
      })();
      const RM_ = (function () {
        const b = Builder(), white = [0.84, 0.85, 0.87], dark = [0.09, 0.09, 0.1], gold = [0.74, 0.56, 0.2], panel = [0.07, 0.11, 0.26], grey = [0.5, 0.5, 0.52];
        b.box(0, 0.85, 0, 1.9, 0.35, 2.8, white); b.box(0, 1.08, -0.3, 1.5, 0.12, 1.6, gold);
        b.beam([0, 1.1, -0.4], [0, 1.42, -0.4], 0.06, grey); b.box(0, 1.46, -0.4, 2.3, 0.05, 1.7, panel);
        b.beam([0, 1.0, 1.1], [0, 2.0, 1.1], 0.05, grey); b.box(0, 2.08, 1.1, 0.5, 0.18, 0.22, white);
        b.box(-0.12, 2.08, 1.22, 0.1, 0.1, 0.03, dark); b.box(0.12, 2.08, 1.22, 0.1, 0.1, 0.03, dark);
        b.cyl(0.32, 0.04, 1.5, 1.75, 10, white, 0.65, -1.15);
        [-1.05, 0, 1.05].forEach((z) => [-1.12, 1.12].forEach((x) => { b.cylX(x, 0.38, z, 0.38, 0.3, 14, dark); b.beam([x * 0.75, 0.78, z], [x * 0.95, 0.42, z], 0.05, grey); }));
        return b.done();
      })();
      const PLM = (function () {
        const Pp = [], Tt = [], seg = 20, rings = 6;
        const ring = (t) => { const out = [], r = 0.8 + t * 2.2; for (let k = 0; k < seg; k++) { const a = k / seg * Math.PI * 2; out.push([r * Math.cos(a), -t, r * Math.sin(a), t]); } return out; };
        for (let rI = 0; rI < rings; rI++) {
          const A = ring(rI / rings), B = ring((rI + 1) / rings);
          for (let k = 0; k < seg; k++) { const k1 = (k + 1) % seg; [A[k], B[k], B[k1], A[k], B[k1], A[k1]].forEach((p) => { Pp.push(p[0], p[1], p[2]); Tt.push(p[3]); }); }
        }
        return { pos: buf(new Float32Array(Pp)), t: buf(new Float32Array(Tt)), n: Pp.length / 3 };
      })();
      // Lander flag decal: a procedural canvas texture (plain bold lettering, not any official insignia) on two opposite
      // flat faces of the octagonal descent stage. Built once; drawn with polygon offset so it never z-fights the hull.
      const LANDER_FLAG_TEXT = 'NASA';
      const FLAG = (function () {
        const vs = 'attribute vec3 aP; attribute vec2 aUV; attribute vec3 aN; uniform mat4 uPV; uniform mat4 uM; varying vec2 vUV; varying vec3 vN; varying vec3 vW;' +
          'void main(){ vec4 w = uM*vec4(aP, 1.0); vW = w.xyz; vN = (uM*vec4(aN, 0.0)).xyz; vUV = aUV; gl_Position = uPV*w; }';
        const fs = 'precision highp float; varying vec2 vUV; varying vec3 vN; varying vec3 vW; uniform sampler2D uTex; uniform vec3 uSun; uniform vec3 uCam; uniform float uLit;' +
          'void main(){ vec3 n = normalize(vN); vec3 v = normalize(uCam - vW); if (dot(n, v) < 0.0) n = -n;' +
          ' vec3 a = pow(texture2D(uTex, vUV).rgb, vec3(2.2))*0.85; float d = max(dot(n, uSun), 0.0)*uLit;' +
          ' vec3 col = a*(d*2.2 + 0.07 + 0.05*max(n.y, 0.0)); col = vec3(1.0) - exp(-col*1.6); gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), 1.0); }';
        const pr = prog(vs, fs);
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
        const c = cv.getContext('2d');
        c.fillStyle = '#f2f3f5'; c.fillRect(0, 0, 256, 128);
        c.fillStyle = '#123a8c'; c.fillRect(6, 6, 244, 116);
        c.fillStyle = '#c8202f'; c.fillRect(6, 104, 244, 10);
        c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
        let fsz = 76; c.font = '800 ' + fsz + 'px Helvetica, Arial, sans-serif';
        const tw = c.measureText(LANDER_FLAG_TEXT).width; if (tw > 210) { fsz = Math.floor(fsz * 210 / tw); c.font = '800 ' + fsz + 'px Helvetica, Arial, sans-serif'; }
        c.fillText(LANDER_FLAG_TEXT, 128, 58);
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D);
        const P3 = [], UV = [], N3 = [], ap = 2.3 * Math.cos(Math.PI / 8) + 0.02, hw = 0.72, hh = 0.36, yc = 2.5;
        [Math.PI / 8, Math.PI / 8 + Math.PI].forEach((t) => {
          const n = [Math.cos(t), 0, Math.sin(t)], r = [Math.sin(t), 0, -Math.cos(t)]; // r = viewer's right when facing the face from outside
          const pt = (sx, sy) => [n[0] * ap + r[0] * hw * sx, yc + hh * sy, n[2] * ap + r[2] * hw * sx];
          const q = [[pt(-1, -1), 0, 0], [pt(1, -1), 1, 0], [pt(1, 1), 1, 1], [pt(-1, -1), 0, 0], [pt(1, 1), 1, 1], [pt(-1, 1), 0, 1]];
          q.forEach((e) => { P3.push(e[0][0], e[0][1], e[0][2]); UV.push(e[1], e[2]); N3.push(n[0], n[1], n[2]); });
        });
        return { pr: pr, tex: tex, pos: buf(new Float32Array(P3)), uv: buf(new Float32Array(UV)), nrm: buf(new Float32Array(N3)), n: P3.length / 3 };
      })();
      function drawFlag(M, PV, cam, sunDir, lit) {
        const F = FLAG; gl.useProgram(F.pr.p);
        for (let i = 0; i < enabled.length; i++) gl.disableVertexAttribArray(enabled[i]);
        enabled = [];
        [['aP', F.pos, 3], ['aUV', F.uv, 2], ['aN', F.nrm, 3]].forEach((a) => { const loc = F.pr.a[a[0]]; if (loc === undefined || loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, a[1]); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, a[2], gl.FLOAT, false, 0, 0); enabled.push(loc); });
        U(F.pr, 'uPV', PV); U(F.pr, 'uM', M); U(F.pr, 'uSun', sunDir); U(F.pr, 'uCam', cam.eye); U(F.pr, 'uLit', lit);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tex); gl.uniform1i(F.pr.u.uTex, 0);
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2);
        gl.drawArrays(gl.TRIANGLES, 0, F.n);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      const DUST = (function () { const d = []; for (let i = 0; i < 700; i++) d.push(Math.random() * Math.PI * 2, 0.15 + Math.random() * 0.45, Math.random() * 1.4, Math.random()); return { b: buf(new Float32Array(d)), n: 700 }; })();

      const S = {
        view: 'region', W: 1, H: 1, dpr: 1, dirty: true, inited: false,
        rc: { yaw: 0, pitch: -0.95, dist: 2.3, tgt: [0, 0, -0.45] }, tc: { yaw: 0, pitch: 0.3, dist: 9, tgt: [0, 0.05, 0] }, dc: { yaw: 0, pitch: 0.2, dist: 0.014, hs: 0 },
        sunB: [1, 0, 0], earthB: [0, 1, 0], sites: [], sel: null, pick: false,
        tSun: { az: 0, el: 0, rad: 0.27 }, tEarth: { az: 0, el: 0, rad: 0.95 }, siteName: '', siteColor: '#fff', best: null,
        fly: null, fade: 0, fadeDir: 0, fadeCb: null, land: null, lander: null, dust0: -1, terr: null, terrKey: '', heatOn: false, hits: [],
        keys: {}, turbo: false, rover: null, spawn: null, hz: null, lastCb: 0
      };
      const fovR = 40 * D2R, fovT = 50 * D2R, fovD = 60 * D2R;

      function resize() {
        const w = Math.max(1, stageEl.clientWidth), h = Math.max(1, stageEl.clientHeight), dpr = Math.min(window.devicePixelRatio || 1, 1.75);
        if (w === S.W && h === S.H && dpr === S.dpr) return;
        S.W = w; S.H = h; S.dpr = dpr;
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr);
        S.dirty = true;
      }
      let ro = null;
      if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(stageEl); }
      resize();

      function siteVec(lat, lon) { return window.RealMoon.position(lat, lon); }
      function azelDir(az, el) { const a = az * D2R, e = el * D2R; return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)]; }
      // ---- terrain sampling ----
      function gridOf(x, z) { const d = S.terr.dem; return [(x + d.L / 2) / d.cell, (-z + d.L / 2) / d.cell]; }
      function bil(arr, N, fi, fj, stride4) {
        fi = clamp(fi, 0, N - 1.001); fj = clamp(fj, 0, N - 1.001);
        const i = Math.floor(fi), j = Math.floor(fj), wi = fi - i, wj = fj - j, k = stride4 || 1, b = j * N + i;
        return (arr[b * k] * (1 - wi) + arr[(b + 1) * k] * wi) * (1 - wj) + (arr[(b + N) * k] * (1 - wi) + arr[(b + N + 1) * k] * wi) * wj;
      }
      function groundAtW(x, z) { if (!S.terr) return 0; const g = gridOf(x, z); return bil(S.terr.dem.h, S.terr.dem.N, g[0], g[1]); }
      function shadeAtW(x, z) { if (!S.terr) return 1; const g = gridOf(x, z); return bil(S.terr.g.dat, S.terr.dem.N, g[0], g[1], 4); }
      function normalAtW(x, z) { const e = 0.004; return norm([-(groundAtW(x + e, z) - groundAtW(x - e, z)) / (2 * e), 1, -(groundAtW(x, z + e) - groundAtW(x, z - e)) / (2 * e)]); }
      function earthVisAtW(x, z) {
        const H = S.hz; if (!H) return true;
        const g = gridOf(x, z), ci = clamp(Math.round(g[0] / H.stride), 0, H.Nc - 1), cj = clamp(Math.round(g[1] / H.stride), 0, H.Nc - 1);
        const f = S.tEarth.az / 360 * H.B, k0 = Math.floor(f) % H.B, k1 = (k0 + 1) % H.B, w = f - Math.floor(f), b = (cj * H.Nc + ci) * H.B;
        return S.tEarth.el - (H.hm[b + k0] * (1 - w) + H.hm[b + k1] * w) > -S.tEarth.rad;
      }
      // The site pin: the patch centre, except in a roaming Drive window that has moved (ox, oy) km away from it.
      function pinGrid() { const d = S.terr.dem, c = (d.N - 1) / 2; return [c - (d.ox || 0) / d.cell, c - (d.oy || 0) / d.cell]; }
      function gridInside(i, j) { const n = S.terr.dem.N - 1; return i >= 0 && j >= 0 && i <= n && j <= n; }
      function gridToWorld(i, j) { const d = S.terr.dem; const x = -d.L / 2 + i * d.cell, z = -(-d.L / 2 + j * d.cell); return [x, groundAtW(x, z), z]; }

      // ---- cameras ----
      // Overview camera = a rigid rig {q: orientation, dist, tgt}; dragging rotates the
      // whole rig about the Moon's centre, so any longitude/latitude (and the far side) is reachable.
      const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
      const qaxis = (ax, an) => { const s = Math.sin(an / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(an / 2)]; };
      const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
      const qrot = (q, v) => { const x = q[0], y = q[1], z = q[2], w = q[3], ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2]; return [ix * w - iw * x - iy * z + iz * y, iy * w - iw * y - iz * x + ix * z, iz * w - iw * z - ix * y + iy * x]; };
      const qslerp = (a, b, t) => { let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; if (d < 0) { b = b.map((x) => -x); d = -d; } if (d > 0.9995) return qnorm(a.map((x, i) => x + (b[i] - x) * t)); const th = Math.acos(d), sn = Math.sin(th), wa = Math.sin((1 - t) * th) / sn, wb = Math.sin(t * th) / sn; return a.map((x, i) => x * wa + b[i] * wb); };
      function qfromBasis(r, u, f) {
        const tr = r[0] + u[1] + f[2];
        if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; return qnorm([(u[2] - f[1]) / s, (f[0] - r[2]) / s, (r[1] - u[0]) / s, 0.25 * s]); }
        if (r[0] > u[1] && r[0] > f[2]) { const s = Math.sqrt(1 + r[0] - u[1] - f[2]) * 2; return qnorm([0.25 * s, (u[0] + r[1]) / s, (f[0] + r[2]) / s, (u[2] - f[1]) / s]); }
        if (u[1] > f[2]) { const s = Math.sqrt(1 + u[1] - r[0] - f[2]) * 2; return qnorm([(u[0] + r[1]) / s, 0.25 * s, (f[1] + u[2]) / s, (f[0] - r[2]) / s]); }
        const s = Math.sqrt(1 + f[2] - r[0] - u[1]) * 2; return qnorm([(f[0] + r[2]) / s, (f[1] + u[2]) / s, 0.25 * s, (r[1] - u[0]) / s]);
      }
      function poseLook(eye, tgt, up) { const d = sub(eye, tgt), f = norm(d), r = norm(cross(up, f)), u = cross(f, r); return { q: qfromBasis(r, u, f), dist: Math.hypot(d[0], d[1], d[2]), tgt: tgt.slice() }; }
      function poseYP(yaw, pitch, dist, tgt) { const cp = Math.cos(pitch); return poseLook(add(tgt, scl([cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)], dist)), tgt, [0, 0, 1]); }
      function groundR(p) { const l = Math.hypot(p[0], p[1], p[2]) || 1; return 1 + window.RealMoon.sample(Math.asin(clamp(p[2] / l, -1, 1)) / D2R, Math.atan2(p[1], p[0]) / D2R) / window.RealMoon.R; }
      function regionCam() {
        const c = S.rc, back = qrot(c.q, [0, 0, 1]), up = qrot(c.q, [0, 1, 0]);
        let eye = add(c.tgt, scl(back, c.dist));
        const l = Math.hypot(eye[0], eye[1], eye[2]);
        let near = 0.002;
        if (c.low) { const g = groundR(eye), min = g + 0.00002; if (l < min) eye = scl(eye, min / l); near = clamp((Math.max(l, min) - g) * 0.3, 0.000005, 0.002); }
        else if (l < 1.02) eye = scl(eye, 1.02 / l);
        return { eye: eye, tgt: c.tgt, up: up, fov: c.low && c.fov ? c.fov : fovR, near: near, far: 1000 };
      }
      function rotateRegion(dx, dy) {
        const c = S.rc, cam = regionCam(), B = camBasis(cam), alt = Math.max(0.0003, Math.hypot(cam.eye[0], cam.eye[1], cam.eye[2]) - 0.995);
        const k = clamp(alt * cam.fov / Math.max(1, S.H), 0.000002, 0.004), R = qmul(qaxis(B.u, -dx * k), qaxis(B.r, -dy * k));
        c.q = qnorm(qmul(R, c.q)); c.tgt = qrot(R, c.tgt); S.dirty = true;
      }
      S.rc = poseYP(S.rc.yaw, S.rc.pitch, S.rc.dist, S.rc.tgt);
      function terrCam() {
        const c = S.tc, cp = Math.cos(c.pitch);
        const eye = add(c.tgt, scl([cp * Math.sin(c.yaw), Math.sin(c.pitch), -cp * Math.cos(c.yaw)], c.dist));
        const g = groundAtW(eye[0], eye[2]) + 0.03; if (eye[1] < g) eye[1] = g;
        return { eye: eye, tgt: c.tgt, up: [0, 1, 0], fov: fovT, near: 0.004, far: 220 };
      }
      function smoothDriveCamera(dt,now){if(!S.rover)return;const c=S.dc,R=S.rover;let dh=R.heading-c.hs;while(dh>Math.PI)dh-=2*Math.PI;while(dh< -Math.PI)dh+=2*Math.PI;c.hs+=dh*(1-Math.exp(-dt*10));if((Math.abs(R.v)>1e-7||Math.abs(S.cmd.steer)>0.05)&&!c.orbiting&&now>(c.manualUntil||0))c.yawTarget=0;c.yaw=lerp(c.yaw,c.yawTarget??c.yaw,1-Math.exp(-dt*10));c.pitch=lerp(c.pitch,c.pitchTarget??c.pitch,1-Math.exp(-dt*10));
        // The camera target trails the rover a little (at most 12 % of the camera distance), so pulling away, braking and bumps read
        // as motion instead of a rigid lock. A world re-centre (shiftTerrain) moves the rover by kilometres: keep the offset then.
        const o=c.off||(c.off=[0,0,0]),lp=c.lastPos||(c.lastPos=R.pos.slice()),k=Math.exp(-dt*9),far=Math.hypot(R.pos[0]-lp[0],R.pos[2]-lp[2])>0.5;let len=0;
        for(let a=0;a<3;a++){o[a]=(o[a]-(far?0:R.pos[a]-lp[a]))*k;lp[a]=R.pos[a];len+=o[a]*o[a];}
        len=Math.sqrt(len);const max=c.dist*0.12;if(len>max)for(let a=0;a<3;a++)o[a]*=max/len;}
      function driveCam() {
        const R = S.rover, c = S.dc, yaw = c.hs + Math.PI + c.yaw, cp = Math.cos(c.pitch);
        const tgt = add(c.off ? add(R.pos, c.off) : R.pos, [0, 0.0017, 0]);
        const eye = add(tgt, scl([Math.sin(yaw) * cp, Math.sin(c.pitch), -Math.cos(yaw) * cp], c.dist));
        const g = groundAtW(eye[0], eye[2]) + 0.0012; if (eye[1] < g) eye[1] = g;
        return { eye: eye, tgt: tgt, up: [0, 1, 0], fov: fovD, near: 0.0004, far: 60 };
      }
      function camBasis(cam) { const f = norm(sub(cam.tgt, cam.eye)), r = norm(cross(f, cam.up)), u = cross(r, f); return { f: f, r: r, u: u }; }

      function initRegion(focus) {
        const sl = Math.atan2(S.sunB[1], S.sunB[0]);
        if (focus) { const v = siteVec(focus.lat, focus.lon); S.rc = poseYP(Math.atan2(v[1], v[0]) + 0.3, -1.15, 0.9, scl(v, 0.98)); }
        else S.rc = poseYP(sl - 1.25, -0.92, 2.35, [0, 0, -0.6]); // aim lower so the south-polar sites sit clear of the timeline
        S.spin = null;
      }
      function terrainStart() { return { yaw: (S.tSun.az + 208) * D2R, pitch: 0.24, dist: 7.5, tgt: [0, 0.05, 0] }; }
      function initTerrain() { S.tc = terrainStart(); }
      function initDrive() {
        if (!S.terr) return;
        const p = S.spawn || [-(S.terr.dem.ox || 0), 0, S.terr.dem.oy || 0], h = (S.tSun.az + 180) * D2R;
        S.rover = { terrainKey:S.terrKey,pos: [p[0], groundAtW(p[0], p[2]), p[2]], heading: h, v: 0, batt: 80, dist: 0, sun: 1, earth: true, blocked: false, n: [0, 1, 0] };
        S.home??=p.slice();S.fadeR=0;
        S.dc = { yaw: 0,yawTarget:0, pitch: 0.2,pitchTarget:.2, dist: DRIVE_START_DISTANCE, hs: h };
        if (S.autopilot) setAutopilot(false, 'reset'); S.auto = null; S.brakeLatch = false; S.cmd = { thr: 0, steer: 0 }; S.driveAdvance = 0; // a new rover starts parked, under manual control
        try { ov.focus({ preventScroll: true }); } catch (err) { }
      }
      // Close fly ends exactly on the Terrain view's opening camera (same site frame, yaw,
      // pitch and distance), so the hand-over to the terrain mesh is a short cross-fade.
      function closePoses(lat, lon) {
        const la = lat * D2R, lo = lon * D2R, Rk = window.RealMoon.R / 1000, p0 = siteVec(lat, lon);
        const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], e = [-Math.sin(lo), Math.cos(lo), 0], n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
        const t = terrainStart(), cp = Math.cos(t.pitch), map = (X) => add(p0, scl(add(add(scl(e, X[0]), scl(u, X[1])), scl(n, -X[2])), 1 / Rk));
        const eyeT = [t.tgt[0] + t.dist * cp * Math.sin(t.yaw), t.tgt[1] + t.dist * Math.sin(t.pitch), t.tgt[2] - t.dist * cp * Math.cos(t.yaw)];
        const tg = map(t.tgt), hd = add(scl(e, Math.sin(t.yaw)), scl(n, Math.cos(t.yaw))), el = 1.1, mid = 0.07;
        return { mid: poseLook(add(tg, scl(add(scl(u, Math.sin(el)), scl(hd, Math.cos(el))), mid)), tg, u), end: poseLook(map(eyeT), tg, u) };
      }
      function flyTo(lat, lon, close, done) {
        const v = siteVec(lat, lon), la = lat * D2R, lo = lon * D2R, north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
        const from = { q: S.rc.q.slice(), dist: S.rc.dist, tgt: S.rc.tgt.slice() };
        let to;
        if (!close) { const dir = norm(add(v, scl(north, 0.75))); to = poseLook(add(v, scl(dir, 0.55)), v, [0, 0, 1]); }
        S.spin = null; S.rc.low = false;
        S.fly = { from: from, to: to, lat: lat, lon: lon, t0: performance.now(), dur: close ? 2300 : 1300, close: close, done: done };
        S.dirty = true;
      }
      function stepFly(F, p) {
        const e = ease(p), lerpPose = (a, b, t) => ({ q: qslerp(a.q, b.q, t), dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), t)), tgt: [0, 1, 2].map((k) => lerp(a.tgt[k], b.tgt[k], t)) });
        if (!F.close) { Object.assign(S.rc, lerpPose(F.from, F.to, e)); return; }
        const P = closePoses(F.lat, F.lon);
        Object.assign(S.rc, e < 0.5 ? lerpPose(F.from, P.mid, e / 0.5) : lerpPose(P.mid, P.end, (e - 0.5) / 0.5));
        S.rc.low = true; S.rc.fov = lerp(fovR, fovT, e);
      }

      // ---- terrain buffers ----
      // Vertex rows j0..j1 of the terrain mesh (also used to build a roaming window a few rows per frame, see stageTerrain).
      function fillTerrainRows(dem, pos, nrm, dat, j0, j1) {
        const N = dem.N, L = dem.L, c = dem.cell, h = dem.h;
        for (let j = j0; j < j1; j++) for (let i = 0; i < N; i++) {
          const v = j * N + i;
          pos[v * 3] = -L / 2 + i * c; pos[v * 3 + 1] = h[v]; pos[v * 3 + 2] = -(-L / 2 + j * c);
          const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jd = Math.max(0, j - 1), ju = Math.min(N - 1, j + 1);
          const dx = (h[j * N + ir] - h[j * N + il]) / ((ir - il) * c), dn = (h[ju * N + i] - h[jd * N + i]) / ((ju - jd) * c);
          const nn = norm([-dx, 1, dn]);
          nrm[v * 3] = nn[0]; nrm[v * 3 + 1] = nn[1]; nrm[v * 3 + 2] = nn[2]; dat[v * 4] = 1;
        }
      }
      function buildTerrain(dem) {
        const N = dem.N, Nv = N * N;
        const pos = new Float32Array(Nv * 3), nrm = new Float32Array(Nv * 3), dat = new Float32Array(Nv * 4), idx = new Uint32Array((N - 1) * (N - 1) * 6);
        fillTerrainRows(dem, pos, nrm, dat, 0, N);
        let k = 0;
        for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, cc = a + N, d = cc + 1; idx[k++] = a; idx[k++] = cc; idx[k++] = b; idx[k++] = b; idx[k++] = cc; idx[k++] = d; }
        return { pos: pos, nrm: nrm, dat: dat, idx: idx, Nv: Nv };
      }
      function uploadTerrain() {
        const T = S.terr;
        if (!T.bp) { T.bp = gl.createBuffer(); T.bn = gl.createBuffer(); T.bd = gl.createBuffer(); T.bi = gl.createBuffer(); }
        gl.bindBuffer(gl.ARRAY_BUFFER, T.bp); gl.bufferData(gl.ARRAY_BUFFER, T.g.pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, T.bn); gl.bufferData(gl.ARRAY_BUFFER, T.g.nrm, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, T.bd); gl.bufferData(gl.ARRAY_BUFFER, T.g.dat, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, T.bi); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, T.g.idx, gl.STATIC_DRAW);
      }

      // ---- drawing ----
      function drawSky(cam, B, ground, sunDir) {
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
        use(P.sky, [['aP', quad, 2]]);
        U(P.sky, 'uR', B.r); U(P.sky, 'uU', B.u); U(P.sky, 'uF', B.f); U(P.sky, 'uTan', Math.tan(cam.fov / 2)); U(P.sky, 'uAsp', S.W / S.H);
        U(P.sky, 'uGround', ground ? 1 : 0); U(P.sky, 'uSunDir', sunDir);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      function drawBB(PV, cam, B, dir, ang, mode, ground, sunDir, dist) {
        const c = add(cam.eye, scl(dir, dist));
        gl.enable(gl.BLEND);
        if (mode === 0) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        use(P.bb, [['aP', quad, 2]]);
        U(P.bb, 'uPV', PV); U(P.bb, 'uC', c); U(P.bb, 'uRt', B.r); U(P.bb, 'uUp', B.u); U(P.bb, 'uSize', dist * Math.tan(ang) / (mode === 0 ? 0.07 : 0.88));
        U(P.bb, 'uMode', mode); U(P.bb, 'uCamPos', cam.eye); U(P.bb, 'uGround', ground ? 1 : 0); U(P.bb, 'uSpin', performance.now() * 0.00003);
        U(P.bb, 'uSunL', norm([dot(sunDir, B.r), dot(sunDir, B.u), -dot(sunDir, dir)]));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.BLEND);
      }
      function mats(cam) { return mul(persp(cam.fov, S.W / S.H, cam.near, cam.far), lookAt(cam.eye, cam.tgt, cam.up)); }
      function drawObj(M, mesh, PV, cam, sunDir, lit) {
        use(P.obj, [['aP', mesh.pos, 3], ['aN', mesh.nrm, 3], ['aC', mesh.col, 3]]);
        U(P.obj, 'uPV', PV); U(P.obj, 'uM', M); U(P.obj, 'uSun', sunDir); U(P.obj, 'uCam', cam.eye); U(P.obj, 'uLit', lit);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.n);
      }
      function drawRegion() {
        const cam = regionCam(), B = camBasis(cam), PV = mats(cam), sun = norm(S.sunB), earth = norm(S.earthB);
        drawSky(cam, B, false, sun);
        drawBB(PV, cam, B, sun, 0.55 * D2R, 0, false, sun, 300);
        drawBB(PV, cam, B, earth, Math.asin(6378 / Math.hypot(S.earthB[0], S.earthB[1], S.earthB[2])) * 2.0, 1, false, sun, 300);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
        const alt=Math.hypot(cam.eye[0],cam.eye[1],cam.eye[2])-1;
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,moonTexture);
        for(const mesh of realMoonMeshes){
          use(P.moon,[['aP',mesh.pos,3],['aN',mesh.nrm,3]]);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh.idx);
          gl.uniform1i(P.moon.u.uAlbedo,0);for(let ti=0;ti<3;ti++){gl.activeTexture(gl.TEXTURE1+ti);gl.bindTexture(gl.TEXTURE_2D,heightTextures[ti]);gl.uniform1i(P.moon.u[['uHeightGlobal','uHeightPolar','uHeightFine'][ti]],ti+1)}gl.activeTexture(gl.TEXTURE0);
          U(P.moon,'uPV',PV);U(P.moon,'uSun',sun);U(P.moon,'uEarth',earth);U(P.moon,'uCam',cam.eye);
          U(P.moon,'uFineExtent',window.RealMoon.detailReady?163840:304000);U(P.moon,'uLineW',Math.max(.02,.16*alt));gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);
        }
        return { PV: PV, cam: cam, B: B };
      }
      function drawGround(cam, now) {
        const B = camBasis(cam), PV = mats(cam);
        const sunDir = azelDir(S.tSun.az, S.tSun.el), earDir = azelDir(S.tEarth.az, S.tEarth.el), D = cam.far * 0.7;
        drawSky(cam, B, true, sunDir);
        drawBB(PV, cam, B, sunDir, 0.55 * D2R, 0, true, sunDir, D);
        drawBB(PV, cam, B, earDir, S.tEarth.rad * 2.4 * D2R, 1, true, sunDir, D);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        const T = S.terr;
        if (T && T.bp) {
          use(P.ter, [['aP', T.bp, 3], ['aN', T.bn, 3], ['aD', T.bd, 4]]);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, T.bi);
          U(P.ter,'uTravel',0);/* Travel time is map-only: never paint the 3D ground. */ U(P.ter,'uSurfaceDetail',S.view==='drive'&&S.surfaceDetail!==false?1:0); U(P.ter, 'uShadeMix',Math.min(1,(performance.now()-(S.shadeAt||0))/250)); U(P.ter, 'uPV', PV); U(P.ter, 'uSun', sunDir); U(P.ter, 'uCam', cam.eye); U(P.ter, 'uHeat', S.heatOn ? 1 : 0); U(P.ter, 'uHalf', T.dem.L / 2);U(P.ter,'uOrigin',[T.dem.ox||0,-(T.dem.oy||0)]);U(P.ter,'uFade',S.view==='drive'&&S.rover&&S.fadeR>0?[S.rover.pos[0],S.rover.pos[2],S.fadeR]:[0,0,0]);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,T.imageTexture||moonTexture);gl.uniform1i(P.ter.u.uImagery,0);U(P.ter,'uHasImagery',T.imageTexture?1:0);
          // Stencil marks terrain pixels: the route ribbon is only drawn over ground, never over the sky behind a ridge.
          gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.drawElements(gl.TRIANGLES, T.g.idx.length, gl.UNSIGNED_INT, 0);
          gl.disable(gl.STENCIL_TEST);
        }
        drawNavigationGL(PV,cam);
        if (S.view === 'drive' && S.rover) {
          const R = S.rover, f0 = [Math.sin(R.heading), 0, -Math.cos(R.heading)];
          const fp = norm(sub(f0, scl(R.n, dot(f0, R.n)))), r = cross(R.n, fp);
          drawObj(basisModel(R.pos, r, R.n, fp, 0.001), RM_, PV, cam, sunDir, Math.max(0.04, R.sun));
        }
        if (S.lander && (S.land || !T || Math.max(Math.abs(S.lander.pos[0]), Math.abs(S.lander.pos[2])) < T.dem.L / 2)) { // not once Drive has roamed away from it
          const Lr = S.lander, M = model(Lr.pos, Lr.yaw, Lr.tilt, 0.001);
          drawObj(M, LM, PV, cam, sunDir, Lr.lit);
          drawFlag(M, PV, cam, sunDir, Lr.lit);
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
          if (Lr.thr > 0.01) {
            use(P.pl, [['aP', PLM.pos, 3], ['aT', PLM.t, 1]]);
            U(P.pl, 'uPV', PV); U(P.pl, 'uM', M); U(P.pl, 'uLen', 3 + 9 * Lr.thr); U(P.pl, 'uThr', Lr.thr); U(P.pl, 'uTime', now / 1000);
            gl.drawArrays(gl.TRIANGLES, 0, PLM.n);
          }
          if (S.dust0 > 0 && (now - S.dust0) / 1000 < 4.2) {
            use(P.du, [['aD', DUST.b, 4]]);
            U(P.du, 'uPV', PV); U(P.du, 'uO', [Lr.base[0], Lr.base[1] + 0.0005, Lr.base[2]]); U(P.du, 'uT', (now - S.dust0) / 1000); U(P.du, 'uS', 0.12);
            U(P.du, 'uPx', S.H * S.dpr / (2 * Math.tan(cam.fov / 2)));
            gl.drawArrays(gl.POINTS, 0, DUST.n);
          }
          gl.depthMask(true); gl.disable(gl.BLEND);
        }
        return { PV: PV, cam: cam, B: B, sunDir: sunDir, earDir: earDir };
      }

      // ---- overlay ----
      const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif';
      function toScreen(PV, p) { const q = proj(PV, p); if (q[2] <= 0) return null; return [(q[0] * 0.5 + 0.5) * S.W, (1 - (q[1] * 0.5 + 0.5)) * S.H, q[2]]; }
      function pill(x, y, text, opts) {
        opts = opts || {};
        const fs = opts.size || 12.5;
        g2.font = (opts.weight || '600') + ' ' + fs + 'px ' + FONT;
        const w = g2.measureText(text).width + 18, h = fs + 12;
        const px = opts.align === 'center' ? x - w / 2 : x, py = y - h / 2;
        g2.fillStyle = opts.bg || 'rgba(28,28,30,0.82)';
        g2.beginPath(); if (g2.roundRect) g2.roundRect(px, py, w, h, h / 2); else g2.rect(px, py, w, h); g2.fill();
        if (opts.dot) { g2.fillStyle = opts.dot; g2.beginPath(); g2.arc(px + 11, y, 3.5, 0, Math.PI * 2); g2.fill(); }
        g2.fillStyle = opts.color || '#F5F5F7'; g2.textBaseline = 'middle'; g2.textAlign = 'left'; g2.fillText(text, px + (opts.dot ? 19 : 9), y + 0.5);
        return [px, py, w + (opts.dot ? 10 : 0), h];
      }
      function overlap(a, b) { return !(a[0] + a[2] < b[0] || b[0] + b[2] < a[0] || a[1] + a[3] < b[1] || b[1] + b[3] < a[1]); }
      function scaleBar(pxKm, label) {
        const opts = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]; let km = opts[0];
        for (const k of opts) if (k * pxKm < 120) km = k;
        const bx = S.W - 230, by = S.H - 28, w = km * pxKm;
        if (S.W < 900) return;
        g2.strokeStyle = 'rgba(245,245,247,0.85)'; g2.lineWidth = 2; g2.lineCap = 'round';
        g2.beginPath(); g2.moveTo(bx, by - 4); g2.lineTo(bx, by); g2.lineTo(bx + w, by); g2.lineTo(bx + w, by - 4); g2.stroke();
        g2.font = '600 11px ' + FONT; g2.fillStyle = 'rgba(245,245,247,0.85)'; g2.textBaseline = 'bottom'; g2.textAlign = 'left';
        g2.fillText((km < 1 ? Math.round(km * 1000) + ' m' : km + ' km') + (label || ''), bx, by - 7);
      }
      function drawOverlayRegion(F, now) {
        S.hits = []; const placed = [], t = now / 1000;
        const pole = toScreen(F.PV, [0, 0, -1.002]);
        if (pole && dot([0, 0, -1], sub(F.cam.eye, [0, 0, -1])) > 0) {
          g2.strokeStyle = 'rgba(245,245,247,0.6)'; g2.lineWidth = 1.5; g2.beginPath(); g2.moveTo(pole[0] - 5, pole[1]); g2.lineTo(pole[0] + 5, pole[1]); g2.moveTo(pole[0], pole[1] - 5); g2.lineTo(pole[0], pole[1] + 5); g2.stroke();
          g2.font = '500 11px ' + FONT; g2.fillStyle = 'rgba(245,245,247,0.65)'; g2.textBaseline = 'top'; g2.textAlign = 'left'; g2.fillText('South Pole', pole[0] + 7, pole[1] + 4);
        }
        const list = S.sites.slice().sort((a, b) => (a.id === S.sel ? 1 : 0) - (b.id === S.sel ? 1 : 0));
        for (const s of list) {
          const v = siteVec(s.lat, s.lon), p = scl(v, 1.003), sc = toScreen(F.PV, p);
          if (!sc || dot(v, sub(F.cam.eye, p)) <= 0) continue;
          const sel = s.id === S.sel;
          if (sel) { const pr = 12 + 5 * (0.5 + 0.5 * Math.sin(t * 3)); g2.strokeStyle = s.color; g2.globalAlpha = 0.5; g2.lineWidth = 2; g2.beginPath(); g2.arc(sc[0], sc[1], pr, 0, Math.PI * 2); g2.stroke(); g2.globalAlpha = 1; }
          g2.fillStyle = '#fff'; g2.beginPath(); g2.arc(sc[0], sc[1], sel ? 8 : 6.5, 0, Math.PI * 2); g2.fill();
          g2.fillStyle = s.color; g2.beginPath(); g2.arc(sc[0], sc[1], sel ? 5.5 : 4.5, 0, Math.PI * 2); g2.fill();
          let ly = sc[1];
          g2.font = '600 12.5px ' + FONT;
          const w = g2.measureText(s.name).width + 18;
          let rect = [sc[0] + 14, ly - 12, w, 24];
          for (let k = 0; k < 6 && placed.some((r) => overlap(r, rect)); k++) { ly += 26; rect = [sc[0] + 14, ly - 12, w, 24]; }
          if (ly !== sc[1]) { g2.strokeStyle = 'rgba(245,245,247,0.35)'; g2.lineWidth = 1; g2.beginPath(); g2.moveTo(sc[0] + 7, sc[1]); g2.lineTo(sc[0] + 14, ly); g2.stroke(); }
          placed.push(pill(sc[0] + 14, ly, s.name, { bg: sel ? 'rgba(245,245,247,0.95)' : null, color: sel ? '#000' : null }));
          S.hits.push({ id: s.id, x: sc[0], y: sc[1] });
        }
        const dd = Math.hypot(...sub(F.cam.eye, F.cam.tgt));
        scaleBar(S.H / (2 * Math.tan(fovR / 2) * dd) / 1737.4, '');
      }
      function compass(F) {
        const eye = F.cam.eye, lbl = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        for (let k = 0; k < 8; k++) {
          const sc = toScreen(F.PV, add(eye, scl(azelDir(k * 45 + (S.northTurn || 0), 0), 50))); // northTurn: true north in a roaming window, degrees from grid north
          if (!sc || sc[0] < -20 || sc[0] > S.W + 20) continue;
          g2.font = (k % 2 ? '500 11px ' : '700 13px ') + FONT; g2.textAlign = 'center'; g2.textBaseline = 'bottom';
          g2.fillStyle = k === 0 ? '#FF6961' : 'rgba(245,245,247,0.65)'; g2.fillText(lbl[k], sc[0], sc[1] - 6);
          g2.textAlign = 'left';
        }
        const sunS = toScreen(F.PV, add(eye, scl(F.sunDir, 50)));
        if (sunS && sunS[0] > 0 && sunS[0] < S.W && sunS[1] > 0 && sunS[1] < S.H) pill(sunS[0], sunS[1] + 32, 'Sun', { align: 'center', color: '#F2C94C' });
        const earS = toScreen(F.PV, add(eye, scl(F.earDir, 50)));
        if (earS && earS[0] > 0 && earS[0] < S.W && earS[1] > 0 && earS[1] < S.H) pill(earS[0], earS[1] + 30, 'Earth', { align: 'center', color: '#8DB2E8' });
      }
      function waypoint(F, p, text, color, withDist) {
        const sc = toScreen(F.PV, add(p, [0, 0.004, 0]));
        if (!sc) return;
        g2.fillStyle = color; g2.beginPath(); g2.arc(sc[0], sc[1], 5, 0, Math.PI * 2); g2.fill();
        g2.strokeStyle = '#fff'; g2.lineWidth = 2; g2.stroke();
        let label = text;
        if (withDist && S.rover) { const d = Math.hypot(p[0] - S.rover.pos[0], p[2] - S.rover.pos[2]); label += ' · ' + (d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km'); }
        // Stack labels that would collide (rover, destination, pin, best spot) instead of drawing them over each other.
        g2.font = '600 12.5px ' + FONT;
        const lw = g2.measureText(label).width + 28, lh = 24.5, R = S.wpRects || (S.wpRects = []);
        let ly = sc[1] - 20;
        for (let k = 0; k < 4 && R.some((q) => overlap(q, [sc[0] - lw / 2, ly - lh / 2, lw, lh])); k++) ly -= lh + 4;
        R.push([sc[0] - lw / 2, ly - lh / 2, lw, lh]);
        if (ly !== sc[1] - 20) { g2.strokeStyle = 'rgba(255,255,255,0.55)'; g2.lineWidth = 1; g2.beginPath(); g2.moveTo(sc[0], sc[1] - 6); g2.lineTo(sc[0], ly + lh / 2); g2.stroke(); }
        pill(sc[0], ly, label, { align: 'center', dot: color });
      }
      function drawOverlayGround(F, now) {
        S.hits = [];
        S.wpRects = [];
        compass(F);
        if (!S.terr) return;
        const pg = pinGrid(), pin = gridToWorld(pg[0], pg[1]);

        if (S.view === 'terrain') {
          const b = toScreen(F.PV, pin), tp = toScreen(F.PV, add(pin, [0, 0.35, 0]));
          if (b && tp && gridInside(pg[0], pg[1])) {
            g2.strokeStyle = 'rgba(255,255,255,0.8)'; g2.lineWidth = 1.5; g2.beginPath(); g2.moveTo(b[0], b[1]); g2.lineTo(tp[0], tp[1]); g2.stroke();
            g2.fillStyle = S.siteColor; g2.beginPath(); g2.arc(b[0], b[1], 4, 0, Math.PI * 2); g2.fill();
            pill(tp[0], tp[1] - 12, S.siteName, { align: 'center', dot: S.siteColor });
          }
          if (S.best && S.heatOn) {
            const bp = toScreen(F.PV, gridToWorld(S.best.i, S.best.j));
            if (bp) { g2.strokeStyle = '#fff'; g2.lineWidth = 2.5; g2.beginPath(); g2.arc(bp[0], bp[1], 10, 0, Math.PI * 2); g2.stroke(); g2.fillStyle = '#fff'; g2.beginPath(); g2.arc(bp[0], bp[1], 2.5, 0, Math.PI * 2); g2.fill(); }
          }
          if (S.target) {
            const tp2 = toScreen(F.PV, gridToWorld(S.target.i, S.target.j));
            if (tp2) { g2.strokeStyle = '#FF9F0A'; g2.lineWidth = 3; g2.beginPath(); g2.arc(tp2[0], tp2[1], 11, 0, Math.PI * 2); g2.stroke(); g2.fillStyle = '#FF9F0A'; g2.beginPath(); g2.arc(tp2[0], tp2[1], 3, 0, Math.PI * 2); g2.fill(); pill(tp2[0], tp2[1] - 26, 'Your landing point', { align: 'center', dot: '#FF9F0A' }); }
          }
          scaleBar(S.H / (2 * Math.tan(fovT / 2) * Math.max(0.2, S.tc.dist)), ' at focus');
          if (S.land) {
            const alt = Math.max(0, (S.lander.pos[1] - S.lander.base[1]) * 1000);
            pill(S.W / 2, S.W > 900 ? 156 : 92, 'Illustrative descent · ' + Math.round(alt).toLocaleString('en-US') + ' m · ' + Math.abs(S.land.vs || 0).toFixed(0) + ' m/s down', { align: 'center', size: 13, color: '#FFD60A' });
          } else if (S.lander) pill(S.W / 2, S.W > 900 ? 156 : 92, 'Touchdown', { align: 'center', size: 13 });
        } else {
          if(S.dc.dist<=.1||!S.rover||Math.hypot(S.rover.pos[0]-pin[0],S.rover.pos[2]-pin[2])>.04)waypoint(F, pin, S.siteName, S.siteColor, true);
          if (S.best) waypoint(F, gridToWorld(S.best.i, S.best.j), 'Best landing spot', '#30D158', true);
          if (S.target) waypoint(F, gridToWorld(S.target.i, S.target.j), 'Destination', '#FF9F0A', true);
        if(S.view==='drive'&&S.rover&&S.dc.dist>.1){const p=toScreen(F.PV,add(S.rover.pos,[0,.002,0]));if(p){g2.beginPath();g2.arc(p[0],p[1],7,0,Math.PI*2);g2.fillStyle='#BF5AF2';g2.fill();g2.strokeStyle='#fff';g2.lineWidth=2;g2.stroke();g2.font='600 12.5px '+FONT;const rw=g2.measureText('Rover').width+28,R=S.wpRects||[];let ry=p[1]-12;for(let k=0;k<4&&R.some(q=>overlap(q,[p[0]+12,ry-12,rw,24.5]));k++)ry+=28.5;pill(p[0]+12,ry,'Rover',{dot:'#BF5AF2'});}}
        }
      }

      // ---- landing ----
      function startLanding() {
        const goal = S.target || S.best;
        if (!S.terr || !goal) return false;
        const T = gridToWorld(goal.i, goal.j), a = ILLUSTRATIVE_APPROACH_AZIMUTH * D2R, dh = [Math.sin(a), 0, -Math.cos(a)];
        S.descentTrail=[];S.trailEnded=0;
        S.land = { t0: performance.now(), T: T, P0: add(T, add(scl(dh, 2.8), [0, 2.1, 0])), P1: add(T, add(scl(dh, 1.2), [0, 1.3, 0])), P2: add(T, add(scl(dh, 0.12), [0, 0.45, 0])), P3: add(T, [0, 0.13, 0]), yaw: a, lastY: null, vs: 0 };
        S.dust0 = -1; S.landLit = Math.max(0.03, shadeAtW(T[0], T[2]));
        S.tc.yaw = a + 1.9; S.tc.pitch = 0.3; S.dirty = true;
        return true;
      }
      function bez(a, b, c, d, t) { const u = 1 - t; return [0, 1, 2].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]); }
      function stepLanding(now, dt) {
        const L = S.land, t = (now - L.t0) / 1000;
        let pos, tilt = 0, thr = 0;
        if (t < 6) { const p = ease(Math.min(1, t / 6)); pos = bez(L.P0, L.P1, L.P2, L.P3, p); tilt = -0.32 * (1 - p); thr = 0.65 + 0.3 * p; }
        else if (t < 8.4) { const p = (t - 6) / 2.4, e = 1 - Math.pow(1 - p, 2); pos = add(L.T, [0, 0.13 * (1 - e), 0]); thr = 0.95 - 0.35 * p; }
        else { pos = L.T.slice(); thr = 0; }
        if (t > 7.3 && S.dust0 < 0) S.dust0 = now;
        if (L.lastY !== null && dt > 0) L.vs = lerp(L.vs, (L.lastY - pos[1]) * 1000 / dt, 0.15);
        L.lastY = pos[1];
        if(!S.lastTrailPoint||now-S.lastTrailPoint>80){S.lastTrailPoint=now;S.descentTrail.push({pos:pos.slice(),time:now});}
        S.lander = { pos: pos, base: L.T, yaw: L.yaw, tilt: tilt, thr: thr, lit: S.landLit };
        S.tc.tgt = add(pos, [0, 0.003, 0]); S.tc.dist = Math.exp(lerp(Math.log(2.6), Math.log(0.045), ease(Math.min(1, t / 8.4)))); S.tc.yaw += dt * 0.12;
        if (t > 10.5) { S.trailEnded=now;S.land = null; S.spawn = add(L.T, [0.012, 0, 0.012]); cb.onLanded && cb.onLanded(); }
      }

      function beginTravelLabels(F){S.referenceBoxes=[];if(!S.terr)return;const pg=pinGrid();for(const q of [{i:pg[0],j:pg[1]},S.target].filter(Boolean)){const p=toScreen(F.PV,gridToWorld(q.i,q.j));if(p)S.referenceBoxes.push({l:p[0]-170,r:p[0]+170,t:p[1]-65,b:p[1]+12});}}
      function referencePill(x,y,text,options){const w=String(text).length*6.2+16,box={l:x-4,r:x+w,t:y-18,b:y+8};if((S.referenceBoxes||[]).some(q=>box.l<q.r+4&&box.r>q.l-4&&box.t<q.b+4&&box.b>q.t-4))return;S.referenceBoxes.push(box);pill(x,y,text,options);}
      const routeBuffers={body:{},head:{},trail:{}};
      function uploadRoute(target,points,base=0){if(points.length<2){target.count=0;target.total=base;return;}const p=[],prev=[],next=[],side=[],dist=[],togo=new Float64Array(points.length);togo[points.length-1]=base;for(let i=points.length-2;i>=0;i--){const a=points[i],b=points[i+1];togo[i]=togo[i+1]+Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);}target.total=togo[0];for(let i=0;i<points.length;i++)for(const s of [-1,1]){const a=points[i],b=points[Math.max(0,i-1)],c=points[Math.min(points.length-1,i+1)];p.push(a.x,a.y,a.z);prev.push(b.x,b.y,b.z);next.push(c.x,c.y,c.z);side.push(s);dist.push(togo[i]);}for(const [key,data]of Object.entries({p,prev,next,side,dist})){target[key]??=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,target[key]);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.DYNAMIC_DRAW);}target.count=side.length;}
      const BEACON_GLOW=[[14,.07],[7,.16],[3,.4],[1.4,.95]],BEACON_RINGS=[0,.5],ARRIVE_RINGS=[0,.18,.36];
      function drawRouteBeacon(F,now){const nav=S.navigation;if(S.view!=='drive'||!S.rover)return;const live=!!(nav?.points?.length&&S.navKey===nav.key&&S.navSamples?.length);if(!live)S.routeLeftText='';if(!live&&!(S.arrivedAt&&S.arrivedEnd&&now-S.arrivedAt<3600))return;const end=live?S.navSamples.at(-1):S.arrivedEnd,R=S.rover,kmh=Math.abs(R.v)*3600;if(kmh>.05)S.navKmh=S.navKmh?S.navKmh*.95+kmh*.05:kmh;const remain=Math.max(0,S.navRemain??Math.hypot(end.x-R.pos[0],end.z-R.pos[2])),fmtD=(km)=>km<1?Math.round(km*1000)+' m':km.toFixed(1)+' km',fmtT=(min)=>min<1?'<1 min':min<90?Math.round(min)+' min':(min/60).toFixed(1)+' h';
if(live&&S.navStartKey!==nav.key){S.navStartKey=nav.key;S.navStartAt=now;S.navStartDist=R.dist||0;S.arrivedAt=0;}
if(live&&!S.arrivedAt&&((remain<.02&&Math.hypot(end.x-R.pos[0],end.z-R.pos[2])<.04)||(R.arrived&&R.arrivedAt>=S.navStartAt))){S.arrivedAt=now;S.arrivedEnd=end;S.arrivedText='Arrived · '+fmtD(Math.max(S.navTotal||0,(R.dist||0)-S.navStartDist))+' · '+fmtT((now-S.navStartAt)/60000);}
const b=toScreen(F.PV,[end.x,end.y,end.z]),t=toScreen(F.PV,[end.x,end.y+.22,end.z]),pulse=.5+.5*Math.sin(now*.004),ring=(now%1600)/1600;g2.save();g2.lineCap='round';
if(b&&t){for(const [w,a] of BEACON_GLOW){g2.globalAlpha=a*(.7+.3*pulse);g2.strokeStyle=w<2?'#E8F7FF':'#7FD0FF';g2.lineWidth=w;g2.beginPath();g2.moveTo(b[0],b[1]);g2.lineTo(t[0],t[1]);g2.stroke();}const rs=Math.max(4,Math.min(40,Math.abs(t[1]-b[1])*.35));for(const k of BEACON_RINGS){const f=(ring+k)%1;g2.globalAlpha=.8*(1-f);g2.strokeStyle='#9FDcFF';g2.lineWidth=1.5;g2.beginPath();g2.ellipse(b[0],b[1],rs*(.3+f),rs*(.3+f)*.35,0,0,Math.PI*2);g2.stroke();}}
if(S.arrivedAt){const k=(now-S.arrivedAt)/1800;if(b&&k<1){for(const d of ARRIVE_RINGS){const f=Math.max(0,Math.min(1,k*1.4-d));if(f<=0||f>=1)continue;g2.globalAlpha=1-f;g2.strokeStyle='#BFEAFF';g2.lineWidth=3*(1-f)+1;g2.beginPath();g2.ellipse(b[0],b[1],20+140*f,(20+140*f)*.38,0,0,Math.PI*2);g2.stroke();}for(let i=0;i<12;i++){const a=i*Math.PI/6,r=18+90*Math.min(1,k*1.6);g2.globalAlpha=Math.max(0,1-k*1.3);g2.fillStyle='#E8F7FF';g2.beginPath();g2.arc(b[0]+Math.cos(a)*r,b[1]+Math.sin(a)*r*.5-30*k,2.2,0,Math.PI*2);g2.fill();}}const tk=(now-S.arrivedAt)/3600;if(tk<1){g2.globalAlpha=Math.min(1,tk*8,(1-tk)*5);g2.font='600 14px '+FONT;const w=g2.measureText(S.arrivedText).width+36,x=S.W/2-w/2,y=Math.round(S.H*.24)-8*Math.max(0,1-tk*6);g2.fillStyle='rgba(18,22,30,.86)';g2.strokeStyle='rgba(127,208,255,.7)';g2.lineWidth=1;g2.beginPath();g2.roundRect?g2.roundRect(x,y,w,34,17):g2.rect(x,y,w,34);g2.fill();g2.stroke();g2.fillStyle='#E8F7FF';g2.textAlign='center';g2.textBaseline='middle';g2.fillText('✓ '+S.arrivedText,S.W/2,y+17);}S.routeLeftText=tk<1?S.arrivedText:'';g2.restore();return;}
const text=fmtD(remain)+' left'+(S.navKmh>.05?' · '+fmtT(remain/S.navKmh*60):'');S.routeLeftText=text;const anchor=t||b;if(anchor&&anchor[0]>40&&anchor[0]<S.W-40&&anchor[1]>110&&anchor[1]<S.H-150){g2.globalAlpha=1;g2.font='600 12px '+FONT;const w=g2.measureText(text).width+22,x=Math.max(12,Math.min(S.W-w-12,anchor[0]-w/2)),y=Math.max(96,Math.min(S.H-190,anchor[1]-34));g2.fillStyle='rgba(18,22,30,.82)';g2.strokeStyle='rgba(127,208,255,.55)';g2.lineWidth=1;g2.beginPath();g2.roundRect?g2.roundRect(x,y,w,24,12):g2.rect(x,y,w,24);g2.fill();g2.stroke();g2.fillStyle='#E8F7FF';g2.textAlign='left';g2.textBaseline='middle';g2.fillText(text,x+11,y+12.5);}g2.restore();}
      function drawNavigationGL(PV,cam){const nav=S.navigation;if(!S.terr||!nav?.points?.length)return;if(S.navKey!==nav.key){S.navKey=nav.key;S.navProgress=0;S.navSamples=surfacePath(S.terr.dem,nav.points);S.navBodyKey='';}const points=S.navSamples;if(points.length<2)return;let start=S.navProgress||0;const live=S.rover?{x:S.rover.pos[0],z:S.rover.pos[2]}:points[start];if(S.rover){let best=Infinity;for(let k=start;k<Math.min(points.length-1,start+80);k++){const a=points[k],b=points[k+1],dx=b.x-a.x,dz=b.z-a.z,f=clamp(((live.x-a.x)*dx+(live.z-a.z)*dz)/(dx*dx+dz*dz||1),0,1),distance=Math.hypot(live.x-a.x-dx*f,live.z-a.z-dz*f);if(distance<best-1e-7){best=distance;start=k;}}S.navProgress=start;S.navCrossTrack=best;}const next=Math.min(points.length-1,start+1),key=S.navKey+'|'+next;if(S.navBodyKey!==key){uploadRoute(routeBuffers.body,points.slice(next));uploadRoute(routeBuffers.trail,points.slice(0,start+1),routeBuffers.body.total+Math.hypot(points[next].x-points[start].x,points[next].y-points[start].y,points[next].z-points[start].z));S.navBodyKey=key;}const g=gridOf(live.x,live.z);S.navUnsafe=false;const end=points[next],steps=Math.max(1,Math.ceil(Math.hypot(end.i-g[0],end.j-g[1])*3)),d=S.terr.dem;for(let s=0;s<=steps;s++){const i=g[0]+(end.i-g[0])*s/steps,j=g[1]+(end.j-g[1])*s/steps,k=Math.max(0,Math.min(d.N-1,Math.round(j)))*d.N+Math.max(0,Math.min(d.N-1,Math.round(i)));if(d.slope[k]>20){S.navUnsafe=true;S.navRenderedStart=null;return;}}uploadRoute(routeBuffers.head,surfacePath(S.terr.dem,[{i:g[0],j:g[1]},points[next]]),routeBuffers.body.total||0);S.navRemain=routeBuffers.head.count?routeBuffers.head.total:routeBuffers.body.total;S.navTotal=Math.max(S.navTotal&&S.navTotalKey===S.navKey?S.navTotal:0,routeBuffers.trail.count?routeBuffers.trail.total:S.navRemain);S.navTotalKey=S.navKey;S.navRenderedStart={x:live.x,z:live.z};S.navRenderedEnd=points.at(-1);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(false);gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.EQUAL,1,0xff);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);for(const mesh of [routeBuffers.trail,routeBuffers.body,routeBuffers.head]){if(!mesh.count)continue;const trail=mesh===routeBuffers.trail;use(P.route,[['aP',mesh.p,3],['aPrev',mesh.prev,3],['aNext',mesh.next,3],['aSide',mesh.side,1],['aDist',mesh.dist,1]]);U(P.route,'uPV',PV);U(P.route,'uCam',cam.eye);U(P.route,'uViewport',[S.W*S.dpr,S.H*S.dpr,1]);U(P.route,'uWidth',(trail?2.5:4.5)*S.dpr);U(P.route,'uTime',(performance.now()%100000)/1000);U(P.route,'uMode',trail?1:0);U(P.route,'uRemain',S.navRemain||0);gl.drawArrays(gl.TRIANGLE_STRIP,0,mesh.count);}gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.BLEND);gl.disable(gl.STENCIL_TEST);gl.depthMask(true);gl.depthFunc(gl.LESS);S.navigationDraws=(S.navigationDraws||0)+1;}
      function drawTripRoute(F){if(false)for(const p of S.travelGeoLabels||[]){const screen=toScreen(F.PV,gridToWorld(p.i,p.j));if(screen&&screen[0]>20&&screen[0]<S.W-180&&screen[1]>100&&screen[1]<S.H-200)referencePill(screen[0],screen[1],p.text,{size:10});}}
      function drawTravelReference(F){if(true||!S.terr)return;const N=S.terr.dem.N,stride=(N-1)/30;g2.lineWidth=1.5;let labels=new Set();for(const line of S.travelContours||[]){const a=toScreen(F.PV,gridToWorld(line.a[0]*stride,line.a[1]*stride)),b=toScreen(F.PV,gridToWorld(line.b[0]*stride,line.b[1]*stride));if(!a||!b)continue;g2.strokeStyle='rgba(255,255,255,.6)';g2.beginPath();g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);g2.stroke();if(!labels.has(line.hours)&&a[0]>30&&a[0]<S.W-180&&a[1]>100&&a[1]<S.H-200){referencePill(a[0],a[1],line.hours/24+' d',{size:11});labels.add(line.hours);}}/* No km grid: its screen-space lines crossed hills as grey stripes. */}

      function drawDescentTrail(F,now){const points=S.descentTrail;if(!points?.length)return;const fade=S.trailEnded?Math.max(0,1-(now-S.trailEnded)/6000):1;if(!fade)return;for(let i=1;i<points.length;i++){const a=toScreen(F.PV,points[i-1].pos),b=toScreen(F.PV,points[i].pos);if(!a||!b)continue;g2.globalAlpha=fade*(i/points.length)*.8;g2.strokeStyle='#F2C94C';g2.shadowColor='#FFD60A';g2.shadowBlur=8;g2.lineWidth=2;g2.beginPath();g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);g2.stroke();}g2.globalAlpha=fade;g2.shadowBlur=0;pill(S.W>900?24:18,S.W>900?S.H-96:S.H-220,'Illustrative descent path, not a computed trajectory',{size:11});g2.globalAlpha=1;}

      // ---- driving ----
      // Rover simulation. Motion and battery are integrated by rover-sim.mjs (driveFrame) from the simulated seconds the mission
      // clock advanced this frame (advanceDriveClock) — identically for the keyboard, the on-screen pad, the joystick and the
      // autopilot. The time multiplier only changes how many simulated seconds a frame covers, never the rover's speed.
      const noInput=()=>({up:false,down:false,left:false,right:false});
      S.pad=noInput();S.padHeld={};S.cmd={thr:0,steer:0};S.driveAdvance=0;S.autopilot=false;
      // Border of the loaded terrain window: stop there (never drive onto missing ground). The component loads the next window
      // well before this and re-centres the world around the rover (shiftTerrain), so normally the border is never reached.
      function roverConfine(nx,nz){const R=S.rover,lim=S.terr.dem.L/2-0.4;return (Math.abs(nx)>lim&&Math.abs(nx)>Math.abs(R.pos[0]))||(Math.abs(nz)>lim&&Math.abs(nz)>Math.abs(R.pos[2]))?[R.pos[0],R.pos[2],S.worldLimit?'world-edge':'world-edge-loading']:null;} // worldLimit: the roaming limit, no further window will load
      function roverSky(utc){const R=S.rover;return S.scienceAt?S.scienceAt(R.pos[0],R.pos[2],utc):null;}
      // Panel output (W) at the rover's position at a mission time. Hypothetical rover shared with the route planner (science-core
      // VEHICLE): 160 Wh battery, 0.5 m² sun-tracking panel at 28 % (about 190 W in full sun), 10 W idle load and +45 W while driving.
      function roverSolarW(utc){const sky=roverSky(utc);return sky?solarPower(sky.sun,sky.sunDirection?.dist||AU_KM):solarPower(clamp(shadeAtW(S.rover.pos[0],S.rover.pos[2]),0,1));}
      // All manual controls feed one command: keyboard (S.keys), on-screen pad (S.pad) and joystick (S.joyTarget).
      function driveInput(){const k=S.keys,p=S.pad,j=S.joyTarget||{x:0,y:0};return {thr:clamp((k.up||p.up?1:0)-(k.down||p.down?1:0)-j.y,-1,1),steer:clamp((k.right||p.right?1:0)-(k.left||p.left?1:0)+j.x,-1,1),brake:!!(k.brake||S.brakeHeld||S.brakeLatch)};}
      function releaseInputs(){S.keys={};S.pad=noInput();S.padHeld={};S.joyTarget={x:0,y:0};S.brakeHeld=false;}
      function setAutopilot(on,why){on=!!on;const R=S.rover;if(on){if(!R||!S.navigation?.points||S.navigation.points.length<2){on=false;if(R){R.autoStop='no-route';R.autoStopAt=performance.now();}}else{S.auto=null;S.brakeLatch=false;R.autoStop='';R.arrived=false;}}else if(S.autopilot&&R){R.autoStop=why||'off';R.autoStopAt=performance.now();}if(S.autopilot!==on){S.autopilot=on;cb.onAutopilot&&cb.onAutopilot(on,why||'');}return on;}
      // Route the autopilot follows: the rendered surface path when it is current (shiftTerrain keeps it in world coordinates), else our own.
      function autoRoute(R){const nav=S.navigation;if(!nav?.points||nav.points.length<2)return null;const A=S.auto||(S.auto={});let pts=S.navKey===nav.key&&S.navSamples?.length>1?S.navSamples:null;if(!pts){if(A.ownKey!==nav.key+'|'+S.terrKey){A.ownKey=nav.key+'|'+S.terrKey;A.own=surfacePath(S.terr.dem,nav.points);}pts=A.own;}if(A.pts!==pts||A.key!==nav.key){A.pts=pts;A.key=nav.key;A.next=routeStartIndex(pts,R.pos[0],R.pos[2]);}return pts.length>1?A:null;}
      function stepDrive(now, dt) {
        const R = S.rover; if (!R || !S.terr) return;
        const V=VEHICLE,cap=V.capacityWh,L=S.terr.dem.L,clock=S.simUTC;
        // Simulated seconds this frame: exactly what the component advanced the mission clock by. The rover keeps its own copy of
        // the clock; a lasting disagreement with the mission clock is a jump (timeline scrub, Skip to Earthrise) and only charges
        // or drains the parked rover. A one-frame disagreement (state hand-over at an hour boundary) is ignored.
        let simDt=S.drivePaused?0:S.driveAdvance,jumpS=0;S.driveAdvance=0;
        if(Number.isFinite(clock)){
          if(!Number.isFinite(R.clockUTC))R.clockUTC=clock;
          else{const expected=R.clockUTC+simDt*1000,diff=clock-expected;
            if(Math.abs(diff)<=1500+simDt){R.clockUTC=clock;R.clockOff=0;}
            else if((R.clockOff=(R.clockOff||0)+1)>=3){if(diff>0)jumpS=diff/1000;R.clockUTC=clock;R.clockOff=0;}
            else R.clockUTC=expected;}
        }
        const t=Number.isFinite(R.clockUTC)?R.clockUTC:clock;
        for(const name in S.padHeld){const q=S.padHeld[name];q.frames++;if(q.release&&q.frames>1&&now-q.at>=220){S.pad[name]=false;delete S.padHeld[name];}}
        const inp=driveInput(),manual=Math.abs(inp.thr)>ROVER.deadZone||Math.abs(inp.steer)>ROVER.deadZone;
        if(S.autopilot&&(manual||inp.brake))setAutopilot(false,manual?'manual':'brake');
        // Throttle and steering are eased in real time, so starts and stops look smooth at any multiplier; brake is immediate.
        const rdt=S.realDt||dt; // controls follow real elapsed time, also on slow frames
        S.cmd.thr=inp.brake?0:easeInput(S.cmd.thr,inp.thr,rdt);S.cmd.steer=easeInput(S.cmd.steer,inp.steer,rdt);
        let route=S.autopilot?autoRoute(R):null;
        // A route that disappears while the autopilot is on (replanning, a new terrain window) gets 8 s to come back.
        if(S.autopilot&&!route){S.autoLostAt??=now;if(now-S.autoLostAt>8000)setAutopilot(false,'no-route');}else S.autoLostAt=null;
        R.wants=manual||!!S.autopilot;
        // Steering is a real-time control; reversing steers like a car, and a parked rover pivots in place.
        const thr=S.cmd.thr,rolling=Math.abs(R.v)>1e-9,rev=R.v< -1e-9||(!rolling&&thr<0),turn=simDt>0&&!route?S.cmd.steer*rdt*(rolling||Math.abs(thr)>ROVER.deadZone?(rev?-1.1:1.1):0.7):0;
        const res=driveFrame(R,{throttle:thr,turn,brake:inp.brake,route,jumpS},simDt,{groundAt:groundAtW,confine:roverConfine,unlimited:S.drain===false,solarWAt:(ago)=>roverSolarW(t-ago*1000)});
        if(S.drivePaused)R.v=0;
        R.block=res.blocked||'';R.blocked=res.blocked==='too-steep';R.edge=res.blocked==='world-edge-loading'||res.blocked==='world-edge';R.slopeDeg=res.slopeDeg;R.remainingKm=route?res.remainingKm:0;
        if(res.movedKm>0)R.arrived=false;
        if(res.arrived){R.arrived=true;R.arrivedAt=now;setAutopilot(false,'arrived');}
        if(S.brakeLatch&&Math.abs(R.v)<=1e-9)S.brakeLatch=false;
        const nn = normalAtW(R.pos[0], R.pos[2]),nb=1-Math.exp(-dt*12);
        R.n = norm([lerp(R.n[0], nn[0], nb), lerp(R.n[1], nn[1], nb), lerp(R.n[2], nn[2], nb)]);
        const scientific=roverSky(t);
        R.sun=scientific?scientific.sun:clamp(shadeAtW(R.pos[0],R.pos[2]),0,1);
        R.earth=scientific?scientific.earth>.0005:earthVisAtW(R.pos[0],R.pos[2]);R.earthWhy=R.earth?'':(S.tEarth.el < -S.tEarth.rad?'below':'hill');
        const solarW=scientific?solarPower(scientific.sun,scientific.sunDirection?.dist||AU_KM):solarPower(R.sun),moving=Math.abs(R.v)>1e-9;
        R.solarW=solarW;R.loadW=V.idleW+(moving?V.driveW:0);R.netW=solarW-R.loadW;R.rate=R.netW/cap*100;
        forecastTick(R,now,moving?16:48);
        if (now - S.lastCb > 200) { S.lastCb = now; cb.onRover && cb.onRover({ x: R.pos[0], z: R.pos[2], heading: R.heading, batt: R.batt, rate: R.rate, netW: R.netW, solarW: R.solarW, loadW: R.loadW, sun: R.sun, earth: R.earth, earthWhy: R.earthWhy, kmh: Math.abs(R.v) * 3600, routeLeft: S.routeLeftText || '', dist: R.dist, blocked: R.blocked, edge: R.edge, status: roverStatus(now) }); }
        // Drive fades the ground out around the rover at the distance to the nearest border of the loaded window: it shrinks at once,
        // and grows back gradually after a re-centre, so far terrain fades in instead of popping.
        { const room = Math.max(0.4, L / 2 - Math.max(Math.abs(R.pos[0]), Math.abs(R.pos[2]))); S.fadeR = S.fadeR > 0 ? Math.min(room, S.fadeR + (room - S.fadeR) * (1 - Math.exp(-dt * 0.7))) : room; }
      }
      // What the battery does if the rover stays parked here (rover-sim forecastParked), up to the mission end (at most 60 days).
      // The solar input at the rover's spot is scanned a few samples per frame (the horizon-atlas lookup is too slow to look weeks
      // ahead inside one frame) and re-scanned when the rover has moved 8 m or the clock 15 min; the battery forecast itself then
      // only reads that cached series. `fresh` scans synchronously (button presses).
      function solarAtW(x,z,utc){const sky=S.scienceAt?S.scienceAt(x,z,utc):null;return sky?solarPower(sky.sun,sky.sunDirection?.dist||AU_KM):solarPower(clamp(shadeAtW(x,z),0,1));}
      function forecastTick(R,now,budget){
        const t=Number.isFinite(R.clockUTC)?R.clockUTC:S.simUTC;if(!Number.isFinite(t)||S.drain===false)return;
        const end=Number.isFinite(S.missionEndUTC)?S.missionEndUTC:t+30*86400000,F=R.fc;let J=R.fcJob;
        if(!J&&(!F||(now-F.at>400&&(Math.hypot(R.pos[0]-F.x,R.pos[2]-F.z)>0.008||t<F.t0||F.end!==end))||(now-F.at>1500&&t-F.t0>900000)))J=R.fcJob={x:R.pos[0],z:R.pos[2],t0:t,end,scan:createSolarScan(clamp((end-t)/1000,0,60*86400))};
        if(J&&advanceSolarScan(J.scan,(s)=>solarAtW(J.x,J.z,J.t0+s*1000),budget)){J.at=now;R.fc=J;R.fcJob=null;}
      }
      function roverForecast(R,now,fresh){
        const t=Number.isFinite(R.clockUTC)?R.clockUTC:S.simUTC;
        if(fresh){R.fc=null;R.fcJob=null;forecastTick(R,now,Infinity);}
        const F=R.fc;if(!F)return null;
        return forecastParked(R.batt/100*VEHICLE.capacityWh,(s)=>scanSolarW(F.scan,s+(t-F.t0)/1000),Math.max(0,(F.end-t)/1000));
      }
      const fmtWait=(min)=>min<1?'under a minute':min<90?Math.round(min)+' min':min<48*60?(min/60).toFixed(1)+' h':(min/1440).toFixed(1)+' days';
      // Machine-readable rover status for the UI (also delivered ~5x per second in onRover(...).status). See rover-control.mjs.
      function roverStatus(now,fresh){
        const R=S.rover;if(!R)return null;now??=performance.now();
        const V=VEHICLE,cap=V.capacityWh,wh=R.batt/100*cap,unlimited=S.drain===false,moving=Math.abs(R.v)>1e-9,inp=driveInput(),t=Number.isFinite(R.clockUTC)?R.clockUTC:S.simUTC;
        const f=unlimited?{nextSunS:0,fullS:0,emptyS:Infinity,restartS:0}:(roverForecast(R,now,fresh)||{nextSunS:NaN,fullS:NaN,emptyS:NaN,restartS:NaN,pending:true}),fin=(s)=>Number.isFinite(s)?s/60:null,utc=(s)=>Number.isFinite(s)?t+s*1000:null;
        const charging=!unlimited&&R.solarW>V.idleW+0.5,depleted=!unlimited&&!!R.depleted,noRoute=!S.autopilot&&R.autoStop==='no-route'&&now-(R.autoStopAt||0)<5000;
        const wants=!!S.autopilot||Math.abs(inp.thr)>ROVER.deadZone||Math.abs(inp.steer)>ROVER.deadZone;
        const reason=roverReason({moving,wants,missionEnded:!!S.missionEnded,paused:!!S.drivePaused||S.driveTimeScale===0,waiting:!!S.waitingCharge,depleted,charging,blocked:moving?'':R.block,autopilot:S.autopilot||noRoute,hasRoute:!noRoute&&!!(S.navigation?.points?.length>1),arrived:!!R.arrived&&now-(R.arrivedAt||0)<8000});
        const range=unlimited?Infinity:Math.max(0,wh-ROVER.emptyPct/100*cap)/(V.idleW+V.driveW)*V.flatSpeedKmh,sunHere=Number.isFinite(f.nextSunS);
        const strandedRisk=unlimited||charging||f.pending?'none':!sunHere?(depleted?'stranded':'no-sun'):'shadow';
        const metres=(km)=>km<1?Math.round(km*1000)+' m':km.toFixed(1)+' km',warning=strandedRisk==='no-sun'&&R.batt<40?'no-sun-low-battery':strandedRisk==='shadow'&&R.batt<20?'shadow-low-battery':'';
        const untilSun=sunHere?fmtWait(f.nextSunS/60):'',warningMessage=warning==='no-sun-low-battery'?'No sunlight reaches this spot before the mission ends. Battery '+Math.round(R.batt)+' % — about '+metres(range)+' of range left: drive back into sunlight.':warning?'In shadow: battery '+Math.round(R.batt)+' %, about '+metres(range)+' of range. The Sun returns here in '+untilSun+'.':'',message={
          'mission-ended':'Mission time is over. Extend the mission to keep driving.',
          'waiting-for-charge':'Fast-forwarding until the battery is full…',
          'paused':'Simulation paused. Press play or a drive control to continue.',
          'battery-empty':sunHere?'Battery empty. The Sun returns here in '+untilSun+'.':f.pending?'Battery empty.':'Battery empty and no sunlight reaches this spot before the mission ends. The rover is stranded.',
          'charging-wait':'Battery empty — recharging in sunlight. Driving resumes at '+ROVER.restartPct+' %'+(Number.isFinite(f.restartS)?' (about '+fmtWait(Math.max(0,f.restartS)/60)+')':'')+'.',
          'too-steep':'Too steep here (limit '+V.maxSlopeDeg+'°). Turn or back away.',
          'world-edge-loading':'Loading the next stretch of terrain…',
          'world-edge':'End of the mapped area: the terrain grid stops 300 km from the place. Turn back.',
          'route-blocked':'Autopilot stopped: the route crosses ground steeper than '+V.maxSlopeDeg+'°. Steer around it or pick another destination.',
          'no-route':S.autopilot?'Autopilot is waiting for the route…':'Autopilot needs a route. Choose a destination first.',
          'arrived':'Arrived at the destination.'}[reason]||'';
        return {moving,reason,message,warning,warningMessage,wantsToMove:wants,paused:!!S.drivePaused,missionEnded:!!S.missionEnded,missionEndUTC:Number.isFinite(S.missionEndUTC)?S.missionEndUTC:null,waitingForCharge:!!S.waitingCharge,utc:t,
          speedKmh:Math.abs(R.v)*3600,reversing:R.v< -1e-9,slopeDeg:R.slopeDeg||0,distKm:R.dist,timeScale:S.drivePaused?0:(S.driveTimeScale??60),maxTimeScale:driveScaleCap(),
          battPct:R.batt,batteryWh:wh,capacityWh:cap,unlimited,depleted,restartPct:ROVER.restartPct,solarW:R.solarW||0,loadW:R.loadW||0,netPowerW:unlimited?0:(R.netW||0),sunFraction:R.sun,sunlit:R.sun>0.02,charging,
          minutesToFull:unlimited?0:fin(f.fullS),fullUTC:unlimited?t:utc(f.fullS),minutesToEmpty:unlimited?null:(R.netW< -0.5?wh/-R.netW*60:fin(f.emptyS)),minutesToRestart:depleted?fin(f.restartS):0,
          canRechargeHere:unlimited||charging||(f.pending?null:sunHere),forecastPending:!!f.pending,minutesToSun:charging?0:fin(f.nextSunS),nextSunUTC:charging?t:utc(f.nextSunS),strandedRisk,rangeKm:range,
          autopilot:{engaged:!!S.autopilot,available:!!(S.navigation?.points?.length>1),remainingKm:S.autopilot?(R.remainingKm||0):0,etaMinutes:S.autopilot&&R.remainingKm?R.remainingKm/V.flatSpeedKmh*60:null,stopped:R.autoStop||''},
          earthVisible:!!R.earth};
      }
      // Fastest time multiplier that makes sense right now: by hand 1 s = 2 min, on autopilot 1 s = 1 h, parked 1 s = 1 day.
      function driveScaleCap(){const R=S.rover;if(!R||S.view!=='drive')return Infinity;if(S.autopilot)return ROVER.autoMaxScale;const i=driveInput();return Math.abs(i.thr)>ROVER.deadZone||Math.abs(i.steer)>ROVER.deadZone||Math.abs(R.v)>1e-9?ROVER.manualMaxScale:Infinity;}

      // ---- loop ----
      let raf = 0, last = performance.now(), alive = true, lastF = null, lastOv = 0;
      function frame(now) {
        if (!alive) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.1, (now - last) / 1000); S.realDt = Math.min(0.25, (now - last) / 1000); last = now;
        let anim = performance.now()-(S.shadeAt||0)<300;
        if (S.fly) {
          const F = S.fly, p = Math.min(1, (now - F.t0) / F.dur);
          stepFly(F, p);
          if (p >= 1) { S.fly = null; if (F.done) F.done(); }
          anim = true;
        }
        if (S.spin && S.view === 'region' && !drag) { rotateRegion(S.spin.dx * dt * 60, S.spin.dy * dt * 60); const k = Math.exp(-dt * 4); S.spin.dx *= k; S.spin.dy *= k; if (Math.abs(S.spin.dx) + Math.abs(S.spin.dy) < 0.05) S.spin = null; anim = true; }
        if (S.xfade) anim = true;
        if (S.fadeDir !== 0) {
          S.fade += S.fadeDir * dt / 0.35;
          if (S.fade >= 1) { S.fade = 1; S.fadeDir = 0; const f = S.fadeCb; S.fadeCb = null; if (f) f(); }
          if (S.fade <= 0) { S.fade = 0; S.fadeDir = 0; }
          anim = true;
        }
        if(S.trailEnded&&now-S.trailEnded<6000)anim=true;
        if (S.land) { stepLanding(now, dt); anim = true; }
        if (S.dust0 > 0 && now - S.dust0 < 4500) anim = true;
        if (S.view === 'drive' && S.rover) { if(S.dc.zoomTarget)S.dc.dist=lerp(S.dc.dist,S.dc.zoomTarget,1-Math.exp(-dt*16));stepDrive(now, dt);smoothDriveCamera(dt,now); anim = true; } else S.driveAdvance = 0;
        resize();
        if (!S.dirty && !anim) {
          if (S.view === 'region' && S.sel && lastF && !S.rc.low && now - lastOv > 33) { lastOv = now; g2.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); g2.clearRect(0, 0, S.W, S.H); drawOverlayRegion(lastF, now); }
          return;
        }
        S.dirty = false;
        gl.viewport(0, 0, cv.width, cv.height);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        g2.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); g2.clearRect(0, 0, S.W, S.H);
        if (S.view === 'region') {
          const F = drawRegion(), fp = S.fly && S.fly.close ? Math.min(1, (now - S.fly.t0) / S.fly.dur) : (S.rc.low ? 1 : 0);
          if (fp < 0.35) { if (fp > 0) g2.globalAlpha = 1 - fp / 0.35; drawOverlayRegion(F, now); g2.globalAlpha = 1; } else S.hits = [];
          lastF = F;
          if (S.rc.low) { const sn = S.snap || (S.snap = document.createElement('canvas')); if (sn.width !== cv.width || sn.height !== cv.height) { sn.width = cv.width; sn.height = cv.height; } sn.getContext('2d').drawImage(cv, 0, 0); S.snapAt = now; }
        }
        else { const cam = S.view === 'drive' && S.rover ? driveCam() : terrCam(); const F = drawGround(cam, now); drawOverlayGround(F, now); beginTravelLabels(F); drawTripRoute(F); drawTravelReference(F); drawDescentTrail(F,now); drawRouteBeacon(F,now); lastF = null; }
        if (S.xfade) { const a = 1 - (now - S.xfade.t0) / S.xfade.dur; if (a > 0 && S.snap) { g2.globalAlpha = a * a * (3 - 2 * a); g2.drawImage(S.snap, 0, 0, S.W, S.H); g2.globalAlpha = 1; } else S.xfade = null; }
        if (S.fade > 0) { g2.fillStyle = 'rgba(0,0,0,' + S.fade.toFixed(3) + ')'; g2.fillRect(0, 0, S.W, S.H); }
      }
      raf = requestAnimationFrame(frame);

      // ---- input ----
      let drag = null;const touches=new Map();let pinch=0;
      function onDown(e) { S.spin = null; if(S.view==='drive'){S.dc.orbiting=true;S.dc.manualUntil=performance.now()+1200;} touches.set(e.pointerId,[e.clientX,e.clientY]);if(touches.size===2){const a=[...touches.values()];pinch=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);drag=null;return;} drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey }; try { ov.setPointerCapture(e.pointerId); } catch (err) { } }
      function onMove(e) {
        if(touches.has(e.pointerId))touches.set(e.pointerId,[e.clientX,e.clientY]);
        if(touches.size===2){const a=[...touches.values()],distance=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);if(pinch>0)zoom(pinch/Math.max(1,distance));pinch=distance;return;}
        if (!drag) { if (S.view === 'region') { const rect = ov.getBoundingClientRect(), h = hitAt(e.clientX - rect.left, e.clientY - rect.top); ov.style.cursor = h ? 'pointer' : (S.pick ? 'crosshair' : ''); } return; }
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        drag.x = e.clientX; drag.y = e.clientY;
        if (!drag.moved) return;
        S.fly = null;
        if (S.view === 'region') { if (S.rc.low) { S.rc.low = false; S.rc.dist = Math.max(S.rc.dist, 0.03); } rotateRegion(dx, dy); const t = performance.now(), w = Math.min(1, (t - (drag.t || t)) / 16 || 1); drag.vx = lerp(drag.vx || 0, dx, Math.max(0.35, w)); drag.vy = lerp(drag.vy || 0, dy, Math.max(0.35, w)); drag.t = t; }
        else if (S.view === 'drive') { S.dc.yawTarget=(S.dc.yawTarget??S.dc.yaw)-dx*.006;S.dc.pitchTarget=clamp((S.dc.pitchTarget??S.dc.pitch)+dy*.004,.02,1.4);S.dc.manualUntil=performance.now()+1200; }
        else if (drag.pan) {
          const yw = S.tc.yaw, s = S.tc.dist * 0.0016, r = [Math.cos(yw), 0, Math.sin(yw)], f = [-Math.sin(yw), 0, Math.cos(yw)];
          S.tc.tgt = add(S.tc.tgt, add(scl(r, -dx * s), scl(f, -dy * s)));
          S.tc.tgt[0] = clamp(S.tc.tgt[0], -7, 7); S.tc.tgt[2] = clamp(S.tc.tgt[2], -7, 7); S.tc.tgt[1] = groundAtW(S.tc.tgt[0], S.tc.tgt[2]) + 0.05;
        } else { S.tc.yaw += dx * 0.006; S.tc.pitch = clamp(S.tc.pitch + dy * 0.005, 0.03, 1.45); }
        S.dirty = true;
      }
      function hitAt(x, y) { let best = null, bd = 20; for (const h of S.hits) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } } return best; }
      function onUp(e) { S.dc.orbiting=false;touches.delete(e.pointerId);if(pinch){pinch=0;drag=null;return;}
        const d = drag; drag = null;
        if (d && d.moved && S.view === 'region' && d.t && performance.now() - d.t < 80 && Math.abs(d.vx) + Math.abs(d.vy) > 2) S.spin = { dx: d.vx, dy: d.vy };
        if (!d || d.moved) return;
        const rect = ov.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
        if ((S.view === 'terrain' || (S.view === 'drive' && S.rover)) && S.terr && !S.land) {
          const cam = S.view === 'drive' ? driveCam() : terrCam(), B = camBasis(cam), tn = Math.tan(cam.fov / 2), asp = S.W / S.H, nx = x / S.W * 2 - 1, ny = 1 - y / S.H * 2;
          const dir = norm(add(B.f, add(scl(B.r, nx * tn * asp), scl(B.u, ny * tn))));
          let t = 0, prev = 0, hit = null;
          for (let k = 0; k < 600 && t < 60; k++) {
            const p = add(cam.eye, scl(dir, t));
            if (p[1] < groundAtW(p[0], p[2])) { let a = prev, b = t; for (let m = 0; m < 16; m++) { const c = (a + b) / 2, q = add(cam.eye, scl(dir, c)); if (q[1] < groundAtW(q[0], q[2])) b = c; else a = c; } hit = add(cam.eye, scl(dir, b)); break; }
            prev = t; t += Math.max(0.004, t * 0.01);
          }
          if (hit) { const L = S.terr.dem.L; if (Math.abs(hit[0]) < L / 2 - 0.1 && Math.abs(hit[2]) < L / 2 - 0.1) { const g = gridOf(hit[0], hit[2]); cb.onTarget && cb.onTarget(Math.round(g[0]), Math.round(g[1])); } }
          return;
        }
        if (S.view !== 'region') return;
        const h = hitAt(x, y);
        if (h) { cb.onSelect && cb.onSelect(h.id); return; }
        if (S.pick) {
          const cam = regionCam(), B = camBasis(cam), tn = Math.tan(cam.fov / 2), asp = S.W / S.H, nx = x / S.W * 2 - 1, ny = 1 - y / S.H * 2;
          const dir = norm(add(B.f, add(scl(B.r, nx * tn * asp), scl(B.u, ny * tn))));
          const b = dot(cam.eye, dir), c = dot(cam.eye, cam.eye) - 1, disc = b * b - c;
          if (disc > 0) { const t = -b - Math.sqrt(disc), p = norm(add(cam.eye, scl(dir, t))); cb.onPick && cb.onPick(Math.asin(p[2]) / D2R, Math.atan2(p[1], p[0]) / D2R); }
        }
      }
      function onDbl(e) { if (S.view !== 'region') return; const rect = ov.getBoundingClientRect(), h = hitAt(e.clientX - rect.left, e.clientY - rect.top); if (h) cb.onOpen && cb.onOpen(h.id); }
      function zoom(k) {
        if (S.view === 'region') {
          if (S.rc.low) { S.rc.low = false; S.rc.dist = Math.max(S.rc.dist, 0.03); }
          // Zoom towards the surface point in the middle of the view, not a point inside the Moon.
          const cam = regionCam(), f = norm(sub(cam.tgt, cam.eye)), bq = dot(cam.eye, f), cq = dot(cam.eye, cam.eye) - 1, disc = bq * bq - cq;
          if (disc > 0 && -bq - Math.sqrt(disc) > 0) { const t = -bq - Math.sqrt(disc); S.rc.tgt = add(cam.eye, scl(f, t)); S.rc.dist = t; }
          S.rc.dist = clamp(S.rc.dist * k, 0.15, 6); // closer than ~250 km the global texture is only blur; pins fly into Terrain for detail
        }
        else if (S.view === 'drive') S.dc.zoomTarget = clamp((S.dc.zoomTarget || S.dc.dist) * k, 0.005, 24);
        else S.tc.dist = clamp(S.tc.dist * k, 0.05, 30);
        S.dirty = true;
      }
      function onWheel(e) { e.preventDefault(); S.fly = null; zoom(Math.exp(clamp(e.deltaY * 0.0012, -0.5, 0.5))); }
      const KEYMAP = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ' ': 'brake', x: 'brake', X: 'brake' };
      // Listen on window, not only the canvas: after clicking », Route here or the map the canvas loses focus and the keys used to stop working.
      function onKey(e, on) { const m = KEYMAP[e.key]; if (!m || S.view !== 'drive') return; if (!on) { S.keys[m] = false; return; } const t = e.target; if (e.ctrlKey || e.metaKey || e.altKey || (t && t.closest && t.closest('input,select,textarea,[contenteditable],[role=dialog],[aria-modal=true],.route-page,.tour-card')) || document.querySelector('.bigmap.route-page')) return; if (e.key === ' ' && t && t.closest && t.closest('button,a,summary,[role=button],[role=slider],[role=tab]')) return; /* Space on a focused control keeps its normal meaning */ e.preventDefault(); if (m === 'brake') { if (!S.keys.brake) { S.brakeLatch = true; cb.onBrake && cb.onBrake(); } } else if (!S.keys[m]) cb.onDriveInput && cb.onDriveInput(); S.keys[m] = true; }
      const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false), blur = () => { releaseInputs(); }, noCtx = (e) => e.preventDefault();
      ov.addEventListener('pointerdown', onDown); ov.addEventListener('pointermove', onMove); ov.addEventListener('pointerup', onUp);
      ov.addEventListener('pointercancel', e => {S.dc.orbiting=false;touches.delete(e.pointerId);pinch=0;drag=null;}); ov.addEventListener('lostpointercapture', e => {S.dc.orbiting=false;touches.delete(e.pointerId);pinch=0;drag=null;}); ov.addEventListener('dblclick', onDbl); ov.addEventListener('wheel', onWheel, { passive: false });
      ov.addEventListener('contextmenu', noCtx); window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', blur);

      return {
        set(o) { Object.assign(S, o); if (!S.inited && o.sunB) { S.inited = true; initRegion(null); } S.dirty = true; },
        setView(v) {
          if (v === S.view) return;
          const prev = S.view;
          S.view = v; S.fly = null; releaseInputs(); if (S.autopilot) setAutopilot(false, 'view');
          if (v !== 'terrain') { if (S.land) S.descentTrail = null; S.land = null; } // an interrupted descent leaves no trail behind
          if (v === 'terrain') { if (prev !== 'drive') initTerrain(); else if (S.rover) { S.tc.tgt = add(S.rover.pos, [0, 0.05, 0]); S.tc.dist = 2.5; } }
          else if (v === 'drive') {if(!S.rover||S.rover.terrainKey!==S.terrKey)initDrive();else{S.dc.yawTarget=0;S.dc.zoomTarget=DRIVE_START_DISTANCE;}}
          else { const s = S.sites.find((x) => x.id === S.sel); initRegion(s || null); S.lander = null; }
          if (prev === 'region' && S.snap && S.rc.low && performance.now() - (S.snapAt || 0) < 4000) { S.xfade = { t0: performance.now(), dur: 650 }; S.fade = 0; S.fadeDir = 0; }
          else { S.xfade = null; S.fade = 1; S.fadeDir = -1; }
          S.dirty = true;
        },
        refreshMoon(){const models=window.RealMoon.meshes;for(let i=0;i<models.length;i++){const m=models[i],old=realMoonMeshes[i]||{pos:gl.createBuffer(),nrm:gl.createBuffer(),idx:gl.createBuffer()};for(const [key,data,target] of [['pos',m.pos,gl.ARRAY_BUFFER],['nrm',m.nrm,gl.ARRAY_BUFFER],['idx',m.idx,gl.ELEMENT_ARRAY_BUFFER]]){gl.bindBuffer(target,old[key]);gl.bufferData(target,data,gl.STATIC_DRAW);}old.count=m.idx.length;realMoonMeshes[i]=old;}gl.bindTexture(gl.TEXTURE_2D,moonTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,window.RealMoon.albedo);gl.generateMipmap(gl.TEXTURE_2D);window.RealMoon.heightImages.forEach((image,i)=>{gl.bindTexture(gl.TEXTURE_2D,heightTextures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);});S.dirty=true;},
        terrainKey() { return S.terrKey; },
        setTerrain(dem, key) {
          S.terrKey = key; S.land = null; S.lander = null; S.dust0 = -1; S.best = null; S.spawn = null; S.home=null;S.navigation=null;S.hz = null;
          const old = S.terr;
          S.terr = { dem: dem, g: buildTerrain(dem), bp: old ? old.bp : null, bn: old ? old.bn : null, bd: old ? old.bd : null, bi: old ? old.bi : null };
          if(old&&old.imageTexture)gl.deleteTexture(old.imageTexture);if(dem.imagery){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,dem.imagery);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);S.terr.imageTexture=t;}
          uploadTerrain(); S.heatOn = false;
          if (S.view === 'terrain') initTerrain(); else if (S.view === 'drive') initDrive();
          S.dirty = true;
        },
        // Drive roaming: swap in the next terrain window (same grid, centre moved by sx km east / sy km north) without resetting
        // anything. Every world-space quantity moves by the opposite amount, and overlapping vertices keep their data, so the
        // rover, camera, route and lighting stay exactly where they were on screen.
        // Build the next window's mesh ahead of shiftTerrain, a few milliseconds per call; true once it is complete (null cancels).
        stageTerrain(dem, budgetMs) {
          if (!dem) { S.staged = null; return true; }
          let st = S.staged; const N = dem.N;
          if (!st || st.dem !== dem) {
            st = S.staged = { dem: dem, row: 0, g: null };
            if (S.terr && S.terr.dem.N === N) st.g = { pos: new Float32Array(N * N * 3), nrm: new Float32Array(N * N * 3), dat: new Float32Array(N * N * 4), idx: S.terr.g.idx, Nv: N * N }; // same triangles
            else { st.g = buildTerrain(dem); st.row = N; }
          }
          const t0 = performance.now();
          while (st.row < N && performance.now() - t0 < (budgetMs || 4)) { const j1 = Math.min(N, st.row + 12); fillTerrainRows(dem, st.g.pos, st.g.nrm, st.g.dat, st.row, j1); st.row = j1; }
          return st.row >= N;
        },
        shiftTerrain(dem, key, sx, sy, shade) {
          const old = S.terr; if (!old || S.land) return false;
          const g = S.staged && S.staged.dem === dem && S.staged.row >= dem.N ? S.staged.g : buildTerrain(dem), N = dem.N, od = old.g.dat, dat = g.dat, same = old.dem.N === N;
          const di = Math.round(sx / dem.cell), dj = Math.round(sy / dem.cell);
          for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const v = (j * N + i) * 4, oi = i + di, oj = j + dj;
            if (same && oi >= 0 && oj >= 0 && oi < N && oj < N) { const o = (oj * N + oi) * 4; dat[v] = od[o]; dat[v + 1] = od[o + 1]; dat[v + 2] = od[o + 2]; dat[v + 3] = od[o + 3]; }
            else { const lit = shade ? shade[j * N + i] : 1; dat[v] = lit; dat[v + 2] = lit; dat[v + 3] = -1; }
          }
          S.staged = null; S.terr = { dem: dem, g: g, bp: old.bp, bn: old.bn, bd: old.bd, bi: old.bi }; S.terrKey = key; S.hz = null;
          if (old.imageTexture) gl.deleteTexture(old.imageTexture);
          if (dem.imagery) { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, dem.imagery); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D); S.terr.imageTexture = t; }
          { const T = S.terr; gl.bindBuffer(gl.ARRAY_BUFFER, T.bp); gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, T.bn); gl.bufferData(gl.ARRAY_BUFFER, g.nrm, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, T.bd); gl.bufferData(gl.ARRAY_BUFFER, g.dat, gl.DYNAMIC_DRAW);
            if (g.idx !== old.g.idx) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, T.bi); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.STATIC_DRAW); } }
          const seen = new Set(), move = (p) => { if (!p || seen.has(p)) return; seen.add(p); if (Array.isArray(p)) { p[0] -= sx; p[2] += sy; } else { if (Number.isFinite(p.x)) { p.x -= sx; p.z += sy; } if (Number.isFinite(p.i)) { p.i -= di; p.j -= dj; } } };
          if (S.rover) { move(S.rover.pos); S.rover.terrainKey = key; S.rover.edge = false; }
          move(S.home); move(S.spawn); move(S.tc.tgt); move(S.best); move(S.target);
          if (S.lander) { move(S.lander.pos); move(S.lander.base); }
          for (const q of S.descentTrail || []) move(q.pos);
          for (const q of S.navSamples || []) move(q);
          move(S.navRenderedStart); move(S.navRenderedEnd); S.navBodyKey = '';
          S.dirty = true; return true;
        },
        setHorizon(hm, Nc, B, stride) { S.hz = { hm: hm, Nc: Nc, B: B, stride: stride }; },
        setShade(arr) { if (!S.terr) return; const d = S.terr.g.dat,mix=Math.min(1,(performance.now()-(S.shadeAt||0))/250);for(let i=0;i<arr.length;i++){d[i*4+2]=d[i*4+2]+(d[i*4]-d[i*4+2])*mix;d[i*4]=arr[i];}S.shadeAt=performance.now(); gl.bindBuffer(gl.ARRAY_BUFFER, S.terr.bd); gl.bufferSubData(gl.ARRAY_BUFFER, 0, d); S.dirty = true; },
        setHeat(arr) {
          if (!S.terr) return; const d = S.terr.g.dat; S.heatOn = !!arr;
          if (arr) { for (let i = 0; i < arr.length; i++) d[i * 4 + 1] = arr[i]; gl.bindBuffer(gl.ARRAY_BUFFER, S.terr.bd); gl.bufferSubData(gl.ARRAY_BUFFER, 0, d); }
          S.dirty = true;
        },
        flyTo(lat, lon, close, done) { if (S.view !== 'region') { if (done) done(); return; } flyTo(lat, lon, close, done); },
        land() { return startLanding(); },
        key(name, on) { S.keys[name] = on; },
        // On-screen drive pad (held like a key) and joystick (x right, y down, each -1..1).
        // A quick tap still nudges the rover: a press lasts at least 220 ms and one simulation frame (see stepDrive).
        pad(name, on) { if (on) { S.pad[name] = true; S.padHeld[name] = { at: performance.now(), frames: 0, release: false }; } else if (S.padHeld[name]) S.padHeld[name].release = true; else S.pad[name] = false; },
        joystick(x,y){S.joyTarget={x,y};},
        // brake(): stop now — cancels the autopilot, drops held on-screen inputs and brakes until the rover is at rest.
        // brake(true)/brake(false): press / release a held brake (Space key, Stop button).
        brake(held) { if (held === false) { S.brakeHeld = false; return; } S.brakeHeld = held === true; S.brakeLatch = true; S.pad = noInput(); S.padHeld = {}; S.joyTarget = { x: 0, y: 0 }; if (S.autopilot) setAutopilot(false, 'brake'); },
        setAutopilot(on) { return setAutopilot(on, on ? '' : 'off'); },
        getAutopilot() { return !!S.autopilot; },
        // The component calls this once per frame with the simulated seconds it advanced the mission clock by.
        advanceDriveClock(seconds) { if (S.view === 'drive' && S.rover && seconds > 0) S.driveAdvance += seconds; },
        driveScaleCap() { return driveScaleCap(); },
        getRoverStatus(fresh) { return roverStatus(performance.now(), fresh); },
        // Review/test hook: overwrite rover fields (e.g. {batt: 3}) or teleport ({x, z}).
        debugRover(patch) { const R = S.rover; if (!R) return; const { x, z, ...rest } = patch || {}; Object.assign(R, rest); if (Number.isFinite(x) && Number.isFinite(z)) { R.pos[0] = x; R.pos[2] = z; R.pos[1] = groundAtW(x, z); R.v = 0; } R.fc = null; R.fcJob = null; },
        getNavigationPath(){if(!S.navigation)return [];if(S.navKey!==S.navigation.key)return S.navigation.points;const p=S.navSamples||[],g=S.rover?gridOf(S.rover.pos[0],S.rover.pos[2]):[p[0]?.i,p[0]?.j];return [{i:g[0],j:g[1]},...p.slice((S.navProgress||0)+1)];},
        ensureRover(){if(S.terr&&(!S.rover||S.rover.terrainKey!==S.terrKey))initDrive();},
        getDriveState(){if(!S.rover)return null;const r=S.rover;return {x:r.pos[0],z:r.pos[2],heading:r.heading,batt:r.batt,dist:r.dist,terrainKey:S.terrKey,camera:{yaw:S.dc.yaw,followHeading:S.dc.hs,distance:S.dc.dist},routeStart:S.navRenderedStart,routeEnd:S.navRenderedEnd,routeCrossTrack:S.navCrossTrack||0,routeNeedsReplan:!!S.navUnsafe,navigationDraws:S.navigationDraws||0,edge:!!r.edge,speed:r.v,kmh:Math.abs(r.v)*3600,autopilot:!!S.autopilot,depleted:!!r.depleted,home:S.home?[S.home[0],S.home[2]]:null,fadeKm:S.fadeR||0};},
        findRover(){if(!S.rover)return;S.dc.orbiting=false;S.dc.yawTarget=0;S.dc.pitchTarget=.2;S.dc.zoomTarget=DRIVE_START_DISTANCE;S.dc.manualUntil=0;S.dirty=true;},
        resetRover() { S.spawn = S.home||null; if (S.view === 'drive') initDrive(); S.dirty = true; },
        focusGrid(i,j){S.tc.tgt=gridToWorld(i,j);S.tc.dist=2.5;S.tc.pitch=.4;S.dirty=true;},
        zoom(k) { zoom(k); },
        setTravel(times,small,maxHours){if(!S.terr)return;const d=S.terr.dem,N=d.N,dat=S.terr.g.dat;for(let j=0;j<N;j++)for(let i=0;i<N;i++){const value=times[Math.round(j*(small-1)/(N-1))*small+Math.round(i*(small-1)/(N-1))];dat[(j*N+i)*4+3]=Number.isFinite(value)?value/maxHours:-1;}gl.bindBuffer(gl.ARRAY_BUFFER,S.terr.bd);gl.bufferSubData(gl.ARRAY_BUFFER,0,dat);S.dirty=true;},
        setDriveZoom(value){S.dc.zoomTarget=clamp(value,.005,24);S.dirty=true;},
        getDriveZoom(){return S.dc.zoomTarget||S.dc.dist;},
        resetDriveZoom(){S.dc.zoomTarget=DRIVE_START_DISTANCE;},
        reset() { if (S.view === 'region') initRegion(null); else if (S.view === 'terrain') initTerrain(); else S.dc = { yaw: 0, pitch: 0.2, dist: DRIVE_START_DISTANCE, hs: S.rover ? S.rover.heading : 0 }; S.fly = null; S.dirty = true; },
        destroy() {
          for(const mesh of Object.values(routeBuffers))for(const key of ['p','prev','next','side'])if(mesh[key])gl.deleteBuffer(mesh[key]);alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect();
          ov.removeEventListener('pointerdown', onDown); ov.removeEventListener('pointermove', onMove); ov.removeEventListener('pointerup', onUp);
          ov.removeEventListener('dblclick', onDbl); ov.removeEventListener('wheel', onWheel); ov.removeEventListener('contextmenu', noCtx);
          window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur);
        }
      };
    }
    this._EL = { create: create };
    return this._EL;
  }
}
