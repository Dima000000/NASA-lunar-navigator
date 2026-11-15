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
  // Optional wall-clock stop (returns true to give up); the result is then `incomplete`.
  shouldStop = null,
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
    if (shouldStop && expanded % 32 === 0 && shouldStop()) {
      // Keep this label on the open list so `incomplete` stays honest.
      push(id, t);
      break;
    }
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

// ---- Fast slope-only planning ---------------------------------------------------
// Binary min-heap on typed arrays (no per-entry allocation). Stale entries are allowed:
// callers skip a popped id whose key no longer matches their best-known cost.
export class MinHeap {
  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.size = 0;
  }
  push(id, key) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2),
        keys = new Float64Array(this.size * 2);
      ids.set(this.ids);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    const { ids, keys } = this;
    let i = this.size++;
    while (i) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  // Returns the id with the smallest key (its key is left in `this.key`), or -1 when empty.
  pop() {
    if (!this.size) return -1;
    const { ids, keys } = this,
      top = ids[0];
    this.key = keys[0];
    const n = --this.size;
    if (n) {
      const id = ids[n],
        key = keys[n];
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (key <= keys[c]) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

// Hours to drive one edge; Infinity when the edge is too steep. Shared by the slope-only planner.
function edgeHours(k, kk, dx, dy, slope, cellKm, edgeFor, vehicle) {
  const edge = edgeFor?.(k, kk),
    gradient = Math.max(slope[k], slope[kk], edge?.slope || 0);
  if (!(gradient <= vehicle.maxSlopeDeg)) return Infinity;
  return (
    (edge?.distance ?? cellKm * Math.hypot(dx, dy)) /
    (vehicle.flatSpeedKmh *
      Math.max(0.15, 1 - (0.7 * gradient) / vehicle.maxSlopeDeg))
  );
}

// Slope-only A* over the 8-connected grid: same edges, slope limit and corner rule as
// reachSteps, no battery or clock. The octile flat-speed heuristic never overestimates.
// `gentle` adds a mild extra cost on steep edges (>= 0, keeps the heuristic admissible).
export function slopeAStar({
  N,
  cellKm,
  slope,
  origin,
  goal,
  edgeFor = null,
  vehicle = VEHICLE,
  gentle = 0.5,
}) {
  const NN = N * N,
    max = vehicle.maxSlopeDeg,
    cost = new Float64Array(NN).fill(Infinity),
    from = new Int32Array(NN).fill(-1),
    closed = new Uint8Array(NN),
    heap = new MinHeap(4096),
    gi = goal % N,
    gj = Math.floor(goal / N),
    perCell = cellKm / vehicle.flatSpeedKmh,
    h = (k) => {
      const dx = Math.abs((k % N) - gi),
        dy = Math.abs(Math.floor(k / N) - gj);
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * perCell;
    };
  let expanded = 0,
    found = false;
  if (slope[origin] <= max && slope[goal] <= max) {
    cost[origin] = 0;
    heap.push(origin, h(origin));
  }
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    expanded++;
    if (k === goal) {
      found = true;
      break;
    }
    const i = k % N,
      j = Math.floor(k / N);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = i + dx,
          y = j + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const kk = y * N + x;
        if (closed[kk] || !(slope[kk] <= max)) continue;
        // Diagonal edges cannot cut through blocked orthogonal cells.
        if (dx && dy && (!(slope[j * N + x] <= max) || !(slope[y * N + i] <= max)))
          continue;
        const hours = edgeHours(k, kk, dx, dy, slope, cellKm, edgeFor, vehicle);
        if (hours === Infinity) continue;
        const steep = Math.max(slope[k], slope[kk]) / max,
          c = cost[k] + hours * (1 + gentle * steep * steep);
        if (c < cost[kk]) {
          cost[kk] = c;
          from[kk] = k;
          heap.push(kk, c + h(kk));
        }
      }
  }
  const path = [];
  if (found)
    for (let k = goal, n = 0; k >= 0 && n <= NN; k = from[k], n++) path.push(k);
  path.reverse();
  return { found, path, cost: found ? cost[goal] : Infinity, expanded };
}

// Slope field restricted to a band of `radius` cells around a cell path (Infinity elsewhere).
export function pathCorridor(N, path, slope, radius = 3) {
  const out = new Float32Array(N * N).fill(Infinity);
  for (const cell of path) {
    const i = cell % N,
      j = Math.floor(cell / N);
    for (let y = Math.max(0, j - radius); y <= Math.min(N - 1, j + radius); y++)
      for (let x = Math.max(0, i - radius); x <= Math.min(N - 1, i + radius); x++)
        out[y * N + x] = slope[y * N + x];
  }
  return out;
}

// Honest timing for a slope-feasible path the energy search could not certify: drive it,
// stop to charge whenever the battery runs low (waiting for sunlight if needed), and say so.
// Returns labels in the shape buildTripPlan reads, plus needsCharging / chargingStops / depleted.
export function slopeRouteLabels({
  N,
  cellKm,
  slope,
  path,
  sky,
  startMs,
  edgeFor = null,
  vehicle = VEHICLE,
  maxHours = 24,
  waitHours = 1,
  reserve = 0.05,
  chargeTo = 0.8,
}) {
  const simulate = (topUps) => {
  const dist = [0],
    energyWh = [vehicle.capacityWh * vehicle.initialFraction],
    stateCell = [path[0]],
    parent = [-1],
    low = vehicle.capacityWh * reserve,
    full = vehicle.capacityWh * chargeTo;
  let t = 0,
    e = energyWh[0],
    chargingStops = 0,
    waitedHours = 0,
    noSun = false,
    depleted = false,
    flatAt = -1;
  const sunAt = [sky(path[0], startMs).sun > 0.0005];
  const label = (cell) => {
    parent.push(dist.length - 1);
    dist.push(t);
    energyWh.push(e);
    stateCell.push(cell);
  };
  // Unlike the search integrator this keeps going at an empty battery so the ETA stays defined.
  const integrate = (initial, a, b, duration, driving) => {
    let value = initial;
    const steps = Math.max(1, Math.ceil(duration / 0.25)),
      dt = duration / steps;
    for (let n = 0; n < steps; n++) {
      const f = (n + 0.5) / steps,
        light = sky(f < 0.5 ? a : b, startMs + (t + duration * f) * 3600000);
      value = batteryAfter(value, light.sun, dt, driving, vehicle, light.sunDistanceKm);
    }
    return value;
  };
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1],
      b = path[n];
    if (topUps.has(n - 1)) {
      // Planned stop in sunlight before a dark stretch: charge until full.
      let stopped = false;
      while (t + waitHours <= maxHours && e < vehicle.capacityWh * 0.98) {
        const charged = integrate(e, a, a, waitHours, false);
        if (charged <= e) break;
        t += waitHours;
        waitedHours += waitHours;
        e = charged;
        label(a);
        stopped = true;
      }
      if (stopped) chargingStops++;
    }
    const hours = edgeHours(
        a,
        b,
        (b % N) - (a % N),
        Math.floor(b / N) - Math.floor(a / N),
        slope,
        cellKm,
        edgeFor,
        vehicle,
      );
    if (hours === Infinity) return null;
    let after = integrate(e, a, b, hours, true);
    if (after <= low && !noSun) {
      // Waiting only helps if the Sun reaches this spot within the planning horizon.
      let sunAhead = false;
      for (let w = 0; t + w <= maxHours && !sunAhead; w += waitHours)
        sunAhead = sky(a, startMs + (t + w) * 3600000).sun > 0.0005;
      if (!sunAhead) noSun = true;
    }
    if (after <= low && !noSun) {
      let stopped = false;
      // Wait here (within the planning horizon) until the next edge is affordable, then top up.
      while (t + waitHours <= maxHours && e < full) {
        const charged = integrate(e, a, a, waitHours, false);
        if (after > low && charged <= e) break;
        t += waitHours;
        waitedHours += waitHours;
        e = charged;
        if (e <= 0) {
          depleted = true; // ran flat while waiting for sunrise
          if (flatAt < 0) flatAt = n;
        }
        label(a);
        stopped = true;
        after = integrate(e, a, b, hours, true);
      }
      if (stopped) chargingStops++;
    }
    if (after <= 0) {
      depleted = true;
      if (flatAt < 0) flatAt = n;
    }
    t += hours;
    e = after;
    label(b);
    sunAt.push(sky(b, startMs + t * 3600000).sun > 0.0005);
  }
  return { dist, energyWh, stateCell, parent, chargingStops, waitedHours, depleted, flatAt, sunAt };
  };
  // If the battery would run flat, go back to the last sunlit point before that and charge
  // fully there first; repeat a few times for routes with several dark stretches.
  const topUps = new Set();
  let run = simulate(topUps);
  for (let pass = 0; run && run.depleted && pass < 6; pass++) {
    let m = Math.min(run.flatAt, run.sunAt.length) - 1;
    while (m >= 0 && (!run.sunAt[m] || topUps.has(m))) m--;
    if (m < 0) break;
    topUps.add(m);
    const next = simulate(topUps);
    if (!next) break;
    run = next;
  }
  if (!run) return null;
  const { dist, energyWh, stateCell, parent, chargingStops, waitedHours, depleted } = run;
  const best = {};
  best[path.at(-1)] = dist.length - 1;
  return {
    best,
    parent,
    stateCell,
    dist,
    energyWh,
    incomplete: false,
    needsCharging: chargingStops > 0 || depleted,
    chargingStops,
    waitedHours,
    depleted,
  };
}
