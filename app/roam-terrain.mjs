// Drive roaming: the drivable world is not limited to the 16 km square around the selected place.
//
// The terrain shown in Terrain / Land / Drive is a square "window" of the measured LOLA rasters on the place's local
// stereographic grid. When the rover gets close to the border of the loaded window, the next window (same grid, centred
// near the rover) is built off the main thread: heights, slopes, the published PSR mask and a traced horizon atlas.
// Nodes shared with the current window are copied, so overlapping ground, lighting and routes are bit-identical. The
// engine then swaps the mesh and moves every world-space quantity by the opposite offset (shiftTerrain): the rover,
// camera, clock, battery, destination and route carry on without a visible step.
//
// Outside the four 20 m crops the source is the 80 m polar DEM, then the 297 m polar DEM (to about 300 km from the
// pole) and the 2.7 km global raster beyond it; the window's `sourceResolutionM` reports the coarsest source in use.
// No terrain is invented: where the rasters are coarse the ground is simply smoother.
import { enu, RAD, clamp, dot } from "./science-core.mjs";
import { interpolateVisualState } from "./visual-time.mjs";

export const ROAM = {
  // Ask for the next window when the rover is this close (km) to the border of the loaded one.
  triggerKm: 4.5,
  // At high time multipliers the next window is centred ahead of the rover: this many real seconds of travel…
  leadSeconds: 2.5,
  // …and an active destination stays inside the window while the rover still has this much room (km).
  targetRoomKm: 2,
  targetInsetKm: 0.6,
  // The place-centred stereographic grid stays within 1 % of true scale out to here.
  limitKm: 300,
};

// Pure planning step (unit-tested): where should the next window sit?
// All positions are km in the current window's frame (x east, y north, origin at its centre); `at` and the result are
// absolute offsets from the place pin in horizon-atlas nodes (`node` km each).
export function nextWindow({
  half,
  node,
  rover,
  lead = { x: 0, y: 0 },
  target = null,
  at = { nx: 0, ny: 0 },
  triggerKm = ROAM.triggerKm,
  limitKm = ROAM.limitKm,
}) {
  const room = (dx, dy) =>
      half -
      Math.max(Math.abs(rover.x - dx * node), Math.abs(rover.y - dy * node)),
    now = room(0, 0);
  if (now >= triggerKm) return null;
  const maxLead = Math.max(0, half - triggerKm - node),
    cx = rover.x + clamp(lead.x, -maxLead, maxLead),
    cy = rover.y + clamp(lead.y, -maxLead, maxLead);
  let dx = Math.round(cx / node),
    dy = Math.round(cy / node),
    keepsTarget = !!target;
  if (target) {
    const span = half - ROAM.targetInsetKm,
      tx = Math.round(clamp(cx, target.x - span, target.x + span) / node),
      ty = Math.round(clamp(cy, target.y - span, target.y + span) / node);
    if (room(tx, ty) >= Math.min(triggerKm, ROAM.targetRoomKm)) {
      dx = tx;
      dy = ty;
    } else keepsTarget = false;
  }
  let nx = at.nx + dx,
    ny = at.ny + dy,
    limited = false;
  const distance = Math.hypot(nx, ny) * node;
  if (distance > limitKm) {
    nx = Math.trunc((nx * limitKm) / distance);
    ny = Math.trunc((ny * limitKm) / distance);
    dx = nx - at.nx;
    dy = ny - at.ny;
    limited = true;
  }
  if (!dx && !dy) return limited ? { limit: true } : null;
  if (limited && room(dx, dy) < now + node / 2) return { limit: true };
  return { nx, ny, dx, dy, keepsTarget };
}

// The window's own tangent frame: where its centre is, and how far the grid's "north" is turned from true north there.
function windowFrame(science, dem) {
  const c = (dem.N - 1) / 2,
    k = 0.05 / dem.cell,
    unit = (p) => {
      const la = p.lat * RAD,
        lo = p.lon * RAD;
      return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    },
    axis = (a, b) => {
      const v = b.map((x, n) => x - a[n]),
        l = Math.hypot(...v);
      return v.map((x) => x / l);
    },
    centre = science.geoFor(dem, c, c),
    u = unit(centre),
    east = axis(u, unit(science.geoFor(dem, c + k, c))),
    north = axis(u, unit(science.geoFor(dem, c, c + k))),
    f = enu(centre.lat, centre.lon);
  return {
    lat: centre.lat,
    lon: centre.lon,
    heightKm: (dem.centerHeightM + dem.h[c * dem.N + c] * 1000) / 1000,
    gamma: Math.atan2(dot(f.north, east), dot(f.north, north)) / RAD,
  };
}

// LROC brightness for a window: the place's own 16 km mosaic where it overlaps, a neutral mean elsewhere (feathered
// border, so the photograph never ends in a hard line).
function windowImagery(base, dem) {
  const image = base.imagery;
  if (!image) return null;
  const size = image.naturalWidth || image.width || 512;
  if (!base.roamTile) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = size;
    const g = tile.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, 0, 0, size, size);
    const probe = g.getImageData(0, 0, size, size).data;
    let sum = 0;
    for (let k = 0; k < probe.length; k += 4 * 37) sum += probe[k];
    const mean = Math.round(sum / Math.ceil(probe.length / (4 * 37))),
      band = Math.round(size * 0.08);
    g.globalCompositeOperation = "destination-in";
    for (const horizontal of [true, false]) {
      const fade = horizontal
        ? g.createLinearGradient(0, 0, size, 0)
        : g.createLinearGradient(0, 0, 0, size);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(band / size, "#000");
      fade.addColorStop(1 - band / size, "#000");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = fade;
      g.fillRect(0, 0, size, size);
    }
    base.roamTile = { tile, mean };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d"),
    m = base.roamTile.mean;
  g.fillStyle = `rgb(${m},${m},${m})`;
  g.fillRect(0, 0, size, size);
  // North-up map: the place's mosaic is centred (-ox, -oy) km from the window centre.
  g.drawImage(
    base.roamTile.tile,
    (-dem.ox / dem.L) * size,
    (dem.oy / dem.L) * size,
  );
  return canvas;
}

export function withRoaming(Base, science) {
  return class Roaming extends Base {
    roamBaseKey() {
      const site = this.selSite();
      return site ? this.siteKey(site) + "|h" + (this.state.obsH || 2) : "";
    }
    roamActive() {
      return !!this._roam && this._tj === this._roam.job;
    }
    // Leave the roaming window: the next ensureTerrain() rebuilds the place's own square.
    roamDrop() {
      this._roam = null;
      this._roamJob = null;
      this._roamLimit = false;
      this.eng?.set({ worldLimit: false, northTurn: 0 });
      this.eng?.stageTerrain?.(null);
    }
    ensureTerrain() {
      const r = this._roam;
      if (r) {
        if (r.baseKey === this.roamBaseKey()) {
          if (this.state.view !== "region") this._tj = r.job;
          return;
        }
        // Another place (or observer height): back to that place's own terrain.
        this.roamDrop();
      }
      return super.ensureTerrain();
    }
    tryEngine() {
      super.tryEngine();
      const eng = this.eng;
      if (!eng || eng.roamReset || !eng.shiftTerrain) return;
      // "Return rover to the pin" also brings the terrain window back to the place.
      const reset = (eng.roamReset = eng.resetRover.bind(eng));
      eng.resetRover = () => {
        if (!this.roamActive()) return reset();
        const d = this._roam.job.dem,
          home = eng.getDriveState()?.home,
          x = home ? home[0] + d.ox : 0,
          z = home ? home[1] - d.oy : 0,
          inside = Math.max(Math.abs(x), Math.abs(z)) < d.L / 2 - 0.4;
        this.roamDrop();
        this.ensureTerrain();
        this.sync();
        if (home && inside) eng.set({ home: [x, 0, z] });
        reset();
        this.setState({ target: null });
      };
    }
    componentDidUpdate() {
      super.componentDidUpdate();
      this.roamCheck();
    }
    roamCheck() {
      const s = this.state,
        jb = this._tj,
        eng = this.eng;
      if (!eng?.shiftTerrain || !jb || s.view !== "drive" || s.landing) return;
      if (this._roamJob || performance.now() < (this._roamRetryAt || 0)) return;
      const d = jb.dem;
      if (!(d.product || d.customAtlas) || !jb.hmap || !Number.isInteger(jb.stride))
        return;
      const r = eng.getDriveState();
      if (!r || r.terrainKey !== jb.key) return;
      const node = d.cell * jb.stride,
        half = d.L / 2,
        // km per real second, for the look-ahead at high time multipliers
        pace =
          (r.speed || 0) *
          (s.drivePaused ? 0 : (s.driveTimeScale ?? 60)) *
          ROAM.leadSeconds,
        t =
          s.target && s.target.key === jb.key && s.navigationActive
            ? { x: -half + s.target.i * d.cell, y: -half + s.target.j * d.cell }
            : null,
        plan = nextWindow({
          half,
          node,
          rover: { x: r.x, y: -r.z },
          lead: { x: Math.sin(r.heading) * pace, y: Math.cos(r.heading) * pace },
          target: t,
          at: { nx: d.nx || 0, ny: d.ny || 0 },
        });
      if (this._roamLimit !== !!plan?.limit) {
        this._roamLimit = !!plan?.limit;
        eng.set({ worldLimit: this._roamLimit });
      }
      if (!plan || plan.limit) return;
      this.roamLoad(jb, plan, node);
    }
    roamLoad(jb, plan, node) {
      const d = jb.dem,
        height = this.state.obsH || 2,
        job = (this._roamJob = { from: jb, plan, node, height, started: performance.now() });
      science
        .roamWindow({
          site: { lat: d.lat, lon: d.lon },
          ox: plan.nx * node,
          oy: plan.ny * node,
          N: d.N,
          L: d.L,
          cell: d.cell,
          centerHeightM: d.centerHeightM,
          height,
          Nc: jb.Nc,
          B: jb.B,
          reuse: {
            h: d.h,
            psr: d.publishedPSR || null,
            atlas: jb.hmap.slice(),
            di: plan.dx * jb.stride,
            dj: plan.dy * jb.stride,
            ai: plan.dx,
            aj: plan.dy,
          },
        })
        .then((w) => this.roamStage(job, w))
        .catch((e) => {
          console.warn("Roaming terrain window failed:", e);
          if (this._roamJob === job) {
            this._roamJob = null;
            this._roamRetryAt = performance.now() + 3000;
          }
        });
    }
    roamStillWanted(job) {
      return (
        this._roamJob === job &&
        // (custom places get a fresh job object on every update: compare what it describes)
        this._tj?.key === job.from.key &&
        this._tj.dem === job.from.dem &&
        this.eng &&
        this.state.view === "drive" &&
        !this.state.landing &&
        (this.state.obsH || 2) === job.height
      );
    }
    // Worker result -> a terrain job; the mesh and the period statistics are prepared over the next frames, then swapped in.
    async roamStage(job, w) {
      if (!this.roamStillWanted(job)) {
        if (this._roamJob === job) this._roamJob = null;
        return;
      }
      const jb = job.from,
        d = jb.dem,
        plan = job.plan,
        base = d.roamBase || d,
        dem = {
          N: d.N,
          L: d.L,
          cell: d.cell,
          h: w.h,
          min: w.min,
          max: w.max,
          seed: 0,
          centerHeightM: d.centerHeightM,
          lat: d.lat,
          lon: d.lon,
          nx: plan.nx,
          ny: plan.ny,
          ox: plan.nx * job.node,
          oy: plan.ny * job.node,
          key: d.key,
          slope: w.slope,
          publishedPSR: w.psr,
          roamBase: base,
          source: "NASA LRO/LOLA measured terrain, roaming Drive window",
          customAtlas: {
            atlas: w.atlas,
            heightReady: [job.height],
            meta: {
              atlas: {
                N: jb.Nc,
                azimuth_bins: jb.B,
                heights_m: [job.height],
                ray_extent_m: 300000,
              },
            },
          },
        };
      // Coarsest measured source inside this window (20 m crops, 80 m / 297 m polar DEM, 2.7 km global raster).
      let coarsest = 0;
      for (const j of [0, 0.5, 1])
        for (const i of [0, 0.5, 1]) {
          const p = science.geoFor(dem, i * (dem.N - 1), j * (dem.N - 1));
          coarsest = Math.max(coarsest, window.RealMoon.resolution(p.lat, p.lon));
        }
      dem.sourceResolutionM = coarsest;
      // True north at the window centre, degrees clockwise from the grid's north (compass letters, map N arrow).
      dem.northTurn = windowFrame(science, dem).gamma;
      dem.imagery = windowImagery(base, dem);
      const tj = {
        key: this.roamBaseKey() + "|w" + plan.nx + "," + plan.ny,
        dem,
        hmap: w.atlas,
        B: jb.B,
        Nc: jb.Nc,
        stride: jb.stride,
        cancel: false,
        scienceShade: true,
      };
      // Everything heavy happens here, in small tasks between frames; the swap itself (roamCommit) stays light.
      const pause = () => new Promise((resolve) => setTimeout(resolve, 0)),
        wanted = () => {
          if (this.roamStillWanted(job)) return true;
          this.eng?.stageTerrain(null);
          if (this._roamJob === job) this._roamJob = null;
          return false;
        };
      await pause();
      while (wanted() && !this.eng.stageTerrain(dem, 4)) await pause();
      if (!wanted()) return;
      await this.roamWarmHeat(job, tj, pause);
      if (!wanted()) return;
      // Hillshade for the top-down map (same formula as drawMaps).
      {
        const N = dem.N,
          hs = new Float32Array(N * N),
          c = dem.cell;
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++) {
            const il = Math.max(0, i - 1),
              ir = Math.min(N - 1, i + 1),
              jd = Math.max(0, j - 1),
              ju = Math.min(N - 1, j + 1),
              gx = ((dem.h[j * N + ir] - dem.h[j * N + il]) / ((ir - il) * c)) * 2.5,
              gy = ((dem.h[ju * N + i] - dem.h[jd * N + i]) / ((ju - jd) * c)) * 2.5;
            hs[j * N + i] = Math.max(0, (gx * 0.5 - gy * 0.5 + 0.707) / Math.hypot(gx, gy, 1));
          }
        dem.hs = hs;
      }
      await pause();
      if (!wanted()) return;
      if (this.roamHeatNeeded()) {
        // Period maps for the new window, computed aside so the current window keeps its own until the swap.
        const keep = [this._tj, this._hacc, this._heat];
        try {
          this._tj = tj;
          this.heat();
          job.heat = [this._hacc, this._heat];
        } catch (e) {
          job.heat = null;
        } finally {
          [this._tj, this._hacc, this._heat] = keep;
        }
        await pause();
        if (!wanted()) return;
      }
      const utc = Number.isFinite(this._visualUTC)
        ? this._visualUTC
        : this.series().times[Math.min(this.state.ti, this.series().n - 1)];
      job.shade = this.terrLib().upsample(
        science.shadeGrid(tj, utc, job.height),
        tj.Nc,
        tj.stride,
        dem.N,
      );
      await pause();
      if (!wanted()) return;
      this._roamJob = null;
      this.roamCommit(job, tj);
    }
    // ---- period statistics (heat maps, destination card) per atlas node, cached by absolute node so windows share them
    roamHeatBasis() {
      const ser = this.series(),
        step = Math.max(1, Math.ceil(ser.n / 240));
      let count = 0;
      for (let k = 0; k < ser.n; k += step) count++;
      return {
        ser,
        step,
        count,
        threshold: this.visThr(),
        height: this.state.obsH || 2,
        key: this.roamBaseKey() + "|" + ser.key + "|" + this.state.visDef,
      };
    }
    roamHeatStore(basis) {
      if (this._roamHeat?.key !== basis.key)
        this._roamHeat = { key: basis.key, nodes: new Map() };
      return this._roamHeat.nodes;
    }
    // Remember what the current window already knows.
    roamHeatSeed(jb, basis) {
      const a = this._hacc;
      if (!a || a.key !== jb.key + "|" + basis.ser.key + "|" + this.state.visDef) return;
      const nodes = this.roamHeatStore(basis),
        d = jb.dem;
      for (let y = 0; y < jb.Nc; y++)
        for (let x = 0; x < jb.Nc; x++) {
          const id = (d.nx || 0) + x + "," + ((d.ny || 0) + y),
            k = y * jb.Nc + x;
          if (!nodes.has(id)) nodes.set(id, [a.sun[k], a.earth[k], a.mrun[k]]);
        }
    }
    roamHeatNeeded() {
      const s = this.state;
      return !!s.target || (s.layer && s.layer !== "off") || !!s.mapReach || !!s.bigMap;
    }
    async roamWarmHeat(job, tj, pause) {
      if (!this.roamHeatNeeded() || !this.heatNode) return;
      const basis = this.roamHeatBasis();
      this.roamHeatSeed(job.from, basis);
      const nodes = this.roamHeatStore(basis),
        d = tj.dem;
      let sliceStart = performance.now();
      for (let y = 0; y < tj.Nc; y++)
        for (let x = 0; x < tj.Nc; x++) {
          const id = d.nx + x + "," + (d.ny + y);
          if (nodes.has(id)) continue;
          nodes.set(
            id,
            this.heatNode(tj, y * tj.Nc + x, basis.ser, basis.step, basis.count, basis.threshold, basis.height),
          );
          if (performance.now() - sliceStart > 5) {
            await pause();
            if (!this.roamStillWanted(job) || this.roamHeatBasis().key !== basis.key) return;
            sliceStart = performance.now();
          }
        }
    }
    heatAcc() {
      const jb = this._tj;
      if (!jb?.dem.roamBase || !this.heatNode) return super.heatAcc();
      const basis = this.roamHeatBasis(),
        key = jb.key + "|" + basis.ser.key + "|" + this.state.visDef;
      if (this._hacc?.key === key) return this._hacc;
      const nodes = this.roamHeatStore(basis),
        d = jb.dem,
        Nv = jb.Nc ** 2,
        sun = new Float32Array(Nv),
        earth = new Float32Array(Nv),
        mrun = new Float32Array(Nv);
      for (let y = 0; y < jb.Nc; y++)
        for (let x = 0; x < jb.Nc; x++) {
          const id = d.nx + x + "," + (d.ny + y),
            k = y * jb.Nc + x;
          let v = nodes.get(id);
          if (!v) {
            v = this.heatNode(jb, k, basis.ser, basis.step, basis.count, basis.threshold, basis.height);
            nodes.set(id, v);
          }
          sun[k] = v[0];
          earth[k] = v[1];
          mrun[k] = v[2];
        }
      this._hacc = { key, sun, earth, mrun, per: (basis.ser.n - 1) * basis.ser.stepH };
      return this._hacc;
    }
    heat() {
      // While driving across windows the period maps are only needed for a destination card or a map layer.
      if (this.roamActive() && this.state.view === "drive" && !this.roamHeatNeeded())
        return null;
      return super.heat();
    }
    // ---- the swap: one frame, nothing resets
    roamCommit(job, tj) {
      const s = this.state,
        eng = this.eng,
        old = job.from,
        dem = tj.dem,
        plan = job.plan,
        sx = plan.dx * job.node,
        sy = plan.dy * job.node,
        di = plan.dx * tj.stride,
        dj = plan.dy * tj.stride,
        shade = job.shade;
      if (this.roamHeatNeeded()) this.roamHeatSeed(old, this.roamHeatBasis());
      if (!eng.shiftTerrain(dem, tj.key, sx, sy, shade)) {
        eng.stageTerrain(null);
        return;
      }
      if (job.heat) [this._hacc, this._heat] = job.heat;
      eng.setHorizon(tj.hmap, tj.Nc, tj.B, tj.stride);
      this._tj = tj;
      this._roam = { baseKey: this.roamBaseKey(), job: tj, frame: null };
      this._hzKey = tj.key;
      this._shadeFull = shade;
      this._shadeKey = "";
      this._heatKey = "";
      if (this._roverTerrainKey === old.key) this._roverTerrainKey = tj.key;
      const inside = (p) =>
          p.i >= 0 && p.j >= 0 && p.i <= dem.N - 1 && p.j <= dem.N - 1,
        moved = (p) =>
          p && p.key === old.key
            ? { ...p, i: p.i - di, j: p.j - dj, key: tj.key }
            : p,
        patch = { tready: tj.key, tprog: 1 };
      // Destination / landing point: same ground, new grid indices.
      let target = moved(s.target);
      if (target && target !== s.target && !inside(target)) target = null;
      patch.target = target;
      if (this._landAt?.key === old.key) {
        const at = moved(this._landAt);
        this._landAt = inside(at) ? at : null;
      }
      if (s.rover && s.rover.x !== undefined)
        patch.rover = { ...s.rover, x: s.rover.x - sx, z: s.rover.z + sy, edge: false };
      if (s.bestSpots?.length)
        patch.bestSpots = s.bestSpots
          .map((p) => ({ ...p, i: p.i - plan.dx, j: p.j - plan.dy }))
          .filter((p) => p.i >= 0 && p.j >= 0 && p.i <= tj.Nc - 1 && p.j <= tj.Nc - 1);
      // Active route: keep the line on the ground while a fresh plan for the new window is computed.
      const nav = this._navigation,
        targetKey = target ? target.key + "|" + target.i + "|" + target.j : "";
      if (nav && nav.terrainKey === old.key && target) {
        nav.terrainKey = tj.key;
        nav.targetKey = targetKey;
        if (nav.origin) nav.origin = { ...nav.origin, i: nav.origin.i - di, j: nav.origin.j - dj };
        for (const row of nav.plan?.rows || [])
          if (Number.isFinite(row.i)) {
            row.i -= di;
            row.j -= dj;
          }
        this._navTargetKey = targetKey;
      } else if (this._navTargetKey && target) this._navTargetKey = targetKey;
      const replan = !!(target && (s.navigationActive || this._navBusy));
      if (!target && s.target && (s.navigationActive || this._navBusy))
        patch.routeAlert = "The destination is now beyond the loaded terrain. Pick a new one on the map.";
      this.setState(patch);
      // Same frame: the rover's light/Earth sampler, shading and markers must already refer to the new window.
      this.sync();
      if (replan) this.requestNavigation?.();
    }
    // ---- Sun and Earth directions for the window the rover is in (grid frame), not for the distant pin
    roamSky(ms) {
      const r = this._roam,
        eng = this.eng;
      if (!eng || !this.roamActive() || this.state.view === "region" || !Number.isFinite(ms)) return;
      const f = (r.frame ??= windowFrame(science, r.job.dem));
      let st;
      try {
        st = interpolateVisualState(science.ephem, ms);
      } catch (e) {
        return;
      }
      const t = science.ephem.topo(st, f.lat, f.lon, f.heightKm + (this.state.obsH || 2) / 1000),
        turn = (b) => ({ ...b, az: (((b.az + f.gamma) % 360) + 360) % 360 });
      eng.set({ tSun: turn(t.sun), tEarth: turn(t.earth), northTurn: f.gamma });
    }
    sync() {
      super.sync();
      if (!this.roamActive() || !this.eng) return;
      const ser = this.series(),
        utc = ser.times[Math.min(this.state.ti, ser.n - 1)],
        live = this._visualUTC;
      this.roamSky(this.state.view === "drive" && Number.isFinite(live) ? live : utc);
    }
    renderContinuousTime(ms, now) {
      super.renderContinuousTime?.(ms, now);
      this.roamSky(ms);
    }
    roamStatus() {
      const d = this._tj?.dem;
      if (!this.roamActive() || !d) return null;
      const rv = this.state.rover;
      return {
        // window centre / rover, km from the place pin
        offsetKm: Math.hypot(d.ox, d.oy),
        roverKm: Math.hypot(d.ox + (rv?.x ?? 0), d.oy - (rv?.z ?? 0)),
        sourceResolutionM: d.sourceResolutionM,
        loading: !!this._roamJob,
        limit: !!this._roamLimit,
      };
    }
    renderVals() {
      const v = super.renderVals(),
        r = this.state.view === "region" ? null : this.roamStatus();
      // (The "loading the next stretch" / "end of the mapped area" messages come from the rover status: reasons
      // 'world-edge-loading' and 'world-edge'.)
      v.roamNote = r
        ? "Terrain follows the rover · " +
          (r.roverKm < 10 ? r.roverKm.toFixed(1) : Math.round(r.roverKm)) +
          " km from the pin · " +
          (r.sourceResolutionM >= 1000
            ? (r.sourceResolutionM / 1000).toFixed(1) + " km"
            : Math.round(r.sourceResolutionM) + " m") +
          " LOLA source"
        : "";
      v.roamTip =
        "Drive loads the next 16 km square of measured LOLA terrain as the rover travels. Source sampling: 20 m in the four crest crops, 80 m out to about 160 km from the pole, 297 m to about 300 km, 2.7 km beyond; nothing is invented between samples. The compass and the map's N arrow show true north where the rover is.";
      return v;
    }
  };
}
