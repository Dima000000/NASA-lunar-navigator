import { paretoReach } from "./route-search.mjs";
export const RAD = Math.PI / 180,
  R_M = 1737400,
  AU_KM = 149597870.7;
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const unit = (a) => {
  const d = Math.hypot(...a);
  return a.map((x) => x / d);
};
export function enu(lat, lon) {
  const a = lat * RAD,
    b = lon * RAD;
  return {
    up: [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)],
    east: [-Math.sin(b), Math.cos(b), 0],
    north: [
      -Math.sin(a) * Math.cos(b),
      -Math.sin(a) * Math.sin(b),
      Math.cos(a),
    ],
  };
}
export class Ephemeris {
  constructor(records, meta) {
    this.records = records;
    this.meta = meta;
    this.first = Date.parse(meta.t0_utc);
    this.last = this.first + (meta.count - 1) * meta.step_s * 1000;
  }
  state(ms) {
    if (!Number.isFinite(ms) || ms < this.first || ms > this.last)
      throw Error("Ephemeris coverage is 2024-01-01 through 2036-01-01 UTC.");
    const q = (ms - this.first) / (this.meta.step_s * 1000),
      i = Math.min(this.meta.count - 2, Math.floor(q)),
      f = q - i;
    const row = Array.from(
      { length: 8 },
      (_, k) =>
        this.records[i * 8 + k] * (1 - f) + this.records[(i + 1) * 8 + k] * f,
    );
    return {
      sun: unit(row.slice(0, 3)).map((x) => x * row[3]),
      earth: unit(row.slice(4, 7)).map((x) => x * row[7]),
    };
  }
  topo(st, lat, lon, absoluteHeightKm = 0) {
    const f = enu(lat, lon),
      pos = f.up.map((x) => x * (R_M / 1000 + absoluteHeightKm));
    const body = (vec, r) => {
      const v = vec.map((x, k) => x - pos[k]),
        dist = Math.hypot(...v);
      return {
        az: (Math.atan2(dot(v, f.east), dot(v, f.north)) / RAD + 360) % 360,
        el: Math.asin(clamp(dot(v, f.up) / dist, -1, 1)) / RAD,
        dist,
        rad: Math.asin(r / dist) / RAD,
        v: v.map((x) => x / dist),
      };
    };
    return { sun: body(st.sun, 695700), earth: body(st.earth, 6378.137) };
  }
}
export function horizonValue(profile, az) {
  const f = ((((az % 360) + 360) % 360) / 360) * profile.length,
    i = Math.floor(f),
    w = f - i;
  return profile[i] * (1 - w) + profile[(i + 1) % profile.length] * w;
}
export function discFraction(delta, r) {
  const x = clamp(delta / r, -1, 1);
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
}
export function longestDark(lit, stepHours) {
  let best = 0,
    run = 0;
  for (const v of lit) {
    run = v ? 0 : run + stepHours;
    best = Math.max(best, run);
  }
  return best;
}
export function summarizeVisibility(
  ephem,
  site,
  profile,
  start,
  end,
  height = 2,
  stepHours = 1,
) {
  const sun = [],
    earth = [],
    frac = [];
  let count = 0;
  for (let ms = start; ms < end; ms += stepHours * 3600000) {
    const p = ephem.topo(
      ephem.state(ms),
      site.lat,
      site.lon,
      (site.centerHeightM + height) / 1000,
    );
    const f = discFraction(
      p.sun.el - horizonValue(profile, p.sun.az),
      p.sun.rad,
    );
    sun.push(f > 0.0005);
    frac.push(f);
    earth.push(p.earth.el > horizonValue(profile, p.earth.az));
    count++;
  }
  return {
    samples: count,
    sunAny: sun.filter(Boolean).length / count,
    sunCentre: frac.filter((f) => f >= 0.5).length / count,
    meanSunDisc: frac.reduce((a, b) => a + b, 0) / count,
    earthCentre: earth.filter(Boolean).length / count,
    longestDarkHours: longestDark(sun, stepHours),
  };
}
export function findWindows(
  ephem,
  site,
  profile,
  { year = 2026, stayHours = 156, weights = [50, 30, 20], height = 2 } = {},
) {
  const start = Date.UTC(year, 0, 1),
    end = Date.UTC(year + 1, 0, 1),
    count = (end - start) / 3600000 + stayHours,
    ss = new Uint8Array(count),
    ee = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const t = ephem.topo(
      ephem.state(start + i * 3600000),
      site.lat,
      site.lon,
      (site.centerHeightM + height) / 1000,
    );
    ss[i] =
      discFraction(t.sun.el - horizonValue(profile, t.sun.az), t.sun.rad) >
      0.0005;
    ee[i] =
      discFraction(
        t.earth.el - horizonValue(profile, t.earth.az),
        t.earth.rad,
      ) > 0.0005;
  }
  const ps = new Uint32Array(count + 1),
    pe = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    ps[i + 1] = ps[i] + ss[i];
    pe[i + 1] = pe[i] + ee[i];
  }
  const queue = [],
    all = [],
    ws = weights.reduce((a, b) => a + b, 0) || 1;
  let tail = 0,
    head = 0,
    run = 0;
  const dark = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    run = ss[i] ? 0 : run + 1;
    dark[i] = run;
  }
  // Exact hourly maximum dark run within each candidate stay; the year has only 8760 starts.
  for (let i = 0; i < count - stayHours; i += 6) {
    let maxDark = 0,
      r = 0;
    for (let j = i; j < i + stayHours; j++) {
      r = ss[j] ? 0 : r + 1;
      maxDark = Math.max(maxDark, r);
    }
    const sun = (ps[i + stayHours] - ps[i]) / stayHours,
      earth = (pe[i + stayHours] - pe[i]) / stayHours;
    all.push({
      start: start + i * 3600000,
      end: start + (i + stayHours) * 3600000,
      sun,
      earth,
      darkHours: maxDark,
      score:
        (weights[0] * sun +
          weights[1] * earth +
          weights[2] * (1 - maxDark / stayHours)) /
        ws,
    });
  }
  all.sort((a, b) => b.score - a.score || a.start - b.start);
  const top = [];
  for (const w of all) {
    if (top.every((v) => Math.abs(v.start - w.start) >= stayHours * 3600000))
      top.push(w);
    if (top.length === 5) break;
  }
  return top;
}
// Explicit scenario, not a real vehicle specification. Tracking panel; no thermal/eclipses model.
export const VEHICLE = Object.freeze({
  capacityWh: 160,
  initialFraction: 0.8,
  panelM2: 0.5,
  panelEfficiency: 0.28,
  idleW: 10,
  driveW: 45,
  maxSlopeDeg: 20,
  flatSpeedKmh: 0.7,
});
export function solarPower(visibleFraction, distanceKm = AU_KM, v = VEHICLE) {
  return (
    1361 *
    (AU_KM / distanceKm) ** 2 *
    v.panelM2 *
    v.panelEfficiency *
    clamp(visibleFraction)
  );
}
export function batteryAfter(
  energyWh,
  visibleFraction,
  hours,
  driving = false,
  v = VEHICLE,
  distanceKm = AU_KM,
) {
  return clamp(
    energyWh +
      (solarPower(visibleFraction, distanceKm, v) -
        v.idleW -
        (driving ? v.driveW : 0)) *
        hours,
    0,
    v.capacityWh,
  );
}
export const timeAwareReach = paretoReach;
