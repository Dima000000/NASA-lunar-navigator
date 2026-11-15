import { VEHICLE, RAD, batteryAfter } from "./science-core.mjs";
import { surfaceHeight, navigationSky } from "./drive-navigation.mjs";
import { buildTripPlan } from "./planning-analysis.mjs";

// Any-angle post-processing of an 8-connected grid route.
// The grid search returns octile "staircase" paths; here we string-pull each
// driving run (line of sight + slope limit + not slower), round the remaining
// corners slightly, and re-check time and battery along the new geometry.
// Every straightened piece is sampled finely so it never crosses a cell
// steeper than the rover limit (with a small safety margin).

const SAMPLE = 0.1, // cells between slope checks
  MARGIN = 0.3, // cells of lateral clearance from too-steep cells
  PIECE = 0.25, // cells per timing piece
  MAX_ROW = 1; // cells: longest row after re-subdivision (light sampling)

function blocked(dem, i, j, limit) {
  const N = dem.N,
    x = Math.round(i),
    y = Math.round(j);
  if (x < 0 || y < 0 || x >= N || y >= N) return true;
  return !(dem.slope[y * N + x] <= limit);
}

// Conservative line of sight: every sample and a ±MARGIN box around it
// must lie in cells within the slope limit.
export function segmentClear(dem, a, b, limit = VEHICLE.maxSlopeDeg) {
  const len = Math.hypot(b.i - a.i, b.j - a.j),
    n = Math.max(1, Math.ceil(len / SAMPLE));
  for (let s = 0; s <= n; s++) {
    const f = s / n,
      i = a.i + (b.i - a.i) * f,
      j = a.j + (b.j - a.j) * f;
    if (
      blocked(dem, i, j, limit) ||
      blocked(dem, i - MARGIN, j - MARGIN, limit) ||
      blocked(dem, i + MARGIN, j - MARGIN, limit) ||
      blocked(dem, i - MARGIN, j + MARGIN, limit) ||
      blocked(dem, i + MARGIN, j + MARGIN, limit)
    )
      return false;
  }
  return true;
}

// Drive time (hours) along a straight piece using the same speed law as the
// grid search: speed falls with max(local cell slope, along-track grade).
export function segmentHours(dem, a, b, vehicle = VEHICLE) {
  const len = Math.hypot(b.i - a.i, b.j - a.j);
  if (len < 1e-9) return 0;
  const n = Math.max(1, Math.ceil(len / PIECE)),
    xy = (len * dem.cell) / n,
    N = dem.N;
  let hours = 0,
    h0 = surfaceHeight(dem, a.i, a.j);
  for (let s = 1; s <= n; s++) {
    const f = s / n,
      fm = (s - 0.5) / n,
      i = a.i + (b.i - a.i) * f,
      j = a.j + (b.j - a.j) * f,
      h1 = surfaceHeight(dem, i, j),
      mi = Math.max(0, Math.min(N - 1, Math.round(a.i + (b.i - a.i) * fm))),
      mj = Math.max(0, Math.min(N - 1, Math.round(a.j + (b.j - a.j) * fm))),
      dz = h1 - h0,
      gradient = Math.max(
        dem.slope[mj * N + mi],
        Math.atan2(Math.abs(dz), xy) / RAD,
      );
    if (!(gradient <= vehicle.maxSlopeDeg)) return Infinity;
    hours +=
      Math.hypot(xy, dz) /
      (vehicle.flatSpeedKmh *
        Math.max(0.15, 1 - (0.7 * gradient) / vehicle.maxSlopeDeg));
    h0 = h1;
  }
  return hours;
}

// Greedy string pulling with a short look-ahead past local failures.
export function stringPull(dem, pts, { tolerance = 0.02, vehicle = VEHICLE } = {}) {
  if (pts.length < 3) return pts.slice();
  const cum = [0];
  for (let k = 1; k < pts.length; k++)
    cum.push(cum[k - 1] + segmentHours(dem, pts[k - 1], pts[k], vehicle));
  const out = [pts[0]];
  let a = 0;
  while (a < pts.length - 1) {
    let best = a + 1,
      misses = 0;
    for (let b = a + 2; b < pts.length; b++) {
      const ok =
        segmentClear(dem, pts[a], pts[b], vehicle.maxSlopeDeg) &&
        segmentHours(dem, pts[a], pts[b], vehicle) <=
          (cum[b] - cum[a]) * (1 + tolerance) + 1e-9;
      if (ok) {
        best = b;
        misses = 0;
      } else if (++misses > 10) break;
    }
    out.push(pts[best]);
    a = best;
  }
  return out;
}

// Replace each interior corner by a short quadratic curve when it stays clear.
export function roundCorners(dem, pts, { radius = 2, vehicle = VEHICLE } = {}) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const p = out.at(-1),
      v = pts[k],
      n = pts[k + 1],
      la = Math.hypot(p.i - v.i, p.j - v.j),
      lb = Math.hypot(n.i - v.i, n.j - v.j),
      r = Math.min(radius, 0.45 * la, 0.45 * lb);
    if (r < 0.2) {
      out.push(v);
      continue;
    }
    const p1 = { i: v.i + ((p.i - v.i) * r) / la, j: v.j + ((p.j - v.j) * r) / la },
      p2 = { i: v.i + ((n.i - v.i) * r) / lb, j: v.j + ((n.j - v.j) * r) / lb },
      curve = [p1];
    for (let s = 1; s <= 5; s++) {
      const t = s / 6,
        u = 1 - t;
      curve.push({
        i: u * u * p1.i + 2 * u * t * v.i + t * t * p2.i,
        j: u * u * p1.j + 2 * u * t * v.j + t * t * p2.j,
      });
    }
    curve.push(p2);
    let ok = true;
    for (let s = 1; s < curve.length && ok; s++)
      ok = segmentClear(dem, curve[s - 1], curve[s], vehicle.maxSlopeDeg);
    if (ok) out.push(...curve);
    else out.push(v);
  }
  out.push(pts.at(-1));
  return out;
}

function subdivide(pts, maxLen) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1],
      b = pts[k],
      n = Math.max(1, Math.ceil(Math.hypot(b.i - a.i, b.j - a.j) / maxLen));
    for (let s = 1; s <= n; s++)
      out.push({ i: a.i + ((b.i - a.i) * s) / n, j: a.j + ((b.j - a.j) * s) / n });
  }
  return out;
}

/**
 * Smooth a grid trip. `rows` are the plan rows of the grid search ({cell,i,j,time,energyWh}).
 * Returns {vertices, labels} for buildTripPlan, or null when the smoothed
 * geometry would be slower than allowed or run the battery flat (caller keeps the grid route).
 * `light(point, ms)` returns {sun, sunDistanceKm} for a fractional grid point.
 */
export function smoothTrip(dem, rows, { start, maxHours, light, vehicle = VEHICLE, initialWh }) {
  if (!rows?.length) return null;
  // Split into driving runs separated by waits (same position, time advances).
  const runs = [],
    departs = [0]; // departs[k]: departure time (h) of runs[k] after a wait
  let run = [rows[0]],
    pending = null;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1],
      b = rows[k],
      moved = a.cell !== b.cell || a.i !== b.i || a.j !== b.j;
    if (!moved) {
      pending = b.time;
      continue;
    }
    if (pending !== null) {
      runs.push(run);
      departs.push(pending);
      run = [a];
      pending = null;
    }
    run.push(b);
  }
  runs.push(run); // a trailing wait at the goal is dropped
  // Geometry per run.
  const geometry = runs.map((r) => {
    if (r.length < 2) return r.map((p) => ({ i: p.i, j: p.j }));
    const pulled = stringPull(
      dem,
      r.map((p) => ({ i: p.i, j: p.j })),
      { vehicle },
    );
    return subdivide(roundCorners(dem, pulled, { vehicle }), MAX_ROW);
  });
  // Re-time and re-integrate the battery along the new geometry.
  const vertices = [],
    labels = [];
  let time = 0,
    energy = initialWh;
  const add = (p, t, e) => {
    vertices.push({ i: p.i, j: p.j });
    labels.push({ v: vertices.length - 1, time: t, energyWh: e });
  };
  const integrate = (pa, pb, t, duration, driving) => {
    let value = energy;
    const steps = Math.max(1, Math.ceil(duration / 0.25)),
      dt = duration / steps;
    for (let s = 0; s < steps; s++) {
      const f = (s + 0.5) / steps,
        l = light(f < 0.5 ? pa : pb, start + (t + duration * f) * 3600000);
      value = batteryAfter(value, l.sun, dt, driving, vehicle, l.sunDistanceKm);
      if (value <= 0) return 0;
    }
    return value;
  };
  for (let r = 0; r < geometry.length; r++) {
    const g = geometry[r];
    if (r === 0) add(g[0], 0, energy);
    else {
      const depart = Math.max(time, departs[r]),
        here = vertices.at(-1);
      if (depart > time + 1e-9) {
        energy = integrate(here, here, time, depart - time, false);
        if (energy <= 0) return null;
        time = depart;
        // A wait: same vertex index, later time.
        labels.push({ v: vertices.length - 1, time, energyWh: energy });
      }
    }
    for (let k = 1; k < g.length; k++) {
      const hours = segmentHours(dem, g[k - 1], g[k], vehicle);
      if (!Number.isFinite(hours)) return null;
      if (hours < 1e-9) continue;
      energy = integrate(g[k - 1], g[k], time, hours, true);
      if (energy <= 0) return null;
      time += hours;
      add(g[k], time, energy);
    }
  }
  if (time > maxHours + 1e-9) return null;
  return { vertices, labels, hours: time };
}

// Worker helper: smooth a reachable grid plan; returns the grid plan unchanged on failure.
export function smoothPlan(q, geometry, ephem, plan, vehicle = VEHICLE) {
  if (!plan?.reachable || plan.rows.length < 3) return plan;
  try {
    const ids = new Map(),
      pts = [],
      sky = navigationSky(ephem, q, { point: (id) => pts[id] }),
      light = (p, ms) => {
        let id = ids.get(p);
        if (id === undefined) {
          id = pts.length;
          ids.set(p, id);
          pts.push(geometry.coordinates(p.i, p.j));
        }
        return sky(id, ms);
      };
    const s = smoothTrip(q.dem, plan.rows, {
      start: q.start,
      maxHours: q.maxHours,
      light,
      vehicle,
      initialWh: plan.rows[0].energyWh,
    });
    if (!s || s.vertices.length < 2) return plan;
    const L = s.labels,
      best = new Array(s.vertices.length).fill(-1);
    best[L.at(-1).v] = L.length - 1;
    const smooth = buildTripPlan(
      {
        N: q.dem.N,
        points: s.vertices.map((v) => geometry.coordinates(v.i, v.j)),
        slope: q.dem.slope,
        start: q.start,
        sizeKm: q.dem.L,
        cellKm: q.dem.cell,
      },
      {
        best,
        parent: L.map((_, k) => k - 1),
        stateCell: L.map((l) => l.v),
        dist: L.map((l) => l.time),
        energyWh: L.map((l) => l.energyWh),
        incomplete: plan.incomplete,
      },
      (v, ms) => light(s.vertices[v], ms),
      L.at(-1).v,
    );
    if (!smooth.reachable) return plan;
    smooth.smoothed = true;
    smooth.gridHours = plan.hours;
    return smooth;
  } catch (e) {
    return plan;
  }
}
