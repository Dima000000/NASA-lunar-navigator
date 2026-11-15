import test from "node:test";
import assert from "node:assert/strict";
import { paretoReach } from "../app/route-search.mjs";
import { buildTripPlan } from "../app/planning-analysis.mjs";
import { navigationGeometry } from "../app/drive-navigation.mjs";
import {
  smoothTrip,
  segmentClear,
  stringPull,
} from "../app/route-smoothing.mjs";

const N = 41,
  dem = {
    N,
    L: 4,
    cell: 0.1,
    h: new Float32Array(N * N),
    slope: new Float32Array(N * N),
    centerHeightM: 0,
  };
// A steep wall across the map with one gap near the top.
for (let j = 0; j < N; j++) if (j < 30 || j > 33) dem.slope[j * N + 20] = 35;

function gridPlan(sky, origin, target, maxHours = 48) {
  const q = { dem, site: { lat: -89, lon: 0 }, origin, target },
    g = navigationGeometry(q),
    r = paretoReach({
      N,
      cellKm: dem.cell,
      slope: dem.slope,
      origin: g.origin,
      goal: g.goal,
      heuristic: g.heuristic,
      edgeFor: g.edgeFor,
      sky,
      startMs: 0,
      maxHours,
      maxExpansions: 400000,
    });
  return buildTripPlan(
    {
      N,
      points: new Proxy([], { get: (_, k) => g.point(Number(k)) }),
      slope: dem.slope,
      start: 0,
      cellKm: dem.cell,
      sizeKm: dem.L,
    },
    r,
    sky,
    g.goal,
  );
}

const turns = (pts) => {
  let n = 0;
  for (let k = 2; k < pts.length; k++) {
    const a = Math.atan2(pts[k - 1].j - pts[k - 2].j, pts[k - 1].i - pts[k - 2].i),
      b = Math.atan2(pts[k].j - pts[k - 1].j, pts[k].i - pts[k - 1].i);
    if (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) > 0.2) n++;
  }
  return n;
};

test("any-angle smoothing removes grid staircases without crossing steep cells", () => {
  const sky = () => ({ sun: 1, earth: 1 }),
    plan = gridPlan(sky, { i: 3, j: 2 }, { i: 37, j: 12 }),
    s = smoothTrip(dem, plan.rows, {
      start: 0,
      maxHours: 48,
      light: () => ({ sun: 1 }),
      initialWh: plan.rows[0].energyWh,
    });
  assert(plan.reachable && s);
  const pts = s.vertices;
  assert.deepEqual([pts[0].i, pts[0].j], [3, 2]);
  assert.deepEqual([pts.at(-1).i, pts.at(-1).j], [37, 12]);
  for (let k = 1; k < pts.length; k++)
    assert(segmentClear(dem, pts[k - 1], pts[k]), "smoothed piece crosses the wall");
  assert(s.hours <= plan.hours * 1.02 + 1e-9);
  const pulled = stringPull(dem, plan.rows.map((r) => ({ i: r.i, j: r.j })));
  assert(turns(pulled) < turns(plan.rows));
  assert(pulled.length < plan.rows.length / 3);
});

test("smoothing keeps charging waits and their departure times", () => {
  // Dark for the first 3 h: the rover must wait before it can finish.
  const dark = (ms) => (ms < 3 * 3600000 ? 0 : 1),
    sky = (_, ms) => ({ sun: dark(ms), earth: 1 }),
    plan = gridPlan(sky, { i: 3, j: 2 }, { i: 37, j: 12 }, 72),
    s = smoothTrip(dem, plan.rows, {
      start: 0,
      maxHours: 72,
      light: (_, ms) => ({ sun: dark(ms) }),
      initialWh: plan.rows[0].energyWh,
    });
  assert(plan.reachable);
  assert(plan.steps.some((x) => x.kind !== "drive"));
  assert(s, "smoothed trip stays feasible");
  const waits = s.labels.filter(
    (l, k) => k && l.v === s.labels[k - 1].v,
  );
  assert(waits.length >= 1);
  assert(s.labels.every((l) => l.energyWh > 0));
  assert(s.hours <= plan.hours + 1e-6);
});

// ---- Fast slope-only planner and the honest fallback ---------------------------------
const { MinHeap, slopeAStar, pathCorridor, slopeRouteLabels } = await import(
  "../app/route-search.mjs"
);
const { terrainPotential } = await import("../app/drive-navigation.mjs");

test("typed binary heap pops ids in key order and grows past its capacity", () => {
  const heap = new MinHeap(4),
    keys = [];
  let seed = 7;
  for (let k = 0; k < 500; k++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    keys.push(seed / 2147483648);
    heap.push(k, keys[k]);
  }
  assert.equal(heap.size, 500);
  let last = -Infinity,
    count = 0;
  for (let id = heap.pop(); id >= 0; id = heap.pop()) {
    assert.equal(heap.key, keys[id]);
    assert(heap.key >= last);
    last = heap.key;
    count++;
  }
  assert.equal(count, 500);
  assert.equal(heap.pop(), -1);
});

test("slope-only A* is optimal, respects steep cells and corners, and reports enclosed goals", () => {
  const q = { dem, site: { lat: -89, lon: 0 }, origin: { i: 3, j: 2 }, target: { i: 37, j: 12 } },
    g = navigationGeometry(q),
    options = { N, cellKm: dem.cell, slope: dem.slope, origin: g.origin, goal: g.goal, edgeFor: g.edgeFor },
    a = slopeAStar({ ...options, gentle: 0 });
  assert(a.found);
  assert.equal(a.path[0], g.origin);
  assert.equal(a.path.at(-1), g.goal);
  for (let k = 0; k < a.path.length; k++) {
    const c = a.path[k];
    assert(dem.slope[c] <= 20, "never on a too-steep cell");
    if (!k) continue;
    const p = a.path[k - 1],
      dx = (c % N) - (p % N),
      dy = Math.floor(c / N) - Math.floor(p / N);
    assert(Math.abs(dx) <= 1 && Math.abs(dy) <= 1);
    if (dx && dy) {
      assert(dem.slope[Math.floor(p / N) * N + (c % N)] <= 20, "no corner cutting");
      assert(dem.slope[Math.floor(c / N) * N + (p % N)] <= 20, "no corner cutting");
    }
  }
  // Same optimum as the exhaustive reverse Dijkstra.
  const it = terrainPotential(g, dem.slope);
  let step;
  do step = it.next();
  while (!step.done);
  assert(Math.abs(a.cost - step.value.times[g.origin]) < 1e-9);
  assert(a.expanded < N * N, "goal-directed: does not flood the whole grid");
  // The corridor contains the whole path and nothing steep.
  const corridor = pathCorridor(N, a.path, dem.slope, 2);
  assert(a.path.every((c) => corridor[c] === dem.slope[c]));
  assert(corridor.some((v) => v === 35), "steep cells stay steep inside the corridor");
  assert.equal(corridor[40 * N + 40], Infinity);
  // Close the gap: no slope-feasible path remains.
  const closed = Float32Array.from(dem.slope);
  for (let j = 0; j < N; j++) closed[j * N + 20] = 35;
  assert.equal(slopeAStar({ ...options, slope: closed }).found, false);
});

test("slope-only A* plans across a 16 km-class grid in well under a second", () => {
  const M = 485,
    slope = new Float32Array(M * M);
  // Long steep walls with alternating gaps force a detour of several km.
  for (let w = 60; w < M - 40; w += 60)
    for (let j = 0; j < M; j++) if ((w / 60) % 2 ? j > 20 : j < M - 20) slope[j * M + w] = 30;
  const began = performance.now(),
    r = slopeAStar({ N: M, cellKm: 0.033, slope, origin: 5 * M + 5, goal: (M - 6) * M + (M - 6) });
  const ms = performance.now() - began;
  assert(r.found);
  assert(r.path.length > M);
  assert(ms < 1000, "took " + ms.toFixed(0) + " ms");
});

test("when the battery-aware search gives up, the drivable route is still returned, flagged", async () => {
  const origin = { i: 3, j: 2 },
    target = { i: 37, j: 12 },
    q = { dem, site: { lat: -89, lon: 0 }, origin, target },
    g = navigationGeometry(q),
    base = slopeAStar({ N, cellKm: dem.cell, slope: dem.slope, origin: g.origin, goal: g.goal, edgeFor: g.edgeFor }),
    trip = {
      N,
      points: new Proxy([], { get: (_, k) => g.point(Number(k)) }),
      slope: dem.slope,
      start: 0,
      cellKm: dem.cell,
      sizeKm: dem.L,
    };
  // Permanent night: the energy search cannot succeed and stops at its budget / deadline.
  const night = () => ({ sun: 0, earth: 1 });
  let polls = 0;
  const failed = paretoReach({
    N,
    cellKm: dem.cell,
    slope: pathCorridor(N, base.path, dem.slope, 3),
    origin: g.origin,
    goal: g.goal,
    heuristic: g.heuristic,
    edgeFor: g.edgeFor,
    sky: night,
    startMs: 0,
    maxHours: 48,
    shouldStop: () => ++polls > 20,
  });
  assert(!Number.isFinite(failed.T[g.goal]));
  assert(failed.expanded <= 32 * 21, "the deadline hook stops the search");
  const flat = slopeRouteLabels({
      N, cellKm: dem.cell, slope: dem.slope, path: base.path, sky: night, startMs: 0, edgeFor: g.edgeFor, maxHours: 48,
    }),
    plan = buildTripPlan(trip, flat, night, g.goal);
  assert(plan.reachable, "still a route");
  assert(flat.needsCharging && flat.depleted);
  assert.equal(flat.chargingStops, 0, "no pointless waiting when the Sun never comes");
  assert(plan.hours > 4 / 0.7, "honest drive time for > 4 km at 0.7 km/h");
  const smooth = smoothTrip(dem, plan.rows, {
    start: 0, maxHours: Infinity, light: night, initialWh: plan.rows[0].energyWh, allowDepleted: true,
  });
  assert(smooth && smooth.vertices.length >= 2, "fallback routes are smoothed too");
  assert(turns(smooth.vertices) <= turns(plan.rows));
  for (let k = 1; k < smooth.vertices.length; k++)
    assert(segmentClear(dem, smooth.vertices[k - 1], smooth.vertices[k]));
  assert.equal(
    smoothTrip(dem, plan.rows, { start: 0, maxHours: Infinity, light: night, initialWh: plan.rows[0].energyWh }),
    null,
    "without the flag a flat battery still rejects the smoothed trip",
  );
  // Weak light for 6 h, then full Sun: the fallback stops to charge and arrives with charge.
  const dawn = (_, ms) => ({ sun: ms < 6 * 3600000 ? 0.2 : 1, earth: 1 }),
    low = { ...(await import("../app/science-core.mjs")).VEHICLE, initialFraction: 0.3 },
    stops = slopeRouteLabels({
      N, cellKm: dem.cell, slope: dem.slope, path: base.path, sky: dawn, startMs: 0, edgeFor: g.edgeFor, maxHours: 48, vehicle: low,
    });
  assert(stops.needsCharging && !stops.depleted);
  assert(stops.chargingStops >= 1);
  assert(stops.waitedHours >= 1);
  assert(stops.energyWh.every((e) => e > 0));
  assert(stops.dist.at(-1) > flat.dist.at(-1), "charging time is part of the ETA");
  for (let k = 1; k < stops.dist.length; k++) assert(stops.dist[k] > stops.dist[k - 1]);
  assert(buildTripPlan(trip, stops, dawn, g.goal).chargeStops >= 1);
  // Weakly lit ground followed by a permanently dark last stretch: instead of running flat in
  // the dark, the fallback goes back to the last sunlit point and charges fully there first.
  const shadow = (cell) => ({ sun: cell % N < 30 ? 0.25 : 0, earth: 1 }),
    planned = slopeRouteLabels({
      N, cellKm: dem.cell, slope: dem.slope, path: base.path, sky: shadow, startMs: 0, edgeFor: g.edgeFor, maxHours: 48, vehicle: low,
    });
  assert(planned.needsCharging && planned.chargingStops >= 1);
  assert(!planned.depleted, "a full battery carries the rover through the dark stretch");
  assert(planned.energyWh.every((e) => e > 0));
});
