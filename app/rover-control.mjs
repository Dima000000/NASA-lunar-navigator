// Rover control layer for Drive: status, brake, autopilot, "wait until charged" and mission extension.
//
// ── API for UI code (window.NASAL.* — all safe to call in any view) ─────────────────────────────────────────────
//   state.roverStatus          Snapshot refreshed ~5x per second while in Drive (same object as roverStatus()):
//     moving, reason           reason: 'ok' | 'idle' | 'starting' | 'paused' | 'mission-ended' | 'waiting-for-charge'
//                              | 'battery-empty' (no charge coming in) | 'charging-wait' (empty, recharging: drives
//                              again at restartPct) | 'too-steep' | 'world-edge-loading' (next terrain window not
//                              in yet) | 'world-edge' (end of the mapped area) | 'route-blocked' | 'no-route'
//                              | 'arrived'
//     message                  One English sentence for that reason ('' when nothing needs saying)
//     warning, warningMessage  'no-sun-low-battery' | 'shadow-low-battery' | '' — advice while the rover still moves
//     speedKmh                 The rover's real simulated speed (never scaled by the time multiplier)
//     timeScale, maxTimeScale  Multiplier in force / the cap that applies now (120 by hand, 3600 on autopilot)
//     battPct, batteryWh, capacityWh, unlimited, depleted, restartPct
//     solarW, loadW, netPowerW, sunFraction, sunlit, charging
//     minutesToFull, fullUTC   Simulated minutes / UTC until full if the rover stays parked (null: not before the
//                              mission ends)
//     minutesToEmpty           At the present load (null: not draining)
//     minutesToRestart         While depleted: until the battery is back at restartPct (null: not in sight)
//     canRechargeHere, minutesToSun, nextSunUTC   Will the Sun reach this spot before the mission ends, and when
//     strandedRisk             'none' | 'shadow' (dark now, Sun returns) | 'no-sun' (no Sun here before the mission
//                              ends: drive out while rangeKm lasts) | 'stranded' (empty, and no Sun before the end)
//     rangeKm                  Flat-ground distance the present charge pays for without sunlight
//     autopilot                {engaged, available (a route exists), remainingKm, etaMinutes, stopped: why it last
//                              disengaged — 'arrived' | 'manual' | 'brake' | 'no-route' | 'off' | …}
//     paused, missionEnded, missionEndUTC, waitingForCharge, wantsToMove, slopeDeg, distKm, earthVisible, utc
//   state.autopilot, state.missionEnded, state.waitingForCharge   Booleans mirrored into state for templates
//   roverStatus(fresh?)        The same snapshot on demand (fresh = recompute the forecast now)
//   brake()                    Stop: cancels autopilot and waiting, drops held on-screen inputs, brakes to rest
//   setAutopilot(on) / toggleAutopilot()   Follow the current route; resumes by itself after a recharge.
//                              Returns {ok, reason}; any manual drive input or brake() disengages it
//   waitUntilCharged()         Parks the rover and fast-forwards simulated time (up to 1 s = 1 day, easing in) until
//                              the battery is full, then drops back to the user's multiplier. Returns
//                              {ok:false, reason:'no-sun-before-mission-end'} at once when it cannot charge here
//   cancelWait()               Stop waiting (also done by any drive input)
//   extendMission(days = 7)    Moves liftoff later, keeps the present time, clears 'mission-ended'. Returns a Promise
// Engine-level equivalents: eng.getRoverStatus(), eng.brake(), eng.setAutopilot(on), eng.pad(name, on).
import { MAX_TIME_SCALE } from "./drive-navigation.mjs";

const hm = (min) =>
  min == null
    ? ""
    : min < 1
      ? "under a minute"
      : min < 90
        ? Math.round(min) + " min"
        : min < 48 * 60
          ? (min / 60).toFixed(1) + " h"
          : (min / 1440).toFixed(1) + " days";

// "2 h 10 min" style, for the battery HUD and banner (simulated mission time).
const hm2 = (min) => {
  if (min == null) return "";
  if (min < 1) return "under a minute";
  const m = Math.round(min);
  if (m < 60) return m + " min";
  if (m < 48 * 60) return Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  return (min / 1440).toFixed(1) + " days";
};

export function withRoverControl(Base, science) {
  return class RoverControl extends Base {
    roverStatus(fresh) {
      return this.eng?.getRoverStatus?.(fresh) ?? null;
    }
    brake(held) {
      this.cancelWait("brake");
      this.eng?.brake(held);
      return this.roverStatus();
    }
    // Space / X on the keyboard reaches the engine directly; this keeps the wait controller in step.
    onRoverBrake() {
      this.cancelWait("brake");
    }
    setAutopilot(on) {
      if (!this.eng || this.state.view !== "drive") return { ok: false, reason: "not-driving" };
      if (!on) {
        this.eng.setAutopilot(false);
        return { ok: true, reason: "off" };
      }
      if (this.state.missionEnded) return { ok: false, reason: "mission-ended" };
      this.cancelWait("autopilot");
      const engaged = this.eng.setAutopilot(true);
      if (engaged) this.driveInput();
      else this.setState({});
      return { ok: engaged, reason: engaged ? "engaged" : "no-route" };
    }
    toggleAutopilot() {
      return this.setAutopilot(!this.eng?.getAutopilot?.());
    }
    waitUntilCharged() {
      const st = this.state.view === "drive" ? this.roverStatus(true) : null;
      if (!st) return { ok: false, reason: "not-driving" };
      if (this._wait) return { ok: true, reason: "waiting", untilUTC: this._wait.targetUTC };
      if (st.unlimited || st.battPct >= 99.95) return { ok: true, reason: "already-full" };
      if (this.state.missionEnded) return { ok: false, reason: "mission-ended" };
      if (st.fullUTC == null) {
        // Not full before the mission ends: wait for whatever sunlight is left, or say that none is coming.
        if (st.nextSunUTC == null || st.missionEndUTC == null) {
          this.setState({ roverNotice: "no-sun-before-mission-end" });
          return { ok: false, reason: "no-sun-before-mission-end" };
        }
      }
      this.eng.brake();
      this._wait = {
        targetUTC: st.fullUTC ?? st.missionEndUTC,
        fromUTC: this._visualUTC,
        scale: 600,
        settle: 0,
        tries: 0,
      };
      this.eng.set({ waitingCharge: true });
      this.setState({ waitingForCharge: true, drivePaused: false, roverNotice: "" });
      return { ok: true, reason: "waiting", untilUTC: this._wait.targetUTC };
    }
    cancelWait(why = "cancelled") {
      if (!this._wait) return false;
      this._wait = null;
      this.eng?.set({ waitingCharge: false });
      this.setState({ waitingForCharge: false, waitEnded: why });
      return true;
    }
    // While waiting, the multiplier eases from up to 1 s = 1 day down to 1 s = 15 min as the target approaches.
    driveRate() {
      const w = this._wait;
      if (!w) return super.driveRate();
      const st = this.roverStatus(),
        now = this._visualUTC ?? w.targetUTC;
      if (!st || st.unlimited || st.battPct >= 99.9) {
        this.cancelWait("full");
        return super.driveRate();
      }
      if (now >= w.targetUTC - 1 && ++w.settle > 2) {
        // Target time reached but not quite full (the forecast is sampled): aim again, a few times at most.
        const fresh = this.roverStatus(true);
        if (fresh?.fullUTC != null && fresh.fullUTC > now + 1000 && w.tries++ < 4) {
          w.targetUTC = fresh.fullUTC;
          w.settle = 0;
        } else {
          this.cancelWait(fresh && fresh.battPct >= 99 ? "full" : "cannot-charge");
          return super.driveRate();
        }
      }
      return (w.scale = Math.max(900, Math.min(MAX_TIME_SCALE, (w.targetUTC - now) / 1000 / 0.8)));
    }
    driveClockLimit() {
      return this._wait ? this._wait.targetUTC : Infinity;
    }
    onDriveClockLimit(ended) {
      if (ended) this.cancelWait("mission-ended");
    }
    driveInput() {
      this.cancelWait("input");
      return super.driveInput();
    }
    async extendMission(days = 7) {
      const s = this.state,
        utc = this._visualUTC ?? s.start + (this._tf ?? s.ti) * s.stepH * 3600000,
        end = Math.min(s.end + days * 86400000, s.start + 730 * 86400000, science?.ephem?.last ?? Infinity);
      if (!(days > 0) || !(end > s.end)) return { ok: false, reason: "limit" };
      try {
        // Load the ephemeris first so the range change applies at once and the clock never jumps.
        await science?.ephem?.ensureRange?.(s.start, end);
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
      const start = this.state.start;
      this.setRange(start, end);
      if (this.state.end !== end) return { ok: false, reason: "range-not-applied" };
      this._tf = Math.max(0, (utc - start) / (this.state.stepH * 3600000));
      this.setState({ ti: Math.floor(this._tf), missionEnded: false, drivePaused: false });
      return { ok: true, end };
    }
    goView(view, ...rest) {
      if (view !== "drive") this.cancelWait("view");
      return super.goView(view, ...rest);
    }
    renderVals() {
      const v = super.renderVals(),
        s = this.state,
        drive = s.view === "drive" && !s.landing;
      // Mission end for the forecast horizon, and the two states only the component knows.
      if (this.eng && drive) {
        const ser = this._ser,
          endUTC = ser ? ser.times[ser.n - 1] : s.end,
          key = endUTC + "|" + !!s.missionEnded;
        if (key !== this._roverEnvKey) {
          this._roverEnvKey = key;
          this.eng.set({ missionEndUTC: endUTC, missionEnded: !!s.missionEnded });
        }
      }
      const st = drive ? this.roverStatus() : null,
        rb = { show: false, cls: "rover-banner mat", text: "" };
      v.roverStatus = st;
      v.rb = rb;
      v.roverStop = () => this.brake();
      v.roverWait = () => this.waitUntilCharged();
      v.roverCancelWait = () => this.cancelWait();
      v.roverExtend = () => this.extendMission(7);
      v.toggleAutopilot = (e) => {
        this.toggleAutopilot();
        // After a pointer click hand the keyboard back to the scene, so Space brakes instead of re-pressing the button.
        if (e?.detail > 0) this._ovEl?.focus({ preventScroll: true });
      };
      v.autopilotOn = !!st?.autopilot?.engaged;
      v.autopilotShow = drive && !!st?.autopilot?.available;
      v.autopilotLabel = v.autopilotOn
        ? "Autopilot on" +
          (st.autopilot.remainingKm ? " · " + (st.autopilot.remainingKm < 1 ? Math.round(st.autopilot.remainingKm * 1000) + " m" : st.autopilot.remainingKm.toFixed(1) + " km") + " left" : "") +
          " · Stop"
        : "Start autopilot ▶";
      v.roverWaitOff = true;
      v.roverWaitMenuLabel = "Wait until charged";
      v.roverWaitMenu = () => {
        if (this._wait) this.cancelWait();
        else this.waitUntilCharged();
        this.setState({ timeMenu: false });
      };
      // Mission-complete dialog: once per mission end (keyed by the end time), in Drive only.
      v.md = { show: false };
      if (st && st.missionEnded && s.missionDoneSeen !== String(st.missionEndUTC ?? s.end)) {
        const key = String(st.missionEndUTC ?? s.end),
          seen = () => this.setState({ missionDoneSeen: key });
        v.md = {
          show: true,
          dist: st.distKm != null ? (st.distKm < 1 ? Math.round(st.distKm * 1000) + " m" : st.distKm.toFixed(2) + " km") : "—",
          batt: st.unlimited ? "unlimited" : Math.round(st.battPct) + "%",
          extend: () => {
            seen();
            this.extendMission(7);
          },
          dates: () => {
            seen();
            this.goView("region");
            this.setState({ sheet: "dates", sitesOpen: false });
          },
          dismiss: seen,
        };
      }
      if (!st) return v;
      const quiet = st.reason === "ok" || st.reason === "idle" || st.reason === "starting",
        noSun = s.roverNotice === "no-sun-before-mission-end" && !st.moving && !st.charging,
        when = (utc) => (utc == null ? "" : new Date(utc).toISOString().slice(5, 16).replace("T", " ") + " UTC");
      // Battery HUD: % plus watts in or out and the time to full / empty (simulated mission time).
      if (!st.unlimited && s.drain !== false) {
        const w = st.netPowerW || 0;
        v.hud.rate =
          " · " +
          (w >= 0.5
            ? "+" + Math.round(w) + " W · " + (st.battPct >= 99.5 ? "full" : st.minutesToFull != null ? "full in " + hm2(st.minutesToFull) : w > 0.5 && st.capacityWh > st.batteryWh ? "full in ~" + hm2(((st.capacityWh - st.batteryWh) / w) * 60) : "not full before mission end")
            : w <= -0.5
              ? "−" + Math.round(-w) + " W · " + (st.minutesToEmpty != null ? "empty in " + hm2(st.minutesToEmpty) : "draining") +
                (st.sunlit ? "" : st.canRechargeHere ? "" : " · no sunlight here")
              : st.sunlit
                ? "holding"
                : st.canRechargeHere
                  ? "dark · Sun in " + hm2(st.minutesToSun)
                  : "no sunlight here");
      }
      rb.reason = st.reason;
      const fallback = {
        paused: "Paused — the clock is stopped.",
        "too-steep": "Too steep here — turn or back up to find a gentler slope.",
        "world-edge-loading": "Loading the next terrain tile — the rover continues in a moment.",
        "world-edge": "End of the mapped area — turn back.",
        "route-blocked": "Route blocked — open the trip plan to pick another route.",
        "no-route": "No route to the target — open the trip plan.",
        arrived: "Arrived at the target.",
        "mission-ended": "Mission time is over.",
        "battery-empty": "Battery empty.",
        "charging-wait": "Battery empty — recharging in sunlight.",
        "waiting-for-charge": "Waiting for the battery to charge.",
      };
      rb.text = quiet
        ? noSun
          ? "No sunlight reaches this spot before the mission ends — waiting here will not charge the battery."
          : st.warningMessage
        : st.message || fallback[st.reason] || "";
      rb.waiting = !!s.waitingForCharge;
      rb.canExtend = st.reason === "mission-ended";
      rb.canResume = st.reason === "paused";
      rb.canTrip = st.reason === "no-route" || st.reason === "route-blocked";
      let tone = quiet ? "warn" : st.reason === "arrived" || st.reason === "waiting-for-charge" ? "info" : "stop";
      // Stranding: strong red once there is no way out, firm amber while range still allows driving out.
      if (st.strandedRisk === "stranded" && !st.missionEnded) {
        tone = "stop stranded";
        rb.text = "Stranded: the battery is empty and no sunlight reaches this spot before the mission ends.";
        rb.canExtend = true;
      } else if (st.strandedRisk === "no-sun" && (st.warning || !st.moving) && !st.missionEnded && !rb.waiting) {
        tone = "stop stranded";
        rb.text =
          "No sunlight here before the mission ends" +
          (st.rangeKm != null ? " — drive out to sunlight while ~" + (st.rangeKm < 1 ? Math.round(st.rangeKm * 1000) + " m" : st.rangeKm.toFixed(1) + " km") + " of range lasts." : ".");
      } else if (quiet && !rb.text && !st.moving && !st.sunlit && !st.unlimited && st.battPct < 99.5 && st.nextSunUTC != null) {
        rb.text = "In shadow — the Sun returns " + when(st.nextSunUTC) + (st.minutesToSun != null ? " (in " + hm2(st.minutesToSun) + ")" : "") + ".";
      }
      if (rb.waiting) {
        tone = "info";
        rb.pct = Math.max(0, Math.min(100, Math.round(st.battPct)));
        rb.text =
          "Waiting for charge · " + rb.pct + "%" +
          (st.charging ? (st.minutesToFull != null ? " · full in " + hm2(st.minutesToFull) : "") : st.minutesToSun != null ? " · Sun in " + hm2(st.minutesToSun) : "") +
          " (mission time)";
      }
      rb.cls += " " + tone;
      rb.show = !!rb.text;
      // "Wait until charged" is offered whenever a parked rover is not full and sunlight is (or will be) available.
      const canWait =
        !st.unlimited && !st.moving && !rb.waiting && !s.missionEnded && st.battPct < 99.5 && st.canRechargeHere;
      rb.canWait = canWait && rb.show && !rb.canResume;
      v.roverWaitOff = !canWait && !rb.waiting;
      v.roverWaitMenuLabel = rb.waiting
        ? "Stop waiting for the battery"
        : "Wait until charged" + (canWait && st.minutesToFull != null ? " · " + hm(st.minutesToFull) : "");
      rb.waitLabel = "Wait until charged" + (st.minutesToFull != null ? " (" + hm2(st.minutesToFull) + ")" : "");
      v.hud.canWait = canWait && !rb.canWait;
      v.hud.waitLabel = "Wait until charged";
      v.hud.waitTitle =
        "Fast-forward the clock until the battery is full" +
        (st.minutesToFull != null ? " — about " + hm(st.minutesToFull) + " of mission time" : "");
      if (rb.waiting && v.timeSmall) v.timeSmall = String(v.timeSmall).replace(/ · [^·]*$/, " · fast-forward");
      // The older one-line HUD message is replaced by the banner.
      v.hud.hasMsg = false;
      return v;
    }
  };
}
