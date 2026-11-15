import { Ephemeris, VEHICLE, batteryAfter, RAD } from "./science-core.mjs";
import {
  reachSteps,
  slopeAStar,
  pathCorridor,
  slopeRouteLabels,
} from "./route-search.mjs";
import { buildTripPlan } from "./planning-analysis.mjs";
import { smoothPlan } from "./route-smoothing.mjs";
import {
  navigationGeometry,
  navigationSky,
  terrainPotential,
} from "./drive-navigation.mjs";
// Budget of the battery-aware search; beyond it the slope-feasible route is returned, flagged.
const ENERGY_SEARCH_MS = 1200,
  ENERGY_SEARCH_EXPANSIONS = 12000;
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
    const reply = (plan, extra = {}) =>
      postMessage({
        type: "navigation",
        job: q.job,
        terrainKey: q.terrainKey,
        targetKey: q.targetKey,
        origin: q.origin,
        start: q.start,
        plan,
        ...extra,
      });
    const clock = () => performance.now(),
      began = clock(),
      vehicle = { ...VEHICLE, initialFraction: q.battery / 100 };
    // 1. Fast slope-only A*: is there any drivable way at all, and roughly where?
    const base = slopeAStar({
      N: g.N,
      cellKm: q.dem.cell,
      slope: q.dem.slope,
      origin: g.origin,
      goal: g.goal,
      edgeFor: g.edgeFor,
    });
    if (!base.found) {
      reply({
        reachable: false,
        reason:
          "No drivable way there: ground steeper than the rover's 20° limit separates the rover from the destination. Pick a point on this side of the steep ground.",
      });
      return;
    }
    // 2. Energy/time search only inside a corridor around that path, with a bounded budget.
    const corridor = pathCorridor(g.N, base.path, q.dem.slope, 3),
      terrain = terrainPotential(g, corridor);
    let terrainStep;
    do {
      terrainStep = terrain.next();
      if (!terrainStep.done) {
        postMessage({ type: "progress", job: q.job, ...terrainStep.value });
        await new Promise((r) => setTimeout(r, 0));
        if (generation !== token) return;
      }
    } while (!terrainStep.done);
    const potential = terrainStep.value,
      // Longer than the planning horizon even without stops: skip straight to the fallback.
      hopeless = !(potential.times[g.origin] <= q.maxHours),
      deadline = clock() + ENERGY_SEARCH_MS;
    const it = reachSteps({
      N: g.N,
      cellKm: q.dem.cell,
      slope: corridor,
      origin: g.origin,
      goal: g.goal,
      heuristic: (cell) => potential.times[cell],
      edgeFor: g.edgeFor,
      sky,
      startMs: q.start,
      vehicle,
      maxHours: q.maxHours,
      timeBinHours: q.maxHours > 72 ? 3 : 1,
      maxExpansions: ENERGY_SEARCH_EXPANSIONS,
      shouldStop: () => hopeless || clock() > deadline,
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
    let r = n.value,
      searchScope = "terrain corridor";
    const points = new Proxy([], { get: (_, key) => g.point(Number(key)) }),
      trip = {
        N: g.N,
        points,
        slope: q.dem.slope,
        start: q.start,
        sizeKm: q.dem.L,
        cellKm: q.dem.cell,
      };
    let plan;
    if (Number.isFinite(r.T[g.goal])) {
      plan = buildTripPlan(trip, r, sky, g.goal);
      // Any-angle smoothing of the 8-connected grid path (falls back to the grid path).
      plan = smoothPlan(q, g, ephem, plan);
      plan.energyVerified = true;
    } else {
      // 3. The battery-aware search found nothing in its budget: still return the drivable
      // route, timed honestly with charging stops and flagged as not energy-verified.
      searchScope = "slope-only fallback";
      // Light beyond the planning horizon is not loaded; hold the last known sky there.
      const limit = q.start + q.maxHours * 3600000 - 900000,
        held = (cell, ms) => sky(cell, Math.min(ms, limit)),
        heldEphem = {
          state: (ms) => ephem.state(Math.min(ms, limit)),
          topo: ephem.topo,
        },
        labels = slopeRouteLabels({
          N: g.N,
          cellKm: q.dem.cell,
          slope: q.dem.slope,
          path: base.path,
          sky: held,
          startMs: q.start,
          edgeFor: g.edgeFor,
          vehicle,
          maxHours: q.maxHours,
          waitHours: q.maxHours > 72 ? 3 : 1,
        });
      if (!labels) throw Error("Route timing failed. Please try again.");
      plan = buildTripPlan(trip, labels, held, g.goal);
      plan.needsCharging = true;
      plan.energyVerified = false;
      plan.chargingStops = labels.chargingStops;
      plan.depleted = labels.depleted;
      plan.note = labels.depleted
        ? "Drivable route, but the battery runs flat on the way: no sunlight to recharge on this route in the planning window."
        : "Drivable route; the battery must be recharged on the way (stops included in the time).";
      plan = smoothPlan(q, g, heldEphem, plan, VEHICLE, {
        allowDepleted: true,
        maxHours: Infinity,
      });
    }
    reply(plan, {
      expanded: r.expanded,
      searchScope,
      planMs: Math.round(clock() - began),
    });
  } catch (e) {
    if (generation === token)
      postMessage({ type: "navigationError", job: q.job, reason: e.message });
  }
};
