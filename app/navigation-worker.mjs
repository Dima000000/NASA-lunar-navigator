import { Ephemeris, VEHICLE, batteryAfter, RAD } from "./science-core.mjs";
import { reachSteps } from "./route-search.mjs";
import { buildTripPlan } from "./planning-analysis.mjs";
import {
  navigationGeometry,
  navigationSky,
  terrainPotential,
  terrainCorridor,
} from "./drive-navigation.mjs";
let generation = 0;
onmessage = async ({ data: q }) => {
  if (q.type === "cancel") {
    generation++;
    return;
  }
  if (q.type !== "navigate") return;
  const token = ++generation;
  try {
    const years = new Map(
        q.years.map((y) => [y.year, new Ephemeris(y.records, y.meta)]),
      ),
      ephem = {
        state: (ms) => {
          const e = years.get(Math.min(2035, new Date(ms).getUTCFullYear()));
          if (!e) throw Error("Ephemeris year not loaded");
          return e.state(ms);
        },
        topo: (...a) => Ephemeris.prototype.topo(...a),
      },
      g = navigationGeometry(q),
      sky = navigationSky(ephem, q, g);
    if (g.origin === g.goal) {
      const a = g.point(g.origin),
        b = g.coordinates(q.target.i, q.target.j),
        xy = Math.hypot(b.i - a.i, b.j - a.j) * q.dem.cell,
        dz = (b.h - a.h) / 1000,
        gradient = Math.max(
          q.dem.slope[g.goal],
          Math.atan2(Math.abs(dz), xy) / RAD,
        ),
        distance = Math.hypot(xy, dz),
        hours =
          distance /
          VEHICLE.flatSpeedKmh /
          Math.max(0.15, 1 - (0.7 * gradient) / 20),
        initial = (q.battery / 100) * VEHICLE.capacityWh,
        light = navigationSky(ephem, q, {
          point: () => g.coordinates((a.i + b.i) / 2, (a.j + b.j) / 2),
        })(g.origin, q.start + hours * 1800000),
        energy = batteryAfter(
          initial,
          light.sun,
          hours,
          true,
          VEHICLE,
          light.sunDistanceKm,
        );
      let plan;
      if (gradient > 20 || energy <= 0 || hours > q.maxHours)
        plan = {
          reachable: false,
          reason:
            "The destination cannot be reached with the current slope, time or battery.",
        };
      else {
        const points = [a, b],
          r = {
            best: [-1, 1],
            parent: [-1, 0],
            stateCell: [0, 1],
            dist: [0, hours],
            energyWh: [initial, energy],
            incomplete: false,
          };
        plan = buildTripPlan(
          {
            N: q.dem.N,
            points,
            slope: q.dem.slope,
            start: q.start,
            sizeKm: q.dem.L,
            cellKm: q.dem.cell,
          },
          r,
          () => light,
          1,
        );
      }
      postMessage({
        type: "navigation",
        job: q.job,
        terrainKey: q.terrainKey,
        targetKey: q.targetKey,
        origin: q.origin,
        start: q.start,
        plan,
      });
      return;
    }
    if (q.dem.slope[g.origin] > 20 || q.dem.slope[g.goal] > 20) {
      postMessage({
        type: "navigation",
        job: q.job,
        terrainKey: q.terrainKey,
        targetKey: q.targetKey,
        origin: q.origin,
        start: q.start,
        plan: {
          reachable: false,
          reason: "The start or destination exceeds the 20° rover slope limit.",
        },
      });
      return;
    }
    const terrain = terrainPotential(g, q.dem.slope);
    let terrainStep;
    do {
      terrainStep = terrain.next();
      if (!terrainStep.done) {
        postMessage({ type: "progress", job: q.job, ...terrainStep.value });
        await new Promise((r) => setTimeout(r, 0));
        if (generation !== token) return;
      }
    } while (!terrainStep.done);
    const potential = terrainStep.value;
    if (
      !Number.isFinite(potential.times[g.origin]) ||
      potential.times[g.origin] > q.maxHours
    ) {
      postMessage({
        type: "navigation",
        job: q.job,
        terrainKey: q.terrainKey,
        targetKey: q.targetKey,
        origin: q.origin,
        start: q.start,
        plan: {
          reachable: false,
          reason: !Number.isFinite(potential.times[g.origin])
            ? "No terrain path from the rover: the 20° slope limit or blocked corners separate the destination."
            : "Even without charging stops, this terrain route exceeds the selected planning horizon.",
        },
      });
      return;
    }
    const search = async (slope, maxExpansions) => {
      const it = reachSteps({
        N: g.N,
        cellKm: q.dem.cell,
        slope,
        origin: g.origin,
        goal: g.goal,
        heuristic: (cell) => potential.times[cell],
        edgeFor: g.edgeFor,
        sky,
        startMs: q.start,
        vehicle: { ...VEHICLE, initialFraction: q.battery / 100 },
        maxHours: q.maxHours,
        timeBinHours: q.maxHours > 72 ? 3 : 1,
        maxExpansions,
      });
      let n;
      do {
        n = it.next();
        if (!n.done) {
          postMessage({ type: "progress", job: q.job, ...n.value });
          await new Promise((r) => setTimeout(r, 0));
          if (generation !== token) return;
        }
      } while (!n.done);
      if (generation !== token) return;
      return n.value;
    };
    // Try a narrow terrain corridor first; its feasible result is not an optimality claim.
    // If energy/timing makes that corridor unsuitable, expand to the complete fine grid.
    let r = await search(terrainCorridor(g, potential, q.dem.slope), 20000);
    if (!r || generation !== token) return;
    let searchScope = "terrain corridor";
    if (!Number.isFinite(r.T[g.goal])) {
      r = await search(q.dem.slope, 80000);
      searchScope = "full fine grid";
    }
    if (!r || generation !== token) return;
    const points = new Proxy([], { get: (_, key) => g.point(Number(key)) }),
      plan = buildTripPlan(
        {
          N: g.N,
          points,
          slope: q.dem.slope,
          start: q.start,
          sizeKm: q.dem.L,
          cellKm: q.dem.cell,
        },
        r,
        sky,
        g.goal,
      );
    if (!plan.reachable)
      plan.reason = r.incomplete
        ? "No feasible route found within the search budget. Try a closer point or another date."
        : "No energy-feasible route found from the rover for these dates and battery. Try another destination or planning horizon.";
    postMessage({
      type: "navigation",
      job: q.job,
      terrainKey: q.terrainKey,
      targetKey: q.targetKey,
      origin: q.origin,
      start: q.start,
      plan,
      expanded: r.expanded,
      searchScope,
    });
  } catch (e) {
    if (generation === token)
      postMessage({ type: "navigationError", job: q.job, reason: e.message });
  }
};
