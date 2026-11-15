import {
  enu,
  RAD,
  R_M,
  clamp,
  VEHICLE,
  discFraction,
} from "./science-core.mjs";
// The same triangles as buildTerrain (diagonal between the lower-right / upper-left nodes).
export function surfaceHeight(dem, i, j) {
  i = clamp(i, 0, dem.N - 1.000001);
  j = clamp(j, 0, dem.N - 1.000001);
  const x = Math.floor(i),
    y = Math.floor(j),
    a = i - x,
    b = j - y,
    k = y * dem.N + x,
    h = dem.h;
  return a + b <= 1
    ? h[k] * (1 - a - b) + h[k + 1] * a + h[k + dem.N] * b
    : h[k + dem.N + 1] * (a + b - 1) +
        h[k + 1] * (1 - b) +
        h[k + dem.N] * (1 - a);
}
export function surfacePath(dem, points) {
  const out = [];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1],
      b = points[k],
      di = b.i - a.i,
      dj = b.j - a.j;
    if (Math.hypot(di, dj) < 1e-8) continue;
    const ts = [0, 1];
    for (const [p, d] of [
      [a.i, di],
      [a.j, dj],
      [a.i + a.j, di + dj],
    ])
      if (Math.abs(d) > 1e-9)
        for (
          let v = Math.floor(Math.min(p, p + d)) + 1;
          v < Math.max(p, p + d);
          v++
        ) {
          const t = (v - p) / d;
          if (t > 1e-8 && t < 1 - 1e-8) ts.push(t);
        }
    ts.sort((a, b) => a - b);
    for (const t of ts) {
      const i = a.i + di * t,
        j = a.j + dj * t;
      if (out.length && Math.hypot(out.at(-1).i - i, out.at(-1).j - j) < 1e-7)
        continue;
      out.push({
        i,
        j,
        x: -dem.L / 2 + i * dem.cell,
        y: surfaceHeight(dem, i, j) + 0.00003,
        z: dem.L / 2 - j * dem.cell,
      });
    }
  }
  return out;
}
export function modelStepSeconds(realDt, scale, paused = false) {
  return paused
    ? 0
    : Math.min(
        30,
        Math.max(0, realDt) * Math.max(0, Number.isFinite(scale) ? scale : 0),
      );
}
export function navigationGeometry(q) {
  const d = q.dem,
    N = d.N,
    origin = Math.round(q.origin.j) * N + Math.round(q.origin.i),
    goal = Math.round(q.target.j) * N + Math.round(q.target.i),
    f = enu(q.site.lat, q.site.lon),
    cache = new Map();
  const coordinates = (i, j) => {
    const x = (-d.L / 2 + i * d.cell) * 1000,
      y = (-d.L / 2 + j * d.cell) * 1000,
      s = (x * x + y * y) / (4 * R_M * R_M),
      a = 1 / (1 + s),
      v = f.up.map(
        (u, k) =>
          (u * (1 - s) + (f.east[k] * x) / R_M + (f.north[k] * y) / R_M) * a,
      ),
      p = {
        i,
        j,
        lat: Math.asin(clamp(v[2], -1, 1)) / RAD,
        lon: Math.atan2(v[1], v[0]) / RAD,
        h: d.centerHeightM + surfaceHeight(d, i, j) * 1000,
      };
    return p;
  };
  const point = (cell) => {
    if (cache.has(cell)) return cache.get(cell);
    const i = cell === origin ? q.origin.i : cell % N,
      j = cell === origin ? q.origin.j : Math.floor(cell / N),
      p = coordinates(i, j);
    cache.set(cell, p);
    return p;
  };
  const originHeight = surfaceHeight(d, q.origin.i, q.origin.j);
  const edgeFor = (a, b) => {
    const ai = a === origin ? q.origin.i : a % N,
      aj = a === origin ? q.origin.j : Math.floor(a / N),
      bi = b === origin ? q.origin.i : b % N,
      bj = b === origin ? q.origin.j : Math.floor(b / N),
      xy = Math.hypot(bi - ai, bj - aj) * d.cell,
      z =
        (b === origin ? originHeight : d.h[b]) -
        (a === origin ? originHeight : d.h[a]);
    return {
      distance: Math.hypot(xy, z),
      slope: Math.atan2(Math.abs(z), xy) / RAD,
    };
  };
  const heuristic = (cell) => {
    const p = point(cell),
      r = point(goal);
    return (Math.hypot(r.i - p.i, r.j - p.j) * d.cell) / VEHICLE.flatSpeedKmh;
  };
  return { N, origin, goal, point, coordinates, edgeFor, heuristic };
}
// Energy-free reverse travel time is a lower bound for the time/energy search.
// Its edges and corner restrictions match reachSteps; it never certifies energy feasibility.
export function* terrainPotential(geometry, slope, vehicle = VEHICLE) {
  const { N, goal, edgeFor } = geometry,
    times = new Float64Array(N * N).fill(Infinity),
    next = new Int32Array(N * N).fill(-1),
    heap = [];
  const push = (cell, time) => {
    let k = heap.length;
    heap.push(null);
    while (k) {
      const parent = (k - 1) >> 1;
      if (heap[parent][1] <= time) break;
      heap[k] = heap[parent];
      k = parent;
    }
    heap[k] = [cell, time];
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length) {
      let k = 0;
      while (k * 2 + 1 < heap.length) {
        let child = k * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1])
          child++;
        if (last[1] <= heap[child][1]) break;
        heap[k] = heap[child];
        k = child;
      }
      heap[k] = last;
    }
    return first;
  };
  times[goal] = 0;
  push(goal, 0);
  let expanded = 0;
  const moves = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  while (heap.length) {
    const [cell, time] = pop();
    if (time !== times[cell]) continue;
    if (++expanded % 2048 === 0)
      yield { expanded, maxExpansions: N * N, phase: "terrain" };
    const i = cell % N,
      j = Math.floor(cell / N);
    for (const [dx, dy] of moves) {
      const x = i + dx,
        y = j + dy,
        neighbour = y * N + x;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      if (
        slope[cell] > vehicle.maxSlopeDeg ||
        slope[neighbour] > vehicle.maxSlopeDeg
      )
        continue;
      if (
        dx &&
        dy &&
        (slope[j * N + x] > vehicle.maxSlopeDeg ||
          slope[y * N + i] > vehicle.maxSlopeDeg)
      )
        continue;
      const edge = edgeFor(cell, neighbour),
        gradient = Math.max(slope[cell], slope[neighbour], edge.slope);
      if (gradient > vehicle.maxSlopeDeg) continue;
      const t =
        time +
        edge.distance /
          (vehicle.flatSpeedKmh *
            Math.max(0.15, 1 - (0.7 * gradient) / vehicle.maxSlopeDeg));
      if (t < times[neighbour]) {
        times[neighbour] = t;
        next[neighbour] = cell;
        push(neighbour, t);
      }
    }
  }
  return { times, next, expanded };
}
export function terrainCorridor(geometry, potential, slope, radius = 2) {
  const { N, origin, goal } = geometry,
    out = new Float32Array(N * N).fill(Infinity);
  if (!Number.isFinite(potential.times[origin])) return out;
  for (
    let cell = origin, count = 0;
    cell >= 0 && count < N * N;
    cell = potential.next[cell], count++
  ) {
    const i = cell % N,
      j = Math.floor(cell / N);
    for (let y = Math.max(0, j - radius); y <= Math.min(N - 1, j + radius); y++)
      for (
        let x = Math.max(0, i - radius);
        x <= Math.min(N - 1, i + radius);
        x++
      )
        out[y * N + x] = slope[y * N + x];
    if (cell === goal) break;
  }
  return out;
}
export function navigationSky(ephem, q, geometry) {
  const d = q.dem,
    a = q.atlasMeta,
    N = a.N,
    B = a.azimuth_bins,
    hi = a.heights_m.indexOf(q.height),
    cache = new Map(),
    states = new Map();
  return (cell, ms) => {
    const tick = Math.round(ms / 900000),
      key = cell + "|" + tick;
    if (cache.has(key)) return cache.get(key);
    let st = states.get(tick);
    if (!st) {
      st = ephem.state(tick * 900000);
      states.set(tick, st);
    }
    const p = geometry.point(cell),
      t = ephem.topo(st, p.lat, p.lon, (p.h + q.height) / 1000),
      x = (p.i / (d.N - 1)) * (N - 1),
      y = (p.j / (d.N - 1)) * (N - 1),
      i = Math.min(N - 2, Math.floor(x)),
      j = Math.min(N - 2, Math.floor(y)),
      u = x - i,
      v = y - j;
    const hz = (az) => {
      const f = (az / 360) * B,
        b = Math.floor(f) % B,
        w = f - Math.floor(f),
        at = (xx, yy, bb) => q.atlas[((hi * N + yy) * N + xx) * B + (bb % B)],
        sample = (bb) =>
          (at(i, j, bb) * (1 - u) + at(i + 1, j, bb) * u) * (1 - v) +
          (at(i, j + 1, bb) * (1 - u) + at(i + 1, j + 1, bb) * u) * v;
      return sample(b) * (1 - w) + sample((b + 1) % B) * w;
    };
    const result = {
      sunDistanceKm: t.sun.dist,
      sun: discFraction(t.sun.el - hz(t.sun.az), t.sun.rad),
      earth: discFraction(t.earth.el - hz(t.earth.az), t.earth.rad),
    };
    if (cache.size > 80000) cache.clear();
    cache.set(key, result);
    return result;
  };
}
