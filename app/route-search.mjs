import { VEHICLE, batteryAfter } from "./science-core.mjs";

// Time-dependent, energy-feasible labels. Search pruning is explicit, not an optimality claim.
export function* reachSteps({
  N,
  cellKm,
  slope,
  origin,
  sky,
  startMs,
  vehicle = VEHICLE,
  maxHours = 24,
  buckets = 20,
  timeBinHours = 1,
  frontLimit = 6,
  maxExpansions = 200000,
  goal = -1,
  heuristic = () => 0,
  edgeFor = null,
}) {
  const NN = N * N,
    K = buckets + 1,
    T = new Float32Array(NN).fill(Infinity),
    best = new Int32Array(NN).fill(-1),
    contacts = new Float32Array(NN).fill(NaN);
  const times = [],
    energy = [],
    parents = [],
    cells = [],
    alive = [],
    fronts = new Map(),
    heap = [];
  let expanded = 0,
    prunedLabels = 0;
  const push = (id, t) => {
    const priority = t + heuristic(cells[id]);
    let i = heap.length;
    heap.push([id, t, priority]);
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p][2] <= priority) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = [id, t, priority];
  };
  const pop = () => {
    const r = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (true) {
        let j = 2 * i + 1;
        if (j >= heap.length) break;
        if (j + 1 < heap.length && heap[j + 1][2] < heap[j][2]) j++;
        if (last[2] <= heap[j][2]) break;
        heap[i] = heap[j];
        i = j;
      }
      heap[i] = last;
    }
    return r;
  };
  const integrate = (initial, from, to, t, duration, driving) => {
    let value = initial;
    const steps = Math.max(1, Math.ceil(duration / 0.25)),
      dt = duration / steps;
    for (let n = 0; n < steps; n++) {
      const f = (n + 0.5) / steps,
        light = sky(
          f < 0.5 ? from : to,
          startMs + (t + duration * f) * 3600000,
        );
      value = batteryAfter(
        value,
        light.sun,
        dt,
        driving,
        vehicle,
        light.sunDistanceKm,
      );
      if (value <= 0) return 0;
    }
    return value;
  };
  // Earlier arrival dominates only if waiting can preserve enough charge until the later arrival.
  const dominates = (id, t, e, k) =>
    times[id] <= t + 1e-10 &&
    energy[id] >= e - 1e-6 &&
    (Math.abs(times[id] - t) < 1e-10 ||
      integrate(energy[id], k, k, times[id], t - times[id], false) >= e - 1e-6);
  const insert = (k, t, e, parent) => {
    const group =
        (Math.floor((t + 1e-10) / timeBinHours) * NN + k) * K +
        Math.min(buckets, Math.floor((e / vehicle.capacityWh) * buckets)),
      front = fronts.get(group) || [];
    if (front.some((id) => dominates(id, t, e, k))) return;
    const id = times.length;
    times.push(t);
    energy.push(e);
    parents.push(parent);
    cells.push(k);
    alive.push(true);
    let keep = front.filter((old) => {
      const dominated = dominates(id, times[old], energy[old], k);
      if (dominated) alive[old] = false;
      return !dominated;
    });
    keep.push(id);
    if (keep.length > frontLimit) {
      const first = keep.reduce((a, b) => (times[a] < times[b] ? a : b)),
        most = keep.reduce((a, b) => (energy[a] > energy[b] ? a : b));
      const candidates = keep
        .filter((x) => x !== first && x !== most)
        .sort(
          (a, b) =>
            energy[b] / vehicle.capacityWh -
            times[b] / maxHours -
            (energy[a] / vehicle.capacityWh - times[a] / maxHours),
        );
      const chosen = new Set([
        first,
        most,
        ...candidates.slice(
          0,
          Math.max(0, frontLimit - new Set([first, most]).size),
        ),
      ]);
      for (const old of keep)
        if (!chosen.has(old)) {
          alive[old] = false;
          prunedLabels++;
        }
      keep = [...chosen];
    }
    fronts.set(group, keep);
    if (alive[id]) push(id, t);
  };
  insert(origin, 0, vehicle.capacityWh * vehicle.initialFraction, -1);
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
  while (heap.length && expanded < maxExpansions) {
    const [id, t] = pop();
    if (!alive[id]) continue;
    const k = cells[id],
      i = k % N,
      j = Math.floor(k / N);
    expanded++;
    if (expanded % 256 === 0) yield { expanded, maxExpansions };
    if (t < T[k]) {
      T[k] = t;
      best[k] = id;
      contacts[k] = sky(k, startMs + t * 3600000).earth;
    }
    if (k === goal) break;
    const relax = (kk, duration, driving) => {
      if (t + duration > maxHours + 1e-9) return;
      const value = integrate(energy[id], k, kk, t, duration, driving);
      if (value > 0) insert(kk, t + duration, value, id);
    };
    relax(k, timeBinHours, false);
    for (const [dx, dy] of moves) {
      const x = i + dx,
        y = j + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const kk = y * N + x;
      if (slope[k] > vehicle.maxSlopeDeg || slope[kk] > vehicle.maxSlopeDeg)
        continue;
      // Diagonal edges cannot cut through blocked orthogonal cells.
      if (
        dx &&
        dy &&
        (slope[j * N + x] > vehicle.maxSlopeDeg ||
          slope[y * N + i] > vehicle.maxSlopeDeg)
      )
        continue;
      const edge = edgeFor?.(k, kk);
      const gradient = Math.max(slope[k], slope[kk], edge?.slope || 0),
        speed =
          vehicle.flatSpeedKmh *
          Math.max(0.15, 1 - (0.7 * gradient) / vehicle.maxSlopeDeg);
      if (gradient > vehicle.maxSlopeDeg) continue;
      relax(kk, (edge?.distance ?? cellKm * Math.hypot(dx, dy)) / speed, true);
    }
  }
  return {
    T,
    best,
    parent: Int32Array.from(parents),
    dist: Float64Array.from(times),
    energyWh: Float32Array.from(energy),
    stateCell: Int32Array.from(cells),
    contacts,
    expanded,
    buckets,
    timeBinHours,
    prunedLabels,
    frontLimit,
    incomplete: heap.length > 0 && (goal < 0 || !Number.isFinite(T[goal])),
  };
}

// Voronoi cells centred on atlas nodes; include boundary samples conservatively.
export function conservativeSlopes(fine, displayN, routeN) {
  const out = new Float32Array(routeN * routeN),
    step = (displayN - 1) / (routeN - 1);
  for (let y = 0; y < routeN; y++)
    for (let x = 0; x < routeN; x++) {
      let peak = 0;
      for (
        let j = Math.max(0, Math.floor((y - 0.5) * step));
        j <= Math.min(displayN - 1, Math.ceil((y + 0.5) * step));
        j++
      )
        for (
          let i = Math.max(0, Math.floor((x - 0.5) * step));
          i <= Math.min(displayN - 1, Math.ceil((x + 0.5) * step));
          i++
        )
          peak = Math.max(peak, fine[j * displayN + i]);
      out[y * routeN + x] = peak;
    }
  return out;
}

export function paretoReach(options) {
  const steps = reachSteps(options);
  let next;
  do next = steps.next();
  while (!next.done);
  return next.value;
}
