// Short how-to shown the first time someone opens Drive. Non-modal: the
// scene stays usable while it is open, and it is remembered per browser.
const KEY = "lunar-navigator-drive-help-v1";
const steps = [
  [
    ".ui-drive .pad",
    "Drive the rover",
    "Hold W A S D or the arrow keys, or use these buttons. Drag the scene to look around.",
  ],
  [
    ".ui-drive .mmc",
    "Choose where to go",
    "Click this top-down map (or distant ground) to set a destination, then press Route here. Follow the blue line: it avoids slopes the rover cannot climb.",
  ],
  [
    ".ui-drive .pad .turbo",
    "Speed up time",
    "» speeds up time: 1 s = 1 h while driving, up to 1 s = 1 day while parked. Clock and battery move together: it charges in sunlight and drains in shadow.",
  ],
];
export class DriveHelp {
  constructor(app) {
    this.app = app;
    this.index = -1;
    this.resize = () => this.position();
    this.key = (e) => {
      if (this.index >= 0 && e.key === "Escape") this.stop();
    };
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.key, true);
  }
  seen() {
    try {
      return localStorage.getItem(KEY) === "done";
    } catch {
      return false;
    }
  }
  maybeShow() {
    if (this.index < 0 && !this.seen()) this.show(0);
  }
  show(i) {
    this.index = Math.max(0, Math.min(steps.length - 1, i));
    const [, title, text] = steps[this.index];
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "drive-help";
      this.root.innerHTML =
        '<div class="drive-help-ring"></div><section class="tour-card drive-help-card mat" role="dialog" aria-label="How to drive"><small class="tour-count"></small><h2></h2><p></p><div class="tour-actions"><button class="btn sm dh-skip">Got it</button><button class="btn sm pri dh-next">Next</button></div></section>';
      document.body.append(this.root);
      this.card = this.root.querySelector(".drive-help-card");
      this.root.querySelector(".dh-skip").onclick = () => this.stop();
      this.root.querySelector(".dh-next").onclick = () =>
        this.index === steps.length - 1 ? this.stop() : this.show(this.index + 1);
    }
    this.card.querySelector("h2").textContent = title;
    this.card.querySelector("p").textContent = text;
    this.card.querySelector(".tour-count").textContent =
      "Drive · " + (this.index + 1) + " / " + steps.length;
    const last = this.index === steps.length - 1;
    this.card.querySelector(".dh-next").textContent = last ? "Start driving" : "Next";
    this.card.querySelector(".dh-skip").hidden = last;
    cancelAnimationFrame(this.frame);
    const track = () => {
      this.position();
      this.frame = requestAnimationFrame(track);
    };
    this.frame = requestAnimationFrame(track);
    this.card.querySelector(".dh-next").focus({ preventScroll: true });
  }
  position() {
    if (this.index < 0 || !this.root) return;
    if (this.app.state.view !== "drive") return this.stop(false);
    const el = document.querySelector(steps[this.index][0]),
      b = el?.getBoundingClientRect(),
      ring = this.root.querySelector(".drive-help-ring"),
      w = innerWidth,
      h = innerHeight,
      cw = this.card.offsetWidth,
      ch = this.card.offsetHeight,
      clampX = (x) => Math.max(12, Math.min(w - cw - 12, x)),
      clampY = (y) => Math.max(12, Math.min(h - ch - 12, y));
    const key = b ? [b.left, b.top, b.width, b.height, w, h].map(Math.round).join() : "none";
    if (key === this.last) return;
    this.last = key;
    if (!b || !b.width) {
      ring.style.display = "none";
      Object.assign(this.card.style, { left: clampX((w - cw) / 2) + "px", top: clampY(h - ch - 140) + "px" });
      return;
    }
    ring.style.display = "";
    Object.assign(ring.style, {
      left: b.left - 6 + "px",
      top: b.top - 6 + "px",
      width: b.width + 12 + "px",
      height: b.height + 12 + "px",
    });
    // Prefer the left of the target (pad and map sit on the right), then above, then below.
    const options = [
      [b.left - 16 - cw, clampY(b.top + b.height / 2 - ch / 2)],
      [clampX(b.right - cw), b.top - 16 - ch],
      [clampX(b.right - cw), b.bottom + 16],
    ];
    const fits = ([x, y]) => x >= 12 && y >= 12 && x + cw <= w - 12 && y + ch <= h - 12;
    const pos = options.find(fits) || [clampX(b.left - cw), clampY(b.top - ch)];
    Object.assign(this.card.style, { left: pos[0] + "px", top: pos[1] + "px" });
  }
  stop(remember = true) {
    if (remember)
      try {
        localStorage.setItem(KEY, "done");
      } catch {}
    this.index = -1;
    this.last = null;
    cancelAnimationFrame(this.frame);
    this.root?.remove();
    this.root = null;
  }
  destroy() {
    this.stop(false);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.key, true);
  }
}
