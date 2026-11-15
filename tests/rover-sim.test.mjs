import test from "node:test";
import assert from "node:assert/strict";
import { VEHICLE, solarPower } from "../app/science-core.mjs";
import {
  ROVER,
  driveFrame,
  stepMotion,
  stepRoute,
  integrateBattery,
  driveBudgetS,
  motorsAvailable,
  forecastParked,
  createSolarScan,
  advanceSolarScan,
  scanSolarW,
  easeInput,
  roverReason,
  routeStartIndex,
  slopeSpeedFactor,
} from "../app/rover-sim.mjs";

const maxV = VEHICLE.flatSpeedKmh / 3600,
  flat = { groundAt: () => 0 },
  rover = (o = {}) => ({ pos: [0, 0, 0], heading: 0, v: 0, dist: 0, batt: 80, depleted: false, ...o }),
  sun = (w) => ({ ...flat, solarWAt: () => w }),
  FULL = solarPower(1);
// Run `seconds` of simulated time in frames of real 1/60 s at a time multiplier, like the Drive loop does.
function run(R, cmd, seconds, scale, env) {
  const dt = scale / 60,
    log = { maxKmh: 0, driveS: 0, blocked: null };
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const r = driveFrame(R, typeof cmd === "function" ? cmd(t) : cmd, Math.min(dt, seconds - t), env);
    log.maxKmh = Math.max(log.maxKmh, Math.abs(R.v) * 3600);
    log.driveS += r.driveS;
    log.blocked = r.blocked || log.blocked;
    log.last = r;
  }
  return log;
}

test("speed is the vehicle's real speed at every time multiplier, and distance = speed x simulated time", () => {
  const results = [1, 60, 600, 3600, 86400].map((scale) => {
    const R = rover(),
      log = run(R, { throttle: 1 }, 3600, scale, sun(0));
    assert.ok(log.maxKmh <= VEHICLE.flatSpeedKmh + 1e-9, "x" + scale + " top speed " + log.maxKmh);
    return { scale, dist: R.dist, batt: R.batt, z: R.pos[2] };
  });
  for (const r of results) {
    // One simulated hour at 0.7 km/h, minus the ~2 s pull-away.
    assert.ok(Math.abs(r.dist - 0.7) < 0.002, "x" + r.scale + " drove " + r.dist + " km");
    assert.ok(Math.abs(r.z + r.dist) < 1e-9, "distance matches displacement");
    // 55 W for one hour out of 160 Wh, from 80 %.
    assert.ok(Math.abs(r.batt - (80 - (55 / 160) * 100)) < 0.2, "x" + r.scale + " battery " + r.batt);
  }
});

test("every control path spends the same energy for the same drive", () => {
  const manual = rover(),
    auto = rover(),
    route = { pts: [{ x: 0, z: 0 }, { x: 0, z: -0.35 }], next: 1 };
  run(manual, { throttle: 1 }, 1800, 60, sun(0));
  const log = run(auto, { route }, 1800, 60, sun(0));
  assert.ok(Math.abs(manual.dist - auto.dist) < 0.002);
  assert.ok(Math.abs(manual.batt - auto.batt) < 0.2);
  assert.ok(log.last.remainingKm < 0.002 || log.last.arrived);
  // Proportional throttle (joystick half way): half the speed, same power draw per second of driving.
  const half = rover(),
    h = run(half, { throttle: 0.5 }, 1800, 60, sun(0));
  assert.ok(Math.abs(h.maxKmh - 0.35) < 1e-6);
  assert.ok(Math.abs(half.batt - manual.batt) < 0.2);
});

test("driving is never free: in shadow the battery drains to empty and the rover stops inside the step", () => {
  const R = rover({ batt: 10 }),
    // 16 Wh minus the 0.8 Wh cut-out reserve at 55 W lasts 995 s; ask for an hour in one huge step and in small ones.
    paid = ((16 - 0.8) * 3600) / 55,
    big = driveFrame(R, { throttle: 1 }, 3600, sun(0));
  assert.ok(Math.abs(big.driveS - paid) < 4, "drove " + big.driveS + " s");
  assert.equal(R.batt, 0);
  assert.equal(R.depleted, true);
  const S = rover({ batt: 10 });
  const log = run(S, { throttle: 1 }, 3600, 60, sun(0));
  assert.ok(Math.abs(log.driveS - paid) < 4, "drove " + log.driveS + " s");
  assert.ok(Math.abs(S.dist - R.dist) < 0.002);
  assert.equal(S.v, 0);
  // Sunlit: the 190 W panel covers the 55 W drive load, so the battery charges while driving (by design).
  const lit = rover({ batt: 50 });
  run(lit, { throttle: 1 }, 600, 60, sun(FULL));
  assert.ok(lit.batt > 50 && lit.dist > 0.11);
});

test("an empty rover recharges in sunlight and drives again from the restart threshold", () => {
  const R = rover({ batt: 0.4 });
  let r = driveFrame(R, { throttle: 1 }, 1, sun(0));
  assert.equal(r.canDrive, false);
  assert.equal(R.v, 0);
  assert.equal(R.dist, 0);
  // Sun returns but the battery is still under the restart threshold: wait.
  r = driveFrame(R, { throttle: 1 }, 60, sun(FULL));
  assert.ok(R.batt < ROVER.restartPct && !r.canDrive && R.dist === 0);
  let waited = 60;
  while (!r.canDrive && waited < 3600) {
    r = driveFrame(R, { throttle: 1 }, 1, sun(FULL));
    waited++;
  }
  assert.ok(R.batt >= ROVER.restartPct - 1e-9, "restarts at " + R.batt + " %");
  assert.ok(waited < 300, "recharged to the threshold in " + waited + " s");
  run(R, { throttle: 1 }, 120, 60, sun(FULL));
  assert.ok(R.dist > 0.02 && R.v > 0, "drives again after recharging");
  assert.deepEqual(motorsAvailable(false, 0.6), { depleted: false, canDrive: true });
  assert.deepEqual(motorsAvailable(true, 4.9), { depleted: true, canDrive: false });
  assert.deepEqual(motorsAvailable(true, 5), { depleted: false, canDrive: true });
  assert.equal(driveBudgetS(55.8, 0), 3600);
  assert.equal(driveBudgetS(1, FULL), Infinity);
});

test("releasing the controls stops the rover; a residual joystick value cannot keep it rolling", () => {
  const R = rover();
  run(R, { throttle: 1 }, 30, 1, sun(0));
  assert.ok(Math.abs(R.v - maxV) < 1e-12);
  const before = R.dist;
  run(R, { throttle: 0.05 }, 30, 1, sun(0)); // inside the dead zone
  assert.equal(R.v, 0);
  assert.ok(R.dist - before < 0.0003, "rolled " + (R.dist - before) * 1000 + " m");
  // Brake stops faster than coasting.
  const a = rover({ v: maxV }),
    b = rover({ v: maxV });
  run(a, { throttle: 0 }, 5, 1, sun(0));
  run(b, { throttle: 1, brake: true }, 5, 1, sun(0));
  assert.equal(a.v, 0);
  assert.equal(b.v, 0);
  assert.ok(b.dist < a.dist);
  // Real-time input easing lands exactly on its target.
  let x = 1;
  for (let i = 0; i < 120; i++) x = easeInput(x, 0, 1 / 60);
  assert.equal(x, 0);
  for (let i = 0; i < 120; i++) x = easeInput(x, 1, 1 / 60);
  assert.equal(x, 1);
});

test("reverse, steering and slopes", () => {
  const R = rover();
  run(R, { throttle: -1 }, 60, 1, sun(0));
  assert.ok(Math.abs(R.v + maxV * ROVER.reverseFraction) < 1e-12);
  assert.ok(R.pos[2] > 0);
  const T = rover();
  driveFrame(T, { throttle: 1, turn: Math.PI / 2 }, 0.5, sun(0));
  assert.ok(Math.abs(T.heading - Math.PI / 2) < 1e-12);
  // 10 deg uphill: slower; 25 deg: blocked, but the rover can still turn and back away.
  const hill = (deg) => ({ groundAt: (x, z) => -z * Math.tan((deg * Math.PI) / 180), solarWAt: () => 0 });
  const up = rover();
  const log = run(up, { throttle: 1 }, 60, 1, hill(10));
  assert.ok(Math.abs(log.maxKmh - 0.7 * slopeSpeedFactor(10)) < 1e-6);
  const wall = rover();
  const blocked = run(wall, { throttle: 1 }, 10, 1, hill(25));
  assert.equal(blocked.blocked, "too-steep");
  assert.equal(wall.dist, 0);
  const side = rover({ heading: Math.PI / 2 });
  run(side, { throttle: 1 }, 10, 1, hill(25));
  assert.ok(side.dist > 0, "across the slope is still drivable");
  // World edge reported by the confine hook.
  const edge = rover();
  const hit = run(edge, { throttle: 1 }, 600, 60, {
    ...sun(0),
    confine: (x, z) => (z < -0.05 ? [x, -0.05, "world-edge"] : [x, z, null]),
  });
  assert.equal(hit.blocked, "world-edge");
  assert.ok(Math.abs(edge.pos[2] + 0.05) < 1e-12 && edge.v === 0);
});

test("autopilot stays on the route, turns to face it and arrives, at any time multiplier", () => {
  const pts = [
    { x: 0, z: 0 },
    { x: 0, z: -0.1 },
    { x: 0.1, z: -0.1 },
    { x: 0.1, z: -0.2 },
  ];
  const ends = [1, 60, 3600].map((scale) => {
    const R = rover({ heading: 2, pos: [0.01, 0, 0.01] }),
      route = { pts, next: routeStartIndex(pts, 0.01, 0.01) };
    assert.equal(route.next, 1);
    let t = 0,
      arrived = false,
      off = 0;
    while (!arrived && t < 7200) {
      const dt = scale / 60;
      const r = driveFrame(R, { route }, dt, sun(FULL));
      arrived = r.arrived;
      t += dt;
      // Distance from the three route legs (after the join leg).
      if (route.next > 1)
        off = Math.max(
          off,
          Math.min(Math.abs(R.pos[0]), Math.abs(R.pos[2] + 0.1), Math.abs(R.pos[0] - 0.1)),
        );
      assert.ok(Math.abs(R.v) * 3600 <= 0.7 + 1e-9);
    }
    assert.ok(arrived, "x" + scale + " arrived");
    assert.ok(off < 1e-9, "x" + scale + " left the route by " + off);
    assert.ok(Math.hypot(R.pos[0] - 0.1, R.pos[2] + 0.2) <= ROVER.arriveKm + 1e-9);
    assert.equal(R.v, 0);
    return { t, dist: R.dist };
  });
  // ~0.314 km at 0.7 km/h plus pivots: the same trip whatever the multiplier (frame size only quantises arrival).
  for (const e of ends) {
    assert.ok(Math.abs(e.dist - ends[0].dist) < 0.002, "distance " + e.dist);
    assert.ok(Math.abs(e.t - ends[0].t) < 120, "duration " + e.t);
  }
  // A wall across the route stops the autopilot with a distinct reason.
  const R = rover(),
    r = driveFrame(R, { route: { pts: [{ x: 0, z: 0 }, { x: 0, z: -1 }], next: 1 } }, 60, {
      groundAt: (x, z) => (z < -0.01 ? (-z - 0.01) * 2 : 0),
      solarWAt: () => 0,
    });
  assert.equal(r.blocked, "route-blocked");
  assert.equal(R.v, 0);
});

test("long clock steps sample the Sun, and the parked forecast finds sunrise, full and empty", () => {
  // Dark for the first 10 h of a 20 h jump, then full sun: empty first, then charged to full.
  const wh = integrateBattery(100, 20 * 3600, 0, (ago) => (ago > 10 * 3600 ? 0 : FULL));
  assert.equal(wh, VEHICLE.capacityWh);
  // Sun first, then dark: ends drained by the 10 h of idle load.
  const end = integrateBattery(100, 20 * 3600, 0, (ago) => (ago > 10 * 3600 ? FULL : 0));
  assert.ok(Math.abs(end - (160 - 100)) < 3);
  // Parked in the dark from 16 Wh: empty after 1.6 h; the Sun returns after 5 h; restart level soon after; full later.
  const f = forecastParked(16, (t) => (t < 5 * 3600 ? 0 : FULL), 30 * 86400);
  assert.ok(Math.abs(f.emptyS - 1.6 * 3600) < 1);
  assert.equal(f.nextSunS, 5 * 3600);
  assert.ok(f.restartS > 5 * 3600 && f.restartS < 5 * 3600 + 300);
  const charge = (160 / (FULL - 10)) * 3600;
  assert.ok(Math.abs(f.fullS - (5 * 3600 + charge)) < 2);
  // Permanently shadowed: never charges within the horizon.
  const dark = forecastParked(80, () => 0, 10 * 86400);
  assert.equal(dark.fullS, Infinity);
  assert.equal(dark.nextSunS, Infinity);
  assert.ok(Math.abs(dark.emptyS - 8 * 3600) < 1);
  // Data runs out: the forecast stops instead of throwing.
  const cut = forecastParked(80, (t) => {
    if (t > 3600) throw Error("not loaded");
    return 0;
  }, 86400);
  assert.ok(cut.horizonS <= 3600 && cut.fullS === Infinity);
  // The same forecast from an incrementally filled scan (a few samples per frame), queried later in time.
  const solar = (t) => (t < 5 * 3600 ? 0 : FULL),
    scan = createSolarScan(10 * 86400);
  let frames = 0;
  while (!advanceSolarScan(scan, solar, 16)) frames++;
  assert.ok(frames > 5 && scan.w.length > 150);
  assert.equal(scanSolarW(scan, 4.9 * 3600), 0);
  assert.equal(scanSolarW(scan, 5.2 * 3600), FULL);
  assert.ok(Number.isNaN(scanSolarW(scan, 11 * 86400)));
  const later = forecastParked(16, (t) => scanSolarW(scan, t + 3600), 9 * 86400); // one hour on
  assert.equal(later.nextSunS, 4 * 3600);
  assert.ok(Math.abs(later.fullS - (4 * 3600 + charge)) < 2);
});

test("one reason explains why the rover is not moving", () => {
  assert.equal(roverReason({ moving: true }), "ok");
  assert.equal(roverReason({ missionEnded: true, depleted: true, paused: true }), "mission-ended");
  assert.equal(roverReason({ paused: true, depleted: true }), "paused");
  assert.equal(roverReason({ depleted: true }), "battery-empty");
  assert.equal(roverReason({ depleted: true, charging: true }), "charging-wait");
  assert.equal(roverReason({ blocked: "too-steep", wants: true }), "too-steep");
  assert.equal(roverReason({ autopilot: true, hasRoute: false }), "no-route");
  assert.equal(roverReason({ arrived: true }), "arrived");
  assert.equal(roverReason({}), "idle");
});
