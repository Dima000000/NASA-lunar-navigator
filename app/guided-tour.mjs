const KEY = "lunar-navigator-tour-v1";
const steps = [
  [
    null,
    "Explore the real Moon",
    "This is the real Moon, built from NASA LOLA terrain. Drag to look around and scroll to zoom; click a place pin to fly down to its terrain.",
  ],
  [
    ".card:has(.plist)",
    "Pick a landing site",
    "Choose a named place here, or use + Add place to drop your own point on the Moon.",
  ],
  [
    ".mission-selector",
    "Set landing and liftoff",
    "Drag the two mission handles, or open Mission dates to enter UTC times. Statistics and comparisons use this interval.",
  ],
  [
    ".playb",
    "Watch the changing light",
    "Press play to watch the Sun, Earth and shadows move. Playback speed is in Options.",
  ],
  [
    ".sheet .sect:has(.planning-actions)",
    "Find a useful opportunity",
    "Find top 5 windows ranks the best landing dates for the selected place. Best spots for these dates ranks nearby positions for your mission dates.",
  ],
  [
    ".topr .seg",
    "Drive the rover",
    "Select Drive to explore at rover scale. Use the arrow controls or the touch joystick; time and battery advance together.",
  ],
];
export class GuidedTour {
  constructor(app) {
    this.app = app;
    this.index = -1;
    this.key = (e) => {
      if (this.index < 0 || e.target.matches("input,select,textarea")) return;
      // Keys on app controls (e.g. the mission handles) belong to those controls.
      if (
        e.key !== "Escape" &&
        e.target !== document.body &&
        !this.card?.contains(e.target)
      )
        return;
      if (
        ["Enter", "ArrowRight", "ArrowLeft", "Escape", "Tab"].includes(e.key)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") this.stop();
        else if (e.key === "ArrowLeft") this.show(this.index - 1);
        else if (e.key === "Tab") {
          const bs = [...this.card.querySelectorAll("button")].filter(
              (b) => !b.disabled,
            ),
            i = bs.indexOf(document.activeElement);
          bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length]?.focus();
        } else this.next();
      }
    };
    this.resize = () => this.position();
    // Targets move when panels open or reflow; keep the outline glued to them.
    this.track = () => {
      if (this.index < 0) return;
      const r = this.selector
        ? document.querySelector(this.selector)?.getBoundingClientRect()
        : null;
      const key = r
        ? [r.left, r.top, r.width, r.height].map(Math.round).join()
        : "";
      if (key !== this.lastRect) this.position();
      this.trackFrame = requestAnimationFrame(this.track);
    };
    window.addEventListener("keydown", this.key, true);
    window.addEventListener("resize", this.resize);
    window.addEventListener("scroll", this.resize, true);
  }
  first() {
    let seen = false;
    try {
      seen = localStorage.getItem(KEY) === "done";
    } catch {}
    if (!seen) this.start();
  }
  start() {
    this.previousFocus = document.activeElement;
    this.previousSheet = this.app.state.sheet;
    this.previousDriveCard = this.app.state.driveCard;
    this.app.setState({ sheet: null, playing: false, driveCard: true });
    this.show(0);
  }
  next() {
    if (this.index === steps.length - 1) this.stop();
    else this.show(this.index + 1);
  }
  show(i) {
    this.index = Math.max(0, i);
    const [selector, title, text] = steps[this.index];
    this.app.setState({
      sheet: this.index === 4 ? "expert" : null,
      driveCard: true,
    });
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "guided-tour";
      this.root.innerHTML =
        '<div class="tour-focus"></div><section class="tour-card mat" role="dialog" aria-modal="true" aria-label="Quick tour"><small class="tour-count"></small><h2></h2><p></p><div class="tour-actions"><button class="btn sm tour-skip">Skip</button><button class="btn sm tour-back">Back</button><button class="btn sm pri tour-next">Next</button></div></section>';
      document.body.append(this.root);
      this.card = this.root.querySelector(".tour-card");
      this.root.querySelector(".tour-skip").onclick = () => this.stop();
      this.root.querySelector(".tour-back").onclick = () =>
        this.show(this.index - 1);
      this.root.querySelector(".tour-next").onclick = () => this.next();
    }
    this.card.querySelector("h2").textContent = title;
    this.card.querySelector("p").textContent = text;
    this.card.querySelector(".tour-count").textContent =
      this.index + 1 + " / " + steps.length;
    this.card.querySelector(".tour-back").disabled = this.index === 0;
    this.card.querySelector(".tour-next").textContent =
      this.index === steps.length - 1 ? "Start exploring" : "Next";
    this.selector = selector;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (selector)
        document.querySelector(selector)?.scrollIntoView({ block: "nearest" });
      this.position();
      this.card.querySelector(".tour-next").focus({ preventScroll: true });
      cancelAnimationFrame(this.trackFrame);
      this.trackFrame = requestAnimationFrame(this.track);
    });
  }
  position() {
    if (this.index < 0 || !this.root) return;
    const el = this.selector ? document.querySelector(this.selector) : null,
      w = innerWidth,
      h = innerHeight,
      focus = this.root.querySelector(".tour-focus"),
      ch = this.card.offsetHeight,
      cw = this.card.offsetWidth,
      gap = 16,
      clampX = (x) => Math.max(12, Math.min(w - cw - 12, x)),
      clampY = (y) => Math.max(12, Math.min(h - ch - 12, y));
    const b = el?.getBoundingClientRect();
    this.lastRect = b
      ? [b.left, b.top, b.width, b.height].map(Math.round).join()
      : "";
    // Steps about the whole scene have no target: no outline, no dimming.
    if (!b || !b.width || !b.height) {
      focus.style.display = "none";
      this.root.classList.add("tour-free");
      const top = w < 600 ? h - ch - 12 : 88;
      Object.assign(this.card.style, {
        top: clampY(top) + "px",
        left: clampX((w - cw) / 2) + "px",
      });
      return;
    }
    this.root.classList.remove("tour-free");
    focus.style.display = "";
    // Sections without their own padding get a bit more room inside the outline.
    const pad = el.matches(".sect") ? 10 : 5,
      left = Math.max(4, b.left - pad),
      top = Math.max(4, b.top - pad),
      right = Math.min(w - 4, b.right + pad),
      bottom = Math.min(h - 4, b.bottom + pad),
      r = { left, top, right, bottom };
    Object.assign(focus.style, {
      left: left + "px",
      top: top + "px",
      width: right - left + "px",
      height: bottom - top + "px",
    });
    // Place the card next to the target without covering it: below, above,
    // left, right; otherwise the corner that overlaps it least.
    const fits = (x, y) => x >= 12 && y >= 12 && x + cw <= w - 12 && y + ch <= h - 12;
    const options = [
      [clampX(r.left), r.bottom + gap],
      [clampX(r.left), r.top - gap - ch],
      [r.left - gap - cw, clampY(r.top)],
      [r.right + gap, clampY(r.top)],
    ];
    let pos = options.find(([x, y]) => fits(x, y));
    if (!pos) {
      const overlap = ([x, y]) =>
        Math.max(0, Math.min(x + cw, r.right) - Math.max(x, r.left)) *
        Math.max(0, Math.min(y + ch, r.bottom) - Math.max(y, r.top));
      pos = [
        [12, 12],
        [w - cw - 12, 12],
        [12, h - ch - 12],
        [w - cw - 12, h - ch - 12],
      ].sort((p, q) => overlap(p) - overlap(q))[0];
    }
    Object.assign(this.card.style, { left: pos[0] + "px", top: pos[1] + "px" });
  }
  stop() {
    try {
      localStorage.setItem(KEY, "done");
    } catch {}
    this.index = -1;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.trackFrame);
    this.root?.remove();
    this.root = null;
    this.app.setState({
      sheet: this.previousSheet || null,
      driveCard: this.previousDriveCard ?? false,
    });
    this.previousFocus?.focus?.({ preventScroll: true });
  }
  destroy() {
    this.index = -1;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.trackFrame);
    this.root?.remove();
    window.removeEventListener("keydown", this.key, true);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("scroll", this.resize, true);
  }
}
