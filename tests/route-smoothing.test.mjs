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
