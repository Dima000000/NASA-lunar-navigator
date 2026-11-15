import test from "node:test";
import assert from "node:assert/strict";
import {
  surfaceHeight,
  surfacePath,
  navigationGeometry,
  modelStepSeconds,
  terrainPotential,
  terrainCorridor,
} from "../app/drive-navigation.mjs";
import { paretoReach } from "../app/route-search.mjs";
import { buildTripPlan, tripCSV } from "../app/planning-analysis.mjs";
test("route follows the exact rendered triangles, splitting at ridge and diagonal boundaries", () => {
  const d = { N: 2, L: 1, cell: 1, h: new Float32Array([0, 10, 20, 50]) };
  assert.equal(surfaceHeight(d, 0.25, 0.25), 7.5);
  assert.equal(surfaceHeight(d, 0.75, 0.75), 32.5);
  const p = surfacePath(d, [
    { i: 0, j: 0 },
    { i: 1, j: 1 },
  ]);
  assert(p.some((v) => Math.abs(v.i - 0.5) < 1e-8));
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1],
      b = p[i],
      j = (a.j + b.j) / 2,
      k = (a.i + b.i) / 2;
    assert(Math.abs((a.y + b.y) / 2 - surfaceHeight(d, k, j) - 0.00003) < 1e-4);
  }
  assert(Math.abs(p[0].x + 0.5) < 1e-9);
  assert(Math.abs(p.at(-1).z + 0.5) < 1e-9);
});
test("navigation uses the actual subcell rover origin and a targeted, admissible goal search", () => {
  const N = 9,
    q = {
      dem: {
        N,
        L: 0.8,
        cell: 0.1,
        h: new Float32Array(N * N),
        slope: new Float32Array(N * N),
        centerHeightM: 2000,
      },
      site: { lat: -89.4, lon: -137 },
      origin: { i: 2.25, j: 2.3 },
      target: { i: 7, j: 7 },
    },
    g = navigationGeometry(q);
  assert.equal(g.point(g.origin).i, 2.25);
  assert.equal(g.point(g.origin).j, 2.3);
  assert.notEqual(g.point(g.origin).lat, q.site.lat);
  const sky = () => ({ sun: 1, earth: 1 }),
    options = {
      N,
      cellKm: 0.1,
      slope: q.dem.slope,
      origin: g.origin,
      sky,
      startMs: 0,
      maxHours: 24,
      edgeFor: g.edgeFor,
    },
    full = paretoReach(options),
    targeted = paretoReach({
      ...options,
      goal: g.goal,
      heuristic: g.heuristic,
    });
  assert(Math.abs(full.T[g.goal] - targeted.T[g.goal]) < 1e-5);
  assert(targeted.expanded < full.expanded);
  assert.equal(targeted.incomplete, false);
  const plan = buildTripPlan(
    {
      N,
      points: new Proxy([], { get: (_, k) => g.point(Number(k)) }),
      slope: q.dem.slope,
      start: 0,
      cellKm: 0.1,
      sizeKm: 0.8,
    },
    targeted,
    sky,
    g.goal,
  );
  assert(plan.reachable);
  assert.equal(plan.rows[0].i, q.origin.i);
  assert.equal(plan.rows.at(-1).i, q.target.i);
  assert.equal(plan.rows.at(-1).j, q.target.j);
  assert(tripCSV(plan).includes("-0.175")); // exact x from the rover, not the old 533 m node
});
test("blocked fine-grid corridors do not produce a drivable route", () => {
  const N = 9,
    slope = new Float32Array(N * N);
  for (let j = 0; j < N; j++) slope[j * N + 4] = 35;
  const r = paretoReach({
    N,
    cellKm: 0.1,
    slope,
    origin: 4 * N + 1,
    goal: 4 * N + 7,
    heuristic: (k) => (Math.abs((k % N) - 7) * 0.1) / 0.7,
    sky: () => ({ sun: 1, earth: 1 }),
    startMs: 0,
    maxHours: 5,
  });
  assert(!Number.isFinite(r.T[4 * N + 7]));
});
test("reverse terrain potential matches exhaustive travel times and identifies disconnected goals", () => {
  const N = 9,
    q = {
      dem: {
        N,
        L: 0.8,
        cell: 0.1,
        h: new Float32Array(N * N),
        slope: new Float32Array(N * N),
        centerHeightM: 0,
      },
      site: { lat: -89, lon: 0 },
      origin: { i: 1.25, j: 4.2 },
      target: { i: 7, j: 4 },
    };
  for (let j = 0; j < N; j++) if (j !== 2) q.dem.slope[j * N + 4] = 35;
  const g = navigationGeometry(q);
  const run = () => {
    const it = terrainPotential(g, q.dem.slope);
    let step;
    do step = it.next();
    while (!step.done);
    return step.value;
  };
  const potential = run(),
    full = paretoReach({
      N,
      cellKm: 0.1,
      slope: q.dem.slope,
      origin: g.origin,
      edgeFor: g.edgeFor,
      sky: () => ({ sun: 1, earth: 1 }),
      startMs: 0,
      maxHours: 24,
    });
  assert(Math.abs(potential.times[g.origin] - full.T[g.goal]) < 1e-6);
  assert(potential.times[g.origin] > g.heuristic(g.origin));
  const search = paretoReach({
    N,
    cellKm: 0.1,
    slope: q.dem.slope,
    origin: g.origin,
    edgeFor: g.edgeFor,
    goal: g.goal,
    heuristic: (k) => potential.times[k],
    sky: () => ({ sun: 1, earth: 1 }),
    startMs: 0,
    maxHours: 24,
  });
  assert(Math.abs(search.T[g.goal] - full.T[g.goal]) < 1e-6);
  assert(search.expanded < full.expanded);
  const corridor = terrainCorridor(g, potential, q.dem.slope),
    candidate = paretoReach({
      N,
      cellKm: 0.1,
      slope: corridor,
      origin: g.origin,
      edgeFor: g.edgeFor,
      goal: g.goal,
      heuristic: (k) => potential.times[k],
      sky: () => ({ sun: 1, earth: 1 }),
      startMs: 0,
      maxHours: 24,
    });
  assert(Number.isFinite(candidate.T[g.goal]));
  assert.equal(corridor[4 * N + 4], 35);
  q.dem.slope[2 * N + 4] = 35;
  assert.equal(run().times[g.origin], Infinity);
});
test("zero and very large user time rates keep clock and vehicle steps bounded together", () => {
  assert.equal(modelStepSeconds(0.02, 60), 1.2);
  assert.equal(modelStepSeconds(0.1, 0), 0);
  assert.equal(modelStepSeconds(0.1, 123.45, true), 0);
  assert.equal(modelStepSeconds(0.1, 1e200), 8640);
  assert.equal(modelStepSeconds(1, 3600), 3600);
  assert.equal(modelStepSeconds(0.1, -10), 0);
  assert.equal(modelStepSeconds(0.1, NaN), 0);
});
