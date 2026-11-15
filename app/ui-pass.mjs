import { GuidedTour } from "./guided-tour.mjs";
import { DriveHelp } from "./drive-help.mjs";
import { conservativeSlopes } from "./route-search.mjs";
import { tripCSV } from "./planning-analysis.mjs";
import { skyPanorama } from "./sky-panorama.mjs";
import { interpolateVisualState } from "./visual-time.mjs";
import { MAX_TIME_SCALE, TIME_PRESETS, timeRateLabel } from "./drive-navigation.mjs";
export function withUIPass(Base, science) {
  return class UIPass extends Base {
    constructor(...args) {
      super(...args);
      this._navJob = 0;
      this._navWorker = new Worker(
        new URL("./navigation-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this._navWorker.onmessage = ({ data: m }) => {
        if (m.job !== this._navJob) return;
        if (m.type === "progress") {
          if (performance.now() - (this._navPaint || 0) > 200) {
            this._navPaint = performance.now();
            this.setState({
              navigationStatus:
                "Planning from the rover… " + m.expanded + " states",
            });
          }
          return;
        }
        this._navBusy = false;
        if (m.type === "navigationError") {
          this.navigationFailure(m.reason);
          return;
        }
        if (m.type === "navigation") {
          if (
            m.terrainKey !== this._tj?.key ||
            m.targetKey !== this.navigationTargetKey()
          )
            return;
          if (!m.plan.reachable) {
            this.navigationFailure(m.plan.reason);
            return;
          }
          this._navigation = m;
          this._navigation.key = "navigation-" + m.job;
          this._tripURLKey = null;
          this.eng?.set({
            navigation: { key: this._navigation.key, points: m.plan.rows },
          });
          this.setState({
            navigationActive: true,
            navigationStatus: "Route ready · " + this.fmtH(m.plan.hours),
            routeAlert: "",
          });
        }
      };
      this._navWorker.onerror = () => {
        this._navBusy = false;
        this.navigationFailure(
          "Navigation could not finish. Please try again.",
        );
      };
      Object.assign(this.state, {
        driveTimeScale: 60,
        routeDays: 1,
        surfaceDetail: true,
      });
    }
    componentDidMount() {
      super.componentDidMount();
      this._driveLayoutListener = () => {
        cancelAnimationFrame(this._driveLayoutRAF);
        this._driveLayoutRAF = requestAnimationFrame(() =>
          this.syncDriveLayout(),
        );
      };
      window.addEventListener("resize", this._driveLayoutListener);
      this._hudResizeObserver = new ResizeObserver(this._driveLayoutListener);
      this._tour = new GuidedTour(this);
      this._tourTimer = setTimeout(() => this._tour.first(), 1200);
      this._driveHelp = new DriveHelp(this);
      // Esc closes the full-screen map / route settings page.
      this._bigMapEsc = (e) => {
        if (e.key !== "Escape" || !this.state.bigMap) return;
        e.preventDefault();
        e.stopPropagation();
        this.setState({ bigMap: false, mapPick: false, mapPlacePick: false });
      };
      window.addEventListener("keydown", this._bigMapEsc, true);
    }
    bestBasis() {
      const s = this.state;
      return [s.start, s.end, s.wSun, s.wEarth, s.wGap, s.obsH, s.sel].join(
        "|",
      );
    }
    syncDriveLayout() {
      const root = document.querySelector(".ui-drive"),
        hud = root?.querySelector(".hud");
      if (!hud) return;
      if (this._hudObserved !== hud) {
        this._hudResizeObserver?.disconnect();
        this._hudResizeObserver?.observe(hud);
        this._hudObserved = hud;
      }
      const bottom = hud.getBoundingClientRect().bottom + "px";
      if (root.style.getPropertyValue("--drive-hud-bottom") !== bottom)
        root.style.setProperty("--drive-hud-bottom", bottom);
    }
    componentDidUpdate() {
      this.updateNavigation();
      super.componentDidUpdate();
      this.syncDriveLayout();
      this.syncCardLayout();
      // The left card is height-capped: bring a freshly opened "+ Add place" popover into view.
      if (this.state.sitesOpen && !this._sitesWasOpen) {
        const pop = document.querySelector("aside.card .addpop");
        if (pop) pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      this._sitesWasOpen = !!this.state.sitesOpen;
      // ...and the landing-point card after a click on the ground.
      const tg = this.state.target,
        tgKey = tg ? tg.i + "," + tg.j : "";
      if (tgKey && tgKey !== this._lastTargetKey) {
        const card = document.querySelector("aside.card .target:not(.empty)");
        if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      this._lastTargetKey = tgKey;
      if (this._bestBasis && this._bestBasis !== this.bestBasis()) {
        this._bestBasis = null;
        this._bestJob = (this._bestJob || 0) + 1;
        this._scienceWorker.postMessage({ type: "cancelBestSpots" });
        this.setState({
          bestSpots: [],
          bestStatus: "Dates or settings changed. Rank the grid again.",
        });
      }
    }
    componentWillUnmount() {
      window.removeEventListener("resize", this._driveLayoutListener);
      window.removeEventListener("keydown", this._bigMapEsc, true);
      cancelAnimationFrame(this._driveLayoutRAF);
      this._hudResizeObserver?.disconnect();
      clearTimeout(this._routeAlertTimer);
      this._navWorker?.terminate();
      clearTimeout(this._tourTimer);
      this._tour?.destroy();
      clearTimeout(this._driveHelpTimer);
      this._driveHelp?.destroy();
      if (this._tripURL) URL.revokeObjectURL(this._tripURL);
      super.componentWillUnmount();
    }
    renderContinuousTime(ms, now = performance.now()) {
      if (this.state.view === "drive" && this._tj)
        this._roverTerrainKey = this._tj.key;
      this._visualUTC = ms;
      const site = this.selSite();
      if (!this.eng || !site) return;
      const st = interpolateVisualState(science.ephem, ms),
        topo = this.eph().topo(
          st,
          site.lat,
          site.lon,
          (this.state.obsH || 2) / 1000,
        );
      this.eng.set({
        sunB: st.sun,
        earthB: st.earth,
        tSun: topo.sun,
        tEarth: topo.earth,
        simUTC: ms,
      });
      if (
        this._tj?.hmap &&
        this.state.view !== "region" &&
        now - (this._continuousShadeAt || 0) > 250
      ) {
        this._continuousShadeAt = now;
        this.sendShade({
          key: this._tj.key,
          utc: ms,
          sun: science.ephem.state(ms).sun,
          bigMap: !!this.state.bigMap,
        });
      }
    }
    joystickEvent(event, release = false) {
      const el = event.currentTarget;
      if (release) {
        this.eng?.joystick(0, 0);
        el.style.setProperty("--joy-x", "0px");
        el.style.setProperty("--joy-y", "0px");
        return;
      }
      if (event.type === "pointerdown") {
        this.capDriveRate?.();
        this._joystickPointer = event.pointerId;
        el.setPointerCapture(event.pointerId);
      }
      if (!el.hasPointerCapture(event.pointerId)) return;
      const r = el.getBoundingClientRect(),
        dx = (event.clientX - r.left - r.width / 2) / (r.width * 0.4),
        dy = (event.clientY - r.top - r.height / 2) / (r.height * 0.4),
        distance = Math.hypot(dx, dy),
        scale = distance > 0.1 ? Math.min(1, distance) / distance : 0;
      this.eng?.joystick(dx * scale, dy * scale);
      el.style.setProperty("--joy-x", dx * scale * 35 + "px");
      el.style.setProperty("--joy-y", dy * scale * 35 + "px");
      event.preventDefault();
    }
    dailyHover(ser, o, i, kind) {
      const day = Math.floor((ser.times[i] - ser.times[0]) / 86400000),
        threshold = this.visThr();
      let count = 0,
        visible = 0;
      for (let j = 0; j < ser.n; j++)
        if (Math.floor((ser.times[j] - ser.times[0]) / 86400000) === day) {
          count++;
          if (
            kind === 2
              ? o.sF[j] >= threshold
              : kind === 3
                ? o.eF[j] >= threshold
                : o.sF[j] >= threshold && o.eF[j] >= threshold
          )
            visible++;
        }
      return this.pct(count ? visible / count : 0) + " of sampled day";
    }
    graphHover(event) {
      const svg = event.currentTarget,
        r = svg.getBoundingClientRect(),
        w = svg.viewBox.baseVal.width,
        px = ((event.clientX - r.left) / r.width) * w,
        f = Math.max(0, Math.min(1, (px - 48) / (w - 118))),
        ser = this.series(),
        i = Math.round(f * (ser.n - 1)),
        kind = Number(svg.dataset.kind),
        n = ser.times[i];
      let line = svg.querySelector(".hover-line");
      if (!line) {
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("class", "hover-line");
        line.setAttribute("stroke", "#fff");
        line.setAttribute("pointer-events", "none");
        svg.append(line);
      }
      for (const [k, v] of Object.entries({
        x1: 48 + f * (w - 118),
        x2: 48 + f * (w - 118),
        y1: 14,
        y2: svg.viewBox.baseVal.height - 24,
      }))
        line.setAttribute(k, v);
      const names = this.state.cmpSel || this.metrics(ser).order.slice(0, 3),
        values = names.map((id) => {
          const o = ser.sites[id],
            site = this.state.sites.find((s) => s.id === id);
          if (!o) return "";
          const value =
            kind === 0
              ? (o.sEl[i] - o.sH[i]).toFixed(2) + "°"
              : kind === 1
                ? (o.eEl[i] - o.eH[i]).toFixed(2) + "°"
                : this.dailyHover(ser, o, i, kind);
          return site.name + ": " + value;
        });
      const tip = svg.parentElement.querySelector(".graph-hover");
      if (tip)
        tip.textContent =
          new Date(n).toISOString().slice(0, 16).replace("T", " ") +
          " UTC · " +
          values.join(" · ");
    }
    // Mission bar domain: a stable window around the mission (2 weeks before,
    // ~6 weeks after) so both handles can move in both directions. It only
    // grows, never shrinks, so handles do not rescale under the pointer.
    missionContext() {
      const day = 86400000,
        { start, end } = this.missionValue();
      this._missionContext ??= {
        start: Math.floor((start - 14 * day) / day) * day,
        end: Math.ceil((end + 45 * day) / day) * day,
      };
      const c = this._missionContext;
      if (!this._missionDrag) {
        c.start = Math.min(c.start, start);
        c.end = Math.max(c.end, end);
      }
      return c;
    }
    // Mission as the user sees it: an in-flight drag or a committed range that
    // is still loading wins over this.state, so re-renders never snap back.
    missionValue() {
      let { start, end } = this.state;
      const p = this._missionPending;
      if (p) {
        if (
          (p.start === start && p.end === end) ||
          performance.now() - p.at > 20000
        )
          this._missionPending = null;
        else ({ start, end } = p);
      }
      const d = this._missionDrag;
      if (d && d.value !== undefined) {
        if (d.which === "landing") start = d.value;
        else end = d.value;
      }
      return { start, end };
    }
    setRange(start, end) {
      if (end <= start) end = start + 86400000;
      if (end - start > 730 * 86400000) end = start + 730 * 86400000;
      this.missionContext();
      this._missionPending = { start, end, at: performance.now() };
      this._missionContext.start = Math.min(this._missionContext.start, start);
      this._missionContext.end = Math.max(this._missionContext.end, end);
      return super.setRange(start, end);
    }
    missionInput(event, which) {
      if (event.type === "keydown" && event.key !== "Enter") return;
      const ms = Date.parse(event.target.value + "Z");
      clearTimeout(this._missionInputTimer);
      if (!Number.isFinite(ms)) return;
      const commit = () => {
        const cur = this.missionValue();
        if ((which === "landing" ? cur.start : cur.end) === ms) return;
        this.setMission(
          which === "landing" ? ms : cur.start,
          which === "liftoff" ? ms : cur.end,
        );
      };
      // Typing fires change per date segment; wait until the user pauses.
      if (event.type === "change")
        this._missionInputTimer = setTimeout(commit, 900);
      else commit();
    }
    setMission(start, end) {
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end - start < 3600000
      ) {
        this.setState({
          missionError:
            "Choose a stay of at least one hour; liftoff must follow landing.",
        });
        return;
      }
      this.setState({ missionError: "" });
      this.setRange(start, end);
    }
    missionPointer(event, which) {
      const el = event.currentTarget,
        bar = el.closest(".mission-selection");
      if (event.type === "pointerdown") {
        const cur = this.missionValue(),
          centre = (h) => {
            const b = h?.getBoundingClientRect();
            return b ? b.left + b.width / 2 : NaN;
          },
          cx = {
            landing: centre(bar.querySelector(".mission-handle.landing")),
            liftoff: centre(bar.querySelector(".mission-handle.liftoff")),
          };
        this._missionDrag = {
          which,
          via: which,
          cx,
          x0: event.clientX,
          // Stacked handles (short mission): the drag direction picks one.
          ambiguous: Math.abs(cx.landing - cx.liftoff) < 20,
          context: { ...this.missionContext() },
          start: cur.start,
          end: cur.end,
          // Keep the grab point under the pointer: no jump on press.
          grab: event.clientX - cx[which],
        };
        el.setPointerCapture(event.pointerId);
      }
      const d = this._missionDrag;
      if (!d || d.via !== which || !el.hasPointerCapture(event.pointerId))
        return;
      if (d.ambiguous && event.type === "pointermove") {
        if (Math.abs(event.clientX - d.x0) < 4) return;
        d.which = event.clientX < d.x0 ? "landing" : "liftoff";
        d.grab = d.x0 - d.cx[d.which];
        d.ambiguous = false;
      }
      const w = d.which,
        c = d.context,
        r = bar.getBoundingClientRect(),
        f = Math.max(
          0,
          Math.min(1, (event.clientX - d.grab - r.left) / r.width),
        ),
        ms = Math.round((c.start + f * (c.end - c.start)) / 3600000) * 3600000;
      if (event.type !== "pointerdown" && !d.ambiguous)
        d.value =
          w === "landing"
            ? Math.min(ms, d.end - 3600000)
            : Math.max(ms, d.start + 3600000);
      if (event.type === "pointerup") {
        this._missionDrag = null;
        if (d.value !== undefined)
          this.setMission(
            w === "landing" ? d.value : d.start,
            w === "liftoff" ? d.value : d.end,
          );
        else this.setState({});
      } else this.setState({});
      event.preventDefault();
    }
    reachOrigin() {
      const j = this._tj,
        r = this.state.rover;
      if (j && r && r.x !== undefined && this._roverTerrainKey === j.key) {
        const d = j.dem,
          cl = (x) => Math.max(0, Math.min(d.N - 1, Math.round(x)));
        return {
          i: cl((r.x + d.L / 2) / d.cell),
          j: cl((-r.z + d.L / 2) / d.cell),
          from: "rover",
        };
      }
      return super.reachOrigin();
    }
    goView(view) {
      if (view === "drive" && this.state.view !== "drive")
        this.setState({ driveCard: false, sitesOpen: false });
      return super.goView(view);
    }
    navigationTargetKey() {
      const t = this.state.target;
      return t ? t.key + "|" + t.i + "|" + t.j : "";
    }
    navigationFailure(reason) {
      this._navigation = null;
      this.eng?.set({ navigation: null });
      clearTimeout(this._routeAlertTimer);
      this.setState({
        navigationActive: false,
        navigationStatus: reason,
        routeAlert: reason,
      });
      this._routeAlertTimer = setTimeout(
        () => this.setState({ routeAlert: "" }),
        10000,
      );
    }
    updateNavigation() {
      const key = this.navigationTargetKey();
      if (
        this._navTargetKey &&
        (this._navTargetKey !== key ||
          (this._navigation &&
            this._tj &&
            this._navigation.terrainKey !== this._tj.key))
      ) {
        this._navWorker.postMessage({ type: "cancel" });
        this._navJob++;
        this._navBusy = false;
        this._navigation = null;
        this._navTargetKey = "";
        this.state.navigationActive = false;
        this.eng?.set({ navigation: null });
      }
      if (!this._navigation || this._navBusy || this.state.view !== "drive")
        return;
      const r = this.eng?.getDriveState(),
        d = this._tj?.dem;
      if (!r || !d || performance.now() - (this._navSentAt || 0) < 1800) return;
      const old = this._navigation.origin,
        dist =
          Math.hypot(
            (r.x + d.L / 2) / d.cell - old.i,
            (-r.z + d.L / 2) / d.cell - old.j,
          ) * d.cell,
        elapsed = Math.abs(
          (this._visualUTC || this.state.start) - this._navigation.start,
        );
      if (
        r.routeNeedsReplan ||
        r.routeCrossTrack > d.cell ||
        dist > d.cell * 4 ||
        elapsed > 3600000
      )
        this.requestNavigation();
    }
    navigationMapPoints() {
      return this.state.navigationActive ? this.eng?.getNavigationPath() : null;
    }
    async requestNavigation() {
      const j = this._tj,
        t = this.state.target;
      if (!j || !t || t.key !== j.key) return;
      this.eng?.ensureRover();
      const r = this.eng?.getDriveState();
      if (!r || r.terrainKey !== j.key) {
        this.navigationFailure(
          "Enter Drive to place the rover before planning a route.",
        );
        return;
      }
      const d = j.dem,
        origin = {
          i: Math.max(0, Math.min(d.N - 1, (r.x + d.L / 2) / d.cell)),
          j: Math.max(0, Math.min(d.N - 1, (-r.z + d.L / 2) / d.cell)),
        },
        start = this._visualUTC ?? this.state.start + this.state.ti * 3600000,
        targetKey = this.navigationTargetKey(),
        job = ++this._navJob;
      this._navWorker.postMessage({ type: "cancel" });
      this._navTargetKey = targetKey;
      this._navBusy = true;
      this._navSentAt = performance.now();
      this.setState({
        navigationStatus: "Planning from the rover…",
        routeAlert: "",
      });
      try {
        await science.ephem.ensureRange(
          start,
          start + (this.state.routeDays || 1) * 86400000,
        );
        if (job !== this._navJob || j.key !== this._tj?.key) return;
        const product = d.product || d.customAtlas;
        if (this._navigation && this._navigation.targetKey !== targetKey) {
          this._navigation = null;
          this.eng?.set({ navigation: null });
        }
        this._navWorker.postMessage({
          type: "navigate",
          job,
          terrainKey: j.key,
          targetKey,
          origin,
          target: { i: t.i, j: t.j },
          start,
          battery: r.batt,
          height: this.state.obsH || 2,
          maxHours: (this.state.routeDays || 1) * 24,
          years: science.ephem.workerYears(),
          dem: {
            N: d.N,
            L: d.L,
            cell: d.cell,
            h: d.h,
            slope: d.slope,
            centerHeightM: d.centerHeightM,
          },
          site: this.selSite(),
          atlas: product.atlas,
          atlasMeta: product.meta.atlas,
        });
      } catch (e) {
        if (job === this._navJob) {
          this._navBusy = false;
          this.navigationFailure(e.message);
        }
      }
    }
    routeHere() {
      this.setState({
        navigationActive: true,
        tripOpen: this.state.view !== "drive",
        sheet: null,
      });
      this.requestNavigation();
    }
    tripView() {
      const m = this._navigation;
      if (!m?.plan?.reachable)
        return {
          status:
            this.state.navigationStatus ||
            "Choose a destination, then Route here.",
          ready: false,
        };
      const p = m.plan,
        key = m.key;
      if (this._tripURLKey !== key) {
        if (this._tripURL) URL.revokeObjectURL(this._tripURL);
        this._tripURL = URL.createObjectURL(
          new Blob([tripCSV(p)], { type: "text/csv" }),
        );
        this._tripURLKey = key;
      }
      const total = p.hours || 1,
        iso = (h) =>
          new Date(p.start + h * 3600000)
            .toISOString()
            .slice(0, 16)
            .replace("T", " ") + " UTC";
      return {
        status:
          "Depart " +
          new Date(p.start).toISOString().slice(0, 16).replace("T", " ") +
          " UTC" +
          (p.incomplete ? " · search budget reached" : ""),
        ready: true,
        summary:
          "Arrive in " +
          (p.hours < 48 ? this.fmtH(p.hours) : (p.hours / 24).toFixed(1) + " days") +
          " · " +
          (p.chargeStops
            ? p.chargeStops + (p.chargeStops === 1 ? " charging stop (" : " charging stops (") + this.fmtH(p.chargeHours) + ")"
            : "no charging stops") +
          " · Earth in view " +
          Math.round(p.earthFraction * 100) +
          "%",
        steps: p.steps.map((s) => ({
          ...s,
          label:
            s.kind === "drive"
              ? "Drive"
              : s.kind === "charge"
                ? "Wait for Sun / charge"
                : "Wait — too dark",
          when: iso(s.start),
          duration: (s.end - s.start).toFixed(1) + " h",
          left: (s.start / total) * 100,
          width: ((s.end - s.start) / total) * 100,
          color:
            s.kind === "drive"
              ? "#40A8FF"
              : s.kind === "charge"
                ? "#F2C94C"
                : "#666",
        })),
        earth: p.earthBands.map((s) => ({
          left: (s.start / total) * 100,
          width: ((s.end - s.start) / total) * 100,
          color: s.visible ? "#5C9470" : "#3A3A3C",
        })),
        batteryPath: p.batteryPath,
        url: this._tripURL,
        start: iso(0),
        end: iso(p.hours),
      };
    }
    async findBestSpots() {
      try {
        this._bestBasis = this.bestBasis();
        if (this.state.view === "region") this.goView("terrain");
        await this.loadTask(() =>
          Promise.all([
            science.ephem.ensureRange(this.state.start, this.state.end),
            science.loadTerrain(this.selSite().key),
          ]),
        );
        this.ensureTerrain();
        let count = 0;
        while (!this._tj?.hmap && count++ < 100)
          await new Promise((r) => setTimeout(r, 100));
        const j = this._tj,
          product = j.dem.product || j.dem.customAtlas;
        if (!product)
          throw Error("Measured horizon data are unavailable at this place.");
        this.syncWorkerYears();
        const a = product.meta.atlas,
          N = a.N,
          stride = (j.dem.N - 1) / (N - 1),
          points = [];
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++) {
            const i = Math.round(x * stride),
              k = Math.round(y * stride);
            points.push({
              ...science.geoFor(j.dem, i, k),
              h: j.dem.centerHeightM + j.dem.h[k * j.dem.N + i] * 1000,
            });
          }
        this._bestJob = (this._bestJob || 0) + 1;
        this._scienceWorker.postMessage({ type: "cancelBestSpots" });
        this._scienceWorker.postMessage({
          type: "bestSpots",
          job: this._bestJob,
          N,
          atlas: product.atlas,
          atlasMeta: a,
          points,
          slope: conservativeSlopes(j.dem.slope, j.dem.N, N),
          height: this.state.obsH || 2,
          start: this.state.start,
          end: this.state.end,
          weights: [this.state.wSun, this.state.wEarth, this.state.wGap],
          threshold: 0.0005,
        });
        this.setState({
          bestSpots: [],
          bestStatus: "Ranking measured grid points…",
        });
      } catch (e) {
        this.setState({ bestStatus: e.message });
      }
    }
    renderVals() {
      const v = super.renderVals();
      v.startTour = () => this._tour?.start();
      v.driveHudClass =
        "hud mat" + (this.state.driveStatusOpen ? " hud-expanded" : "");
      v.driveStatusOpen = !!this.state.driveStatusOpen;
      v.toggleDriveStatus = () =>
        this.setState({ driveStatusOpen: !this.state.driveStatusOpen });
      v.appCls += " ui-pass" + (this.state.view === "drive" ? " ui-drive" : "");
      v.hud = {
        ...v.hud,
        rate: v.hud.rate.replace("charging ", "· ").replace("draining ", "· "),
        sun: v.hud.sun.replace("In sunlight", "Sunlit"),
        earth: v.hud.earth === "Earth link" ? "Earth in view" : v.hud.earth,
        skipLabel: v.hud.skipLabel
          .replace("Skip to Earthrise (", "Earthrise in ")
          .replace(")", " →"),
      };
      for (const c of v.chartRows || [])
        for (const q of c.panels) {
          q.thrLabelX = Number(q.x1) + 6;
          for (let k = 0; k < 3; k++) q["e" + k].label = "";
        }
      if (v.sct) {
        for (let k = 0; k < 6; k++) v.sct["p" + k].t = "";
      }
      const ser = this.series(),
        met = this.metrics(ser);
      const periodDays = Math.max(1, Math.round(((ser.n - 1) * ser.stepH) / 24)),
        periodTxt = " Over the whole " + periodDays + "-day period shown below.";
      const explain = {
        Sunlight: "Share of time the Sun is above the local skyline." + periodTxt,
        "Earth in view":
          "Share of time Earth is above the terrain skyline; not a guaranteed radio link." +
          periodTxt,
        "Longest night":
          "Longest single stretch without sunlight (no solar charging)." +
          periodTxt,
        "Longest Earth gap":
          "Longest single stretch with Earth below the skyline." + periodTxt,
      };
      for (const col of v.cmpCols || []) {
        col.moreRows = col.rows.filter((_, i) => i === 2 || i === 5);
        col.rows = col.rows
          .filter((_, i) => i !== 2 && i !== 5)
          .map((row) => ({
            ...row,
            name: row.name
              .replace("Earth contact", "Earth in view")
              .replace("Longest darkness", "Longest night")
              .replace("Longest without Earth", "Longest Earth gap"),
          }));
        for (const row of col.rows) row.help = explain[row.name] || "";
        col.why = col.rows
          .slice(0, 2)
          .map((x) => x.name + " " + x.value)
          .join(" · ");
      }
      if (v.sc) {
        const r = met.res[this.state.sel];
        if (r)
          v.sc.rows = [
            ["Sunlight", this.pct(r.sun)],
            ["Earth in view", this.pct(r.ear)],
            ["Longest night", (r.dark > 0 ? this.dur(r.dark) : "none")],
            ["Longest Earth gap", (r.nocomm > 0 ? this.dur(r.nocomm) : "none")],
          ].map(([name, value]) => ({
            name,
            value,
            reason: explain[name],
            pct: 0,
            color: "#98989F",
            tgt: -10,
          }));
      }
      for (const p of v.places || []) {
        const site = this.state.sites.find((s) => s.name === p.name),
          r = site && met.res[site.id];
        if (!r) continue;
        p.rows = [
          ["Sunlight", this.pct(r.sun), "#FFD60A"],
          ["Earth in view", this.pct(r.ear), "#40A8FF"],
          ["Longest night", (r.dark > 0 ? this.dur(r.dark) : "none"), "#98989F"],
          ["Longest Earth gap", (r.nocomm > 0 ? this.dur(r.nocomm) : "none"), "#98989F"],
        ].map(([name, value, color]) => ({
          name,
          value,
          color,
          reason: explain[name],
        }));
        p.why =
          "Over the whole " +
          periodDays +
          "-day period · Sun and Earth together " +
          this.pct(r.both);
        p.moreRows = [
          { name: "Quasi-continuous light", value: (r.lqcip > 0 ? this.dur(r.lqcip) : "none") },
        ];
      }
      v.driveZoom = Math.log(this.eng?.getDriveZoom?.() || 0.025);
      v.onDriveZoom = (e) =>
        this.eng?.setDriveZoom(Math.exp(Number(e.target.value)));
      v.driveZoomIn = () => this.eng?.zoom(0.7);
      v.driveZoomOut = () => this.eng?.zoom(1.4);
      v.driveZoomReset = () => this.eng?.resetDriveZoom();
      this.eng?.set({
        driveTimeScale: this.state.driveTimeScale,
        drivePaused: !!this.state.drivePaused,
      });
      v.findRover = () => this.eng?.findRover();
      v.driveLayersOpen = !!this.state.driveLayersOpen;
      v.toggleDriveLayers = () =>
        this.setState({ driveLayersOpen: !this.state.driveLayersOpen });
      if (this.state.driveLayersOpen) v.appCls += " drive-layers-open";
      v.timeOptionsLabel = this.state.view === "drive" ? "Rover" : "Options";
      // Mission dates (landing/liftoff handles, scrubbable timeline, Dates)
      // live only in Overview; other modes get a compact date + speed bar.
      const simBar = this.state.view !== "region";
      if (simBar) v.appCls += " ui-sim";
      v.simSpeedInline = simBar && this.state.view !== "drive";
      v.showTimeMenuBtn = !v.simSpeedInline;
      if (!v.showTimeMenuBtn) v.timeMenu = false;
      v.bigMapTitle = v.bigMapPre + (v.cur?.name ? " · " + v.cur.name : "");
      // First visit to Drive: a short how-to once the rover is on screen (after the main tour, if it is running).
      if (
        this.state.view === "drive" &&
        !this.state.landing &&
        !this._driveHelpTimer &&
        this._driveHelp &&
        !this._driveHelp.seen()
      )
        this._driveHelpTimer = setTimeout(() => {
          this._driveHelpTimer = null;
          if (
            this.state.view === "drive" &&
            !this.state.landing &&
            !(this._tour?.index >= 0) &&
            this.eng?.getDriveState?.()
          )
            this._driveHelp.maybeShow();
          else if (this.state.view === "drive") this.setState({});
        }, 900);
      if (this.state.view === "drive") {
        const paused =
          !!this.state.drivePaused || this.state.driveTimeScale === 0;
        if (paused) v.hud.kmh = "0.0 km/h";
        v.playing = !paused;
        v.notPlaying = paused;
        v.playLabel = paused ? "Resume simulation" : "Pause simulation";
        v.togglePlay = () =>
          this.setState({
            drivePaused: !paused,
            driveTimeScale:
              this.state.driveTimeScale === 0
                ? this._lastDriveRate || 60
                : this.state.driveTimeScale,
          });
      }
      v.commitDriveTime = (e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
          this._ovEl?.focus({ preventScroll: true });
        }
      };
      v.driveTimeScale = this.state.driveTimeScale;
      v.onDriveTimeScale = (e) => {
        const value = e.target.valueAsNumber ?? Number(e.target.value);
        if (!Number.isFinite(value) || value < 0) {
          e.target.setCustomValidity("Enter a finite number of zero or more.");
          e.target.reportValidity();
          return;
        }
        e.target.setCustomValidity("");
        const rate = Math.min(MAX_TIME_SCALE, value);
        if (rate !== value) e.target.value = rate;
        if (rate > 0) this._lastDriveRate = rate;
        this.setState({ driveTimeScale: rate });
      };
      // » cycles real time → 1 min → 10 min → 1 h → 1 day per real second.
      const rateNow = this.state.driveTimeScale,
        nextRate =
          TIME_PRESETS.find((r) => r > rateNow + 1e-9) ?? TIME_PRESETS[0];
      v.toggleTurbo = () => {
        this._lastDriveRate = nextRate;
        this.setState({ driveTimeScale: nextRate, drivePaused: false });
      };
      v.turbo = rateNow > 60;
      v.turboText = rateNow > 0 ? "×" + (rateNow >= 10000 ? Math.round(rateNow / 1000) + "k" : +rateNow.toFixed(1)) : "×0";
      v.turboLabel =
        "Speed up time: now " +
        timeRateLabel(rateNow) +
        ". Click for " +
        timeRateLabel(nextRate);
      if (this.state.view === "drive" && this._visualUTC) {
        v.timeSmall =
          new Date(this._visualUTC).toISOString().slice(11, 19) +
          " UTC · " +
          (this.state.drivePaused ? "paused" : timeRateLabel(this.state.driveTimeScale));
      }
      v.joyDown = (e) => this.joystickEvent(e);
      v.joyMove = (e) => this.joystickEvent(e);
      v.joyUp = (e) => this.joystickEvent(e, true);
      if (this.state.sheet === "charts")
        for (const col of v.cmpCols || []) {
          const site = this.state.sites.find((s) => s.name === col.name);
          if (site) {
            const o = ser.sites[site.id];
            col.panorama = skyPanorama(
              o,
              this.state.model === "G1" ? this.profileFor(site) : null,
              Math.min(this.state.ti, ser.n - 1),
            );
          }
        }
      const questions = [
        "When is the Sun up?",
        "When can you see Earth?",
        "How much sunlight each day?",
        "How often is Earth visible each day?",
        "When are both available?",
      ];
      (v.chartRows || []).forEach((c, index) => {
        c.title = questions[index];
        c.insight = (v.cmpCols || [])
          .map(
            (col) =>
              col.name +
              ": " +
              (index === 4
                ? this.pct(
                    met.res[
                      this.state.sites.find((s) => s.name === col.name)?.id
                    ]?.both || 0,
                  )
                : col.rows[index === 1 || index === 3 ? 1 : 0]?.value || ""),
          )
          .join(" · ");
        for (const q of c.panels) {
          q.kind = index;
          q.hover = (e) => this.graphHover(e);
          const top = 14,
            bottom = Number(q.yBY) - 4,
            threshold =
              index === 0 || index === 1
                ? (top + bottom) / 2
                : bottom - (index === 2 ? 0.65 : 0.5) * (bottom - top),
            x = 48,
            width = Number(q.x1) - x;
          q.good =
            "M" + x + " " + top + "h" + width + "V" + threshold + "H" + x + "Z";
          q.bad =
            "M" +
            x +
            " " +
            threshold +
            "h" +
            width +
            "V" +
            bottom +
            "H" +
            x +
            "Z";
        }
      });
      if (this.state.sheet === "charts") {
        const selected = this.state.sites.slice(0, 6),
          minimum = Math.max(
            0,
            Math.min(
              0.4,
              Math.floor(
                (Math.min(...selected.map((s) => met.res[s.id].sun)) - 0.1) *
                  10,
              ) / 10,
            ),
          ),
          SX = (x) => 64 + ((x - minimum) / (1 - minimum)) * 556,
          SY = (y) => 250 - y * 234;
        v.sct.xMin = Math.round(minimum * 100) + "%";
        v.sct.xMid = Math.round((minimum + 1) * 50) + "%";
        v.sct.zone =
          "M" + SX(0.65) + " 16H620V" + SY(0.5) + "H" + SX(0.65) + "Z";
        v.sct.grid = [0.25, 0.5, 0.75]
          .map((f) => "M64 " + SY(f) + "H620M" + (64 + 556 * f) + " 16V250")
          .join("");
        v.sct.thr = "M" + SX(0.65) + " 16V250M64 " + SY(0.5) + "H620";
        for (const [k, site] of selected.entries()) {
          v.sct["p" + k].x = SX(met.res[site.id].sun);
          v.sct["p" + k].y = SY(met.res[site.id].ear);
        }
        v.sct.t65x = SX(0.65) + 8;
      }
      v.modelNote =
        this.state.model === "G1"
          ? "Based on NASA LOLA terrain and JPL ephemerides. Earth in view ≠ guaranteed radio link."
          : "Ideal horizon (G0): terrain obstruction excluded. Earth in view ≠ guaranteed radio link.";
      v.showDriveLegend =
        this.state.view === "drive" && this.state.layer !== "off";
      if (v.showDriveLegend) v.appCls += " drive-analysis";
      if (this.state.view === "drive") {
        v.showLegend = false;
        v.showLegendBox = false;
      }
      if (this.state.driveStatusOpen) v.appCls += " drive-details-open";
      if (this.state.driveCard) {
        v.appCls += " drive-card-open";
        if (!this._dataLoading && !this._detailLoading && !this._dataError)
          v.showTip = false;
      }
      v.surfaceDetail = this.state.surfaceDetail;
      v.toggleSurfaceDetail = () =>
        this.setState({ surfaceDetail: !this.state.surfaceDetail });
      this.eng?.set({ surfaceDetail: this.state.surfaceDetail });
      const mission = this.missionValue(),
        context = this.missionContext(),
        length = context.end - context.start,
        startPct = ((mission.start - context.start) / length) * 100,
        endPct = ((mission.end - context.start) / length) * 100,
        iso = (ms) => new Date(ms).toISOString().slice(0, 16);
      v.missionStart = iso(mission.start);
      v.missionEnd = iso(mission.end);
      v.missionError = this.state.missionError || "";
      v.missionStartLabel = v.missionStart.replace("T", " ") + " UTC";
      v.missionEndLabel = v.missionEnd.replace("T", " ") + " UTC";
      v.missionStartPct = startPct;
      v.missionEndPct = endPct;
      v.missionWidth = endPct - startPct;
      v.missionCancel = () => {
        this._missionDrag = null;
        this.setState({});
      };
      v.missionLandingPointer = (e) => this.missionPointer(e, "landing");
      v.missionLiftoffPointer = (e) => this.missionPointer(e, "liftoff");
      v.onMissionStart = (e) => this.missionInput(e, "landing");
      v.onMissionEnd = (e) => this.missionInput(e, "liftoff");
      v.missionLandingKey = (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const cur = this.missionValue();
          this.setMission(
            cur.start + (e.key === "ArrowRight" ? 1 : -1) * 3600000,
            cur.end,
          );
        }
      };
      v.missionLiftoffKey = (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const cur = this.missionValue();
          this.setMission(
            cur.start,
            cur.end + (e.key === "ArrowRight" ? 1 : -1) * 3600000,
          );
        }
      };
      v.landPct = "0";
      v.departPct = "100";
      v.missionW = "100";
      v.landTxt = v.missionStartLabel;
      v.departTxt = v.missionEndLabel;
      v.setLanding = () =>
        this.setMission(ser.times[this.state.ti], this.state.end);
      v.setDepart = () =>
        this.setMission(this.state.start, ser.times[this.state.ti]);
      const originalMapClick = v.onMapClick;
      v.onMapClick = (e) => {
        originalMapClick(e);
        if (
          this.state.view === "drive" &&
          this.state.mapReach &&
          this.state.target
        )
          this.routeHere();
      };
      v.targetPointLabel =
        this.state.view === "drive" ? "Destination" : "Your landing point";
      v.routeHere = () => this.routeHere();
      v.tripOpen = !!this.state.tripOpen;
      v.closeTrip = () => this.setState({ tripOpen: false });
      v.trip = v.tripOpen ? this.tripView() : {};
      if (this._navigation && this._navigation.terrainKey === this._tj?.key)
        this.eng?.set({
          navigation: {
            key: this._navigation.key,
            points: this._navigation.plan.rows,
          },
        });
      // Route planning starts from the rover, so it is a Drive-only action.
      v.showRouteAction =
        this.state.view === "drive" &&
        !!this.state.target &&
        (!this._navigation ||
          this._navigation.targetKey !== this.navigationTargetKey());
      v.navigationBusy = !!this._navBusy;
      v.routeActionLabel = this._navBusy ? "Planning…" : "Route here";
      v.navigationActive = !!this._navigation;
      v.navigationStatus = this.state.navigationStatus || "";
      v.openTrip = () => this.setState({ tripOpen: true });
      v.routeAlert = this.state.routeAlert || "";
      v.hasRouteAlert = !!v.routeAlert;
      v.closeRouteAlert = () => this.setState({ routeAlert: "" });
      if (v.tgt && (this.state.view === "drive" || this.eng?.getDriveState()))
        v.tgt.drive = this._navBusy
          ? "Planning from the rover…"
          : this._navigation
            ? "Route from rover · " +
              this._navigation.plan.hours.toFixed(1) +
              " h"
            : "Choose Route here to plan from the rover.";
      v.validationFacts = science.status.horizonsMonthVerified
        ? science.status.samples +
          " samples · " +
          science.status.sites +
          " places · maximum elevation error " +
          science.status.maxElevationErrorDeg.toPrecision(3) +
          "° before CSV rounding"
        : "Independent monthly validation pending.";
      v.findBestSpots = () => this.findBestSpots();
      v.bestStatus =
        this.state.bestStatus ||
        "Ranked on the 533 m grid using the same score as Landing windows.";
      v.bestRows = (this.state.bestSpots || []).map((p, i) => ({
        ...p,
        rank: i + 1,
        coords: this.fmtCoords(p),
        summary:
          Math.round(p.score * 100) +
          " score · Sun " +
          this.pct(p.sun) +
          " · Earth " +
          this.pct(p.earth) +
          " · longest night " +
          p.darkHours +
          " h",
        pick: () => {
          const stride = (this._tj.dem.N - 1) / 30;
          this.setState({
            target: { i: p.i * stride, j: p.j * stride, key: this._tj.key },
            sheet: null,
          });
          this.goView("terrain");
          setTimeout(
            () => this.eng?.focusGrid(p.i * stride, p.j * stride),
            100,
          );
        },
      }));
      this.eng?.set({ bestSpots: this.state.bestSpots || [] });
      v.routeDays = this.state.routeDays;
      v.onRouteDays = async (e) => {
        const days = Number(e.target.value);
        await science.ephem.ensureRange(
          this.state.start,
          this.state.end + days * 86400000,
        );
        this.syncWorkerYears();
        this._routeWanted = null;
        this.setState({ routeDays: days });
      };
      // Travel time / drive range is computed only on request in Drive.
      const inDrive = this.state.view === "drive";
      v.travelOverlay = inDrive && !!this.state.travelOverlay;
      v.reachOn = inDrive && !!this.state.mapReach;
      v.showTravelLegend = v.travelOverlay && !this.state.tripOpen;
      v.toggleTravelOverlay = () => {
        const on = !v.travelOverlay;
        this.setState({ travelOverlay: on, mapReach: on || this.state.mapReach });
        if (on && !inDrive) this.goView("drive");
      };
      v.toggleReach = () => {
        const on = !v.reachOn;
        this.setState({ mapReach: on, ...(on ? {} : { travelOverlay: false }) });
        if (on && !inDrive) this.goView("drive");
      };
      v.routeSampling =
        this.state.routeDays > 3
          ? "3 h time labels · 15 min energy samples"
          : "1 h time labels · 15 min energy samples";
      if (this._routePending && this.state.mapReach)
        v.routeStatus =
          "Updating range; previous solution remains visible · " +
          (this._routeExpanded || 0) +
          " states explored";
      if (
        this._routeResult &&
        this._travelKey !== this._routeResult.key &&
        this._tj
      ) {
        this._travelKey = this._routeResult.key;
        this.eng?.setTravel(
          this._routeResult.T,
          this._routeResult.N,
          this._routeResult.maxHours,
        );
      }
      if (this._tj && this._geoLabelKey !== this._tj.key) {
        this._geoLabelKey = this._tj.key;
        const d = this._tj.dem,
          n = d.N - 1;
        this._geoLabels = [
          [0, n / 2],
          [n, n / 2],
          [n / 2, 0],
          [n / 2, n],
        ].map(([i, j]) => {
          const p = science.geoFor(d, i, j);
          return { i, j, text: this.fmtCoords(p) };
        });
      }
      this.eng?.set({ travelGeoLabels: this._geoLabels || [] });
      this.eng?.set({
        travelOverlay: inDrive && !!this.state.travelOverlay,
        travelContours: this._routeResult?.contours || [],
        travelOrigin: this.reachOrigin(),
      });
      this.placesPanelVals(v);
      return v;
    }
    syncCardLayout() {
      // Keep the left places card above the timeline, whatever its height.
      const app = document.querySelector(".app.ui-pass"),
        time = app?.querySelector('section[aria-label="Mission timeline"]');
      if (!app) return;
      if (!this._cardTimeObserver && time && window.ResizeObserver) {
        this._cardTimeObserver = new ResizeObserver(() => this.syncCardLayout());
        this._cardTimeObserver.observe(time);
        window.addEventListener("resize", () => this.syncCardLayout());
      }
      const r = time?.getBoundingClientRect(),
        top = r && r.height > 0 ? r.top : window.innerHeight,
        h = Math.max(160, Math.round(top - 20 - 12)) + "px";
      if (app.style.getPropertyValue("--card-max-h") !== h)
        app.style.setProperty("--card-max-h", h);
    }
    shortSiteName(site) {
      return String(site?.name || "the pin").split(" · ")[0];
    }
    addDemPlace(i, j, name) {
      const s = this.state,
        jb = this._tj;
      if (!jb) return;
      if (s.sites.length >= 6) {
        this.setState({ addErr: "You can compare up to 6 places." });
        return;
      }
      const d = jb.dem,
        c = (d.N - 1) / 2,
        dx = (i - c) * d.cell,
        dy = (j - c) * d.cell,
        dist = Math.round(Math.hypot(dx, dy) * 1000),
        az = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
        where =
          dist < 60
            ? "at " + this.shortSiteName(this.selSite())
            : (dist >= 1000 ? (dist / 1000).toFixed(1) + " km " : dist + " m ") +
              this.compass(az) +
              " of " +
              this.shortSiteName(this.selSite()),
        geo = science.geoFor(d, i, j),
        used = s.sites.map((x) => x.color),
        color = this.palette().find((cc) => !used.includes(cc)) || "#98989F",
        id = "s" + this._nextId++,
        label = (name ? name + " · " : "Spot ") + where;
      // Close the picker now; the new site's horizon may still need loading.
      this.setState({
        mapPlacePick: false,
        sitesOpen: false,
        pick: false,
        ...(this._mapPickOpenedBig ? { bigMap: false } : {}),
      });
      this._mapPickOpenedBig = false;
      // Keep the current selection so the terrain (and the rover) stay put.
      this.setState({
        sites: this.state.sites.concat([
          {
            id,
            key: "",
            name: label.charAt(0).toUpperCase() + label.slice(1),
            lat: Math.round(geo.lat * 10000) / 10000,
            lon: Math.round(geo.lon * 10000) / 10000,
            approx: false,
            color,
          },
        ]),
        addErr: "",
      });
    }
    placesPanelVals(v) {
      const s = this.state,
        jb = this._tj,
        isRegion = s.view === "region",
        full = s.sites.length >= 6,
        fullTxt = "Compare is full (6 places)";
      v.addLabel = s.sitesOpen ? "Close" : "+ Add place";
      v.presetChips = (v.presetChips || []).map((p) => {
        const [short, ...rest] = String(p.name).split(" · ");
        return { ...p, short, code: rest.join(" · ") };
      });
      v.catalogCount = v.presetChips.length
        ? v.presetChips.length + " more"
        : "all added";
      // Rover location
      const r = s.rover,
        roverHere = !!(
          jb &&
          r &&
          r.x !== undefined &&
          this._roverTerrainKey === jb.key &&
          !isRegion
        );
      v.roverAddDisabled = full || !roverHere;
      v.roverAddSub = full
        ? fullTxt
        : roverHere
          ? "Where the rover is now"
          : "Drive a rover first";
      v.roverAddTip = roverHere
        ? "Add the rover's current position as a place to compare"
        : "Available once a rover is on the ground (Drive mode)";
      v.addRoverPlace = () => {
        const rv = this.state.rover,
          j2 = this._tj;
        if (!j2 || !rv || rv.x === undefined) return;
        const d = j2.dem,
          cl = (x) => Math.max(0, Math.min(d.N - 1, x));
        this.addDemPlace(
          cl((rv.x + d.L / 2) / d.cell),
          cl((-rv.z + d.L / 2) / d.cell),
          "Rover",
        );
      };
      // Pick on the top-down map
      const mapReady = !isRegion && !!jb && this.terrReady();
      v.mapPlacePick = !!s.mapPlacePick && mapReady && !full;
      v.mapPickDisabled = full || !mapReady;
      v.mapPickLabel = v.mapPlacePick ? "Click the map…" : "Pick on map";
      v.mapPickSub = full
        ? fullTxt
        : !mapReady
          ? isRegion
            ? "Open Terrain or Drive"
            : "Map is loading…"
          : v.mapPlacePick
            ? "Click the top-down map"
            : "Top-down map, right";
      v.mapPickTip = mapReady
        ? "Click, then click a spot on the top-down map to add it"
        : "The top-down map is shown in Terrain and Drive modes";
      v.toggleMapPlacePick = () => {
        const on = !this.state.mapPlacePick,
          // The small map is hidden on narrow screens: use the large one.
          narrow = window.matchMedia?.("(max-width: 1180px)").matches;
        this._mapPickOpenedBig = on && narrow && !this.state.bigMap;
        this.setState({
          mapPlacePick: on,
          pick: false,
          ...(this._mapPickOpenedBig ? { bigMap: true, sheet: null } : {}),
        });
      };
      v.cancelMapPlacePick = () => {
        const close = this._mapPickOpenedBig;
        this._mapPickOpenedBig = false;
        this.setState({ mapPlacePick: false, ...(close ? { bigMap: false } : {}) });
      };
      if (v.mapPlacePick) v.appCls += " map-place-pick";
      const prevMapClick = v.onMapClick;
      v.onMapClick = (e) => {
        if (!this.state.mapPlacePick || !this._tj) return prevMapClick(e);
        const rc = e.currentTarget.getBoundingClientRect(),
          N = this._tj.dem.N,
          cl = (x) => Math.max(0, Math.min(N - 1, x));
        this.addDemPlace(
          cl(((e.clientX - rc.left) / rc.width) * (N - 1)),
          cl((1 - (e.clientY - rc.top) / rc.height) * (N - 1)),
          "",
        );
      };
      // Pick on the 3D globe (Overview)
      v.pickDisabled = full;
      if (isRegion) {
        v.pickLabel = s.pick ? "Click the Moon…" : "Pick on the Moon";
        v.pickSub = full
          ? fullTxt
          : s.pick
            ? "Click a spot on the globe"
            : "Click the globe";
        v.pickTip = "Click, then click anywhere on the Moon to add a place";
        v.togglePick = () =>
          this.setState({ pick: !this.state.pick, mapPlacePick: false });
      } else {
        v.pickLabel = "Pick on the Moon";
        v.pickSub = full ? fullTxt : "Opens Overview";
        v.pickTip =
          "Switches to Overview, then click anywhere on the Moon to add a place";
        v.togglePick = () => {
          this.goView("region");
          this.setState({ pick: true, sitesOpen: true, mapPlacePick: false });
        };
      }
      // Landing-point card: same 0–100 score scale as the place list, and
      // spell out the period and how the spot compares with the pin.
      const H = v.hasTarget && this.terrReady() ? this.heat() : null,
        tv = s.target;
      if (H && tv && jb && v.tgt) {
        const d = jb.dem,
          k = tv.j * d.N + tv.i,
          c = (d.N - 1) / 2,
          ck = c * d.N + c,
          sc = H.score[k],
          sl = d.slope[k],
          days = Math.max(
            1,
            Math.round(((this.series().n - 1) * this.series().stepH) / 24),
          );
        v.tgt.score = sc < 0 ? "—" : String(Math.round(sc * 100));
        if (Number.isInteger(c) && !(sl > 15)) {
          const pin =
            "; the pin gets Sun " +
            this.pct(H.sun[ck]) +
            " · Earth " +
            this.pct(H.earth[ck]);
          const head =
            sc >= (H.best ? H.best.score * 0.9 : 1)
              ? "Excellent — about as good as the best spot nearby."
              : sc >= 0.5
                ? "Workable, but the white-ring spot gets more Sun/Earth time."
                : "Poor: terrain blocks the Sun or Earth here much of the time.";
          v.tgt.verdict =
            head +
            " Whole " +
            days +
            "-day period" +
            (Math.abs(H.sun[k] - H.sun[ck]) > 0.05 ||
            Math.abs(H.earth[k] - H.earth[ck]) > 0.05
              ? pin
              : "") +
            ".";
        }
      }
    }
  };
}
