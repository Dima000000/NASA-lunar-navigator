// Rover motion + energy integrator for Drive. Pure functions: the per-frame loop in component.js (stepDrive) and
// tests/rover-sim.test.mjs both run exactly this code, so every control path (keys, on-screen pad, joystick, autopilot)
// integrates distance, clock and battery from the same simulated dt.
//
// Units: world km, simulated seconds, km/s, Wh. The vehicle is the project's explicit scenario rover (science-core
// VEHICLE: 0.7 km/h on flat ground, 20 deg slope limit, 160 Wh battery) — not a real vehicle specification.
// The time multiplier never changes the rover's speed; it only changes how many simulated seconds one frame covers.
import { VEHICLE, clamp, RAD } from "./science-core.mjs";

export const ROVER = Object.freeze({
  accelKmS2: 1.0e-4, // 0.10 m/s² pulling away
  coastKmS2: 1.5e-4, // 0.15 m/s² rolling to a stop when the throttle is released
  brakeKmS2: 4.0e-4, // 0.40 m/s² braking, or throttle against the direction of travel
  reverseFraction: 0.5, // reverse tops out at half the forward speed
  deadZone: 0.08, // joystick/throttle dead zone: below this the rover is told to stop
  stepKm: 0.002, // motion is sub-stepped at <= 2 m so the rover follows the ground at any time multiplier
  maxSubsteps: 1500,
  emptyPct: 0.5, // at or below this the drive motors cut out
  restartPct: 5, // ...and they come back once the battery has recharged to this level
  autoTurnRadS: 0.35, // autopilot pivot rate (simulated time)
  autoAlignRad: 0.5, // autopilot only drives when it points within this angle of the route
  arriveKm: 0.0015, // autopilot stops within 1.5 m of the destination
  manualMaxScale: 120, // fastest time multiplier while driving by hand (0.7 km/h looks like ~84 km/h on screen)
  autoMaxScale: 3600, // fastest multiplier while the autopilot follows a route
  inputRiseS: 0.18, // real-time smoothing of throttle/steering so starts and stops look smooth at any multiplier
  inputFallS: 0.1,
});

const EPS = 1e-9; // km/s; below this the rover is at rest
const wrap = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  return (a < 0 ? a + 2 * Math.PI : a) - Math.PI;
};
export const wrapAngle = wrap;

// Same slope slow-down as the route planner: speed falls linearly to 30 % of flat speed at the slope limit.
export function slopeSpeedFactor(slopeDeg, v = VEHICLE) {
  return Math.max(0.15, 1 - (0.7 * Math.abs(slopeDeg)) / v.maxSlopeDeg);
}

// Real-time easing of a control value towards its target (throttle, steering). Returns exactly 0 at rest so a
// released joystick can never leave a residual throttle behind.
export function easeInput(current, target, realDt) {
  if (!(realDt > 0)) return current;
  const tau = Math.abs(target) > Math.abs(current) ? ROVER.inputRiseS : ROVER.inputFallS,
    next = current + (target - current) * (1 - Math.exp(-realDt / tau));
  return Math.abs(next - target) < 0.01 ? target : next;
}

function slopeAhead(R, env, fx, fz, dir, look) {
  const h0 = env.groundAt(R.pos[0], R.pos[2]),
    h1 = env.groundAt(R.pos[0] + fx * look * dir, R.pos[2] + fz * look * dir);
  return Math.atan((h1 - h0) / look) / RAD;
}
function approach(v, target, braking, wants, h) {
  const moving = Math.abs(v) > EPS,
    opposing = moving && target !== 0 && Math.sign(target) !== Math.sign(v),
    rate = braking
      ? ROVER.brakeKmS2
      : !wants
        ? ROVER.coastKmS2
        : opposing || Math.abs(target) < Math.abs(v)
          ? ROVER.brakeKmS2
          : ROVER.accelKmS2;
  return v + clamp(target - v, -rate * h, rate * h);
}

/**
 * Manual driving for simDt simulated seconds.
 * R   {pos:[x,y,z], heading, v (km/s, signed), dist (km)} — mutated.
 * cmd {throttle -1..1 (fraction of the slope-limited top speed; negative = reverse), turn (rad of heading change to
 *      spread over this step — steering is a real-time control), brake (bool), maxDriveS (seconds of driving the
 *      battery can still pay for; Infinity when charging)}.
 * env {groundAt(x,z) -> km, confine?(x,z) -> [x,z,reason|null], vehicle?}.
 * Returns {driveS (simulated seconds spent moving), movedKm, blocked: null|'too-steep'|<confine reason>, slopeDeg}.
 */
export function stepMotion(R, cmd, simDt, env) {
  const V = env.vehicle || VEHICLE,
    maxV = V.flatSpeedKmh / 3600,
    out = { driveS: 0, movedKm: 0, blocked: null, slopeDeg: 0 };
  if (!(simDt > 0)) return out;
  let thr = clamp(cmd.throttle || 0, -1, 1);
  if (Math.abs(thr) < ROVER.deadZone) thr = 0;
  const n = clamp(Math.ceil((maxV * simDt) / ROVER.stepKm), 1, ROVER.maxSubsteps),
    h = simDt / n,
    turn = (cmd.turn || 0) / n,
    look = Math.max(0.004, maxV * h * 1.5);
  let budget = cmd.maxDriveS ?? Infinity;
  for (let a = 0; a < n; a++) {
    R.heading += turn;
    const want = budget > 0 && !cmd.brake ? thr : 0,
      moving = Math.abs(R.v) > EPS;
    if (!want && !moving) {
      R.v = 0;
      continue;
    }
    const dir = R.v > EPS ? 1 : R.v < -EPS ? -1 : want < 0 ? -1 : 1,
      fx = Math.sin(R.heading),
      fz = -Math.cos(R.heading),
      ang = slopeAhead(R, env, fx, fz, dir, look);
    out.slopeDeg = ang;
    if (Math.abs(ang) > V.maxSlopeDeg) {
      // Too steep in the direction of travel: stop here (turning in place and backing off still work).
      R.v = 0;
      if (want) out.blocked = "too-steep";
      continue;
    }
    const cap = maxV * slopeSpeedFactor(ang, V);
    R.v = clamp(
      approach(R.v, want >= 0 ? want * cap : want * cap * ROVER.reverseFraction, !!cmd.brake, !!want, h),
      -cap * ROVER.reverseFraction,
      cap,
    );
    if (Math.abs(R.v) <= EPS) {
      R.v = 0;
      continue;
    }
    let x = R.pos[0] + fx * R.v * h,
      z = R.pos[2] + fz * R.v * h;
    const c = env.confine ? env.confine(x, z) : null;
    if (c) {
      x = c[0];
      z = c[1];
      if (c[2]) {
        out.blocked = c[2];
        R.v = 0;
      }
    }
    const step = Math.hypot(x - R.pos[0], z - R.pos[2]);
    R.pos[0] = x;
    R.pos[2] = z;
    R.dist += step;
    out.movedKm += step;
    out.driveS += h;
    budget -= h;
  }
  R.pos[1] = env.groundAt(R.pos[0], R.pos[2]);
  return out;
}

/**
 * Autopilot: follow a polyline for simDt simulated seconds. The position stays exactly on the route (no steering
 * oscillation at high time multipliers); speed, slope limit and energy use are the same as in manual driving.
 * route {pts:[{x,z}...], next (index of the vertex being driven to)} — `next` is mutated.
 * Returns stepMotion's result plus {arrived, remainingKm}; blocked is 'route-blocked' when the route crosses ground
 * steeper than the vehicle limit.
 */
export function stepRoute(R, route, cmd, simDt, env) {
  const V = env.vehicle || VEHICLE,
    maxV = V.flatSpeedKmh / 3600,
    pts = route.pts,
    out = { driveS: 0, movedKm: 0, blocked: null, slopeDeg: 0, arrived: false, remainingKm: 0 };
  if (!(simDt > 0) || !pts || pts.length < 1) return out;
  const n = clamp(Math.ceil((maxV * simDt) / ROVER.stepKm), 1, ROVER.maxSubsteps),
    h = simDt / n,
    look = Math.max(0.004, maxV * h * 1.5);
  let budget = cmd.maxDriveS ?? Infinity;
  route.next = clamp(route.next | 0, 0, pts.length - 1);
  for (let a = 0; a < n && !out.arrived; a++) {
    let P = pts[route.next],
      dx = P.x - R.pos[0],
      dz = P.z - R.pos[2],
      d = Math.hypot(dx, dz);
    while (d < 1e-7 && route.next < pts.length - 1) {
      P = pts[++route.next];
      dx = P.x - R.pos[0];
      dz = P.z - R.pos[2];
      d = Math.hypot(dx, dz);
    }
    if (route.next === pts.length - 1 && d <= ROVER.arriveKm) {
      R.v = 0;
      out.arrived = true;
      break;
    }
    const desired = Math.atan2(dx, -dz),
      err = wrap(desired - R.heading),
      maxTurn = ROVER.autoTurnRadS * h;
    R.heading = Math.abs(err) <= maxTurn ? desired : R.heading + Math.sign(err) * maxTurn;
    const aligned = Math.abs(wrap(desired - R.heading)) < ROVER.autoAlignRad,
      want = budget > 0 && !cmd.brake && aligned ? 1 : 0,
      moving = Math.abs(R.v) > EPS;
    if (!want && !moving) {
      R.v = 0;
      continue;
    }
    const fx = dx / d,
      fz = dz / d,
      ang = slopeAhead(R, env, fx, fz, 1, Math.min(look, Math.max(d, 0.001)));
    out.slopeDeg = ang;
    if (Math.abs(ang) > V.maxSlopeDeg) {
      R.v = 0;
      out.blocked = "route-blocked";
      break;
    }
    const cap = maxV * slopeSpeedFactor(ang, V);
    R.v = clamp(approach(Math.max(0, R.v), want * cap, !!cmd.brake, !!want, h), 0, cap);
    if (R.v <= EPS) {
      R.v = 0;
      continue;
    }
    // Advance along the polyline, possibly across several short segments.
    let s = R.v * h;
    const c = env.confine ? env.confine(R.pos[0] + fx * s, R.pos[2] + fz * s) : null;
    if (c && c[2]) {
      R.v = 0;
      out.blocked = c[2];
      break;
    }
    while (s > 0) {
      P = pts[route.next];
      dx = P.x - R.pos[0];
      dz = P.z - R.pos[2];
      d = Math.hypot(dx, dz);
      if (s < d) {
        R.pos[0] += (dx / d) * s;
        R.pos[2] += (dz / d) * s;
        R.dist += s;
        out.movedKm += s;
        s = 0;
      } else {
        R.pos[0] = P.x;
        R.pos[2] = P.z;
        R.dist += d;
        out.movedKm += d;
        s -= d;
        if (route.next === pts.length - 1) {
          R.v = 0;
          out.arrived = true;
          break;
        }
        route.next++;
      }
    }
    out.driveS += h;
    budget -= h;
  }
  R.pos[1] = env.groundAt(R.pos[0], R.pos[2]);
  out.remainingKm = routeRemainingKm(R, route);
  return out;
}
export function routeRemainingKm(R, route) {
  const pts = route?.pts;
  if (!pts?.length) return 0;
  let k = clamp(route.next | 0, 0, pts.length - 1),
    total = Math.hypot(pts[k].x - R.pos[0], pts[k].z - R.pos[2]);
  for (; k < pts.length - 1; k++) total += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
  return total;
}
// Index of the vertex to drive to first: the end of the route segment nearest to the rover.
export function routeStartIndex(pts, x, z) {
  let best = Infinity,
    next = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k],
      b = pts[k + 1],
      dx = b.x - a.x,
      dz = b.z - a.z,
      f = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1),
      dist = Math.hypot(x - a.x - dx * f, z - a.z - dz * f);
    if (dist < best - 1e-9) {
      best = dist;
      next = k + 1;
    }
  }
  return next;
}

/**
 * Battery after totalS simulated seconds of which driveS were spent driving.
 * solarWAt(secondsBeforeNow) is the panel output at the rover's position that long ago; long steps (time jumps,
 * 1 s = 1 day) are sampled every <= 15 min so sunrise and sunset inside the step are not skipped.
 */
export function integrateBattery(wh, totalS, driveS, solarWAt, v = VEHICLE) {
  if (!(totalS > 0)) return clamp(wh, 0, v.capacityWh);
  const samples = Math.min(2000, Math.max(1, Math.ceil(totalS / 900))),
    step = totalS / samples,
    driveW = v.driveW * clamp(driveS / totalS, 0, 1);
  for (let a = 0; a < samples; a++)
    wh = clamp(
      wh + ((solarWAt(totalS - (a + 0.5) * step) - v.idleW - driveW) * step) / 3600,
      0,
      v.capacityWh,
    );
  return wh;
}
// Simulated seconds of driving the battery can pay for at the present solar input before the motors cut out at
// emptyPct (Infinity while it charges).
export function driveBudgetS(wh, solarW, v = VEHICLE) {
  const net = solarW - v.idleW - v.driveW;
  return net >= 0 ? Infinity : (Math.max(0, wh - (ROVER.emptyPct / 100) * v.capacityWh) * 3600) / -net;
}
// Motor cut-out with hysteresis: off at emptyPct, back on at restartPct, so a recharging rover does not stutter.
export function motorsAvailable(wasDepleted, battPct) {
  const depleted = wasDepleted ? battPct < ROVER.restartPct : battPct <= ROVER.emptyPct;
  return { depleted, canDrive: !depleted };
}

/**
 * One Drive frame: motion (manual or autopilot) and battery from the same simulated dt.
 * R    {pos, heading, v, dist, batt (percent), depleted} — mutated.
 * cmd  {throttle, turn, brake, route? ({pts,next}: autopilot follows it instead of the throttle), jumpS? (extra
 *       parked seconds, e.g. a timeline scrub: charge/drain only)}.
 * env  {groundAt, confine?, vehicle?, unlimited?, solarWAt(secondsBeforeNow) -> W at the rover}.
 * The battery pays for every second of driving: when it cannot, the motors cut out inside the step.
 */
export function driveFrame(R, cmd, simDt, env) {
  const V = env.vehicle || VEHICLE,
    cap = V.capacityWh,
    wh = (R.batt / 100) * cap,
    motors = motorsAvailable(R.depleted, R.batt),
    budget = env.unlimited ? Infinity : motors.canDrive ? driveBudgetS(wh, env.solarWAt(0), V) : 0,
    c = { throttle: cmd.throttle, turn: cmd.turn, brake: cmd.brake, maxDriveS: budget },
    out = cmd.route ? stepRoute(R, cmd.route, c, simDt, env) : stepMotion(R, c, simDt, env),
    totalS = Math.max(0, simDt) + Math.max(0, cmd.jumpS || 0);
  R.batt = env.unlimited ? 100 : (integrateBattery(wh, totalS, out.driveS, env.solarWAt, V) / cap) * 100;
  R.depleted = env.unlimited ? false : motorsAvailable(motors.depleted, R.batt).depleted;
  out.depleted = R.depleted;
  out.canDrive = !R.depleted;
  return out;
}

// Forecast sampling: every 15 min for the first day, hourly to day 3, then every 3 h.
export const forecastStepS = (t) => (t < 86400 ? 900 : t < 3 * 86400 ? 3600 : 10800);
// Solar input at one spot sampled on that schedule, a few samples per frame (the horizon atlas lookup behind
// solarWAt is too slow to scan weeks ahead inside one 60 fps frame). solarWAt(secondsFromStart) -> W.
export function createSolarScan(horizonS) {
  return { horizonS: Math.max(0, horizonS), t: 0, starts: [], w: [], done: !(horizonS > 0) };
}
export function advanceSolarScan(scan, solarWAt, budget = Infinity) {
  for (let k = 0; k < budget && !scan.done; k++) {
    const step = forecastStepS(scan.t);
    let w;
    try {
      w = solarWAt(scan.t + step / 2);
    } catch (e) {
      w = NaN;
    }
    if (!Number.isFinite(w)) {
      scan.done = true;
      break;
    }
    scan.starts.push(scan.t);
    scan.w.push(w);
    scan.t += step;
    if (scan.t >= scan.horizonS) scan.done = true;
  }
  return scan.done;
}
// Sampled solar input `seconds` after the scan started (NaN outside the scanned span).
export function scanSolarW(scan, seconds) {
  if (!(seconds >= 0) || seconds >= scan.t) return NaN;
  let lo = 0,
    hi = scan.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (scan.starts[mid] <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return scan.w[lo];
}

/**
 * Parked-rover forecast: what the battery does if the rover stays where it is.
 * solarWAt(secondsFromNow) may throw or return NaN where no data is loaded — the forecast ends there.
 * Returns seconds (Infinity = not within the horizon): nextSunS (panel output first exceeds the idle load; 0 = now),
 * fullS, emptyS (battery first reaches 0 before any full charge), restartS (first back at restartPct after empty).
 */
export function forecastParked(wh, solarWAt, horizonS, v = VEHICLE) {
  const out = { nextSunS: Infinity, fullS: Infinity, emptyS: Infinity, restartS: Infinity, horizonS: 0 },
    cap = v.capacityWh,
    restart = (ROVER.restartPct / 100) * cap;
  if (wh >= cap - 1e-6) out.fullS = 0;
  if (wh <= 0) out.emptyS = 0;
  if (wh >= restart) out.restartS = 0;
  let t = 0;
  while (t < horizonS && out.fullS === Infinity) {
    const step = Math.min(horizonS - t, forecastStepS(t));
    let w;
    try {
      w = solarWAt(t + step / 2);
    } catch (e) {
      break;
    }
    if (!Number.isFinite(w)) break;
    const net = w - v.idleW;
    if (net > 0 && out.nextSunS === Infinity) out.nextSunS = t;
    const after = wh + (net * step) / 3600;
    if (net > 0) {
      if (out.restartS === Infinity && after >= restart) out.restartS = t + ((restart - wh) / net) * 3600;
      if (after >= cap) out.fullS = t + ((cap - wh) / net) * 3600;
    } else if (net < 0 && out.emptyS === Infinity && after <= 0) {
      out.emptyS = t + (wh / -net) * 3600;
      out.restartS = Infinity;
    }
    wh = clamp(after, 0, cap);
    t += step;
    out.horizonS = t;
  }
  return out;
}

/**
 * Why the rover is or is not moving — one machine-readable reason for the UI.
 * q {moving, wants (throttle held or autopilot engaged), missionEnded, paused, depleted, charging, blocked,
 *    autopilot, hasRoute, arrived, waiting}
 */
export function roverReason(q) {
  if (q.missionEnded) return "mission-ended";
  if (q.waiting) return "waiting-for-charge";
  if (q.paused) return "paused";
  if (q.depleted) return q.charging ? "charging-wait" : "battery-empty";
  if (q.blocked) return q.blocked;
  if (q.moving) return "ok";
  if (q.arrived) return "arrived";
  if (q.autopilot && !q.hasRoute) return "no-route";
  return q.wants ? "starting" : "idle";
}
