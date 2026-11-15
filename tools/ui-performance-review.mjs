import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
const dir =
    process.env.UI_REVIEW_OUT ||
    fileURLToPath(new URL("../work/ui-pass-review/", import.meta.url)),
  report = {
    date: new Date().toISOString(),
    environment:
      "Headless Edge on this Windows host; mobile is viewport/touch emulation, not physical-device or low-end hardware validation",
    profiles: [],
    tour: [],
    errors: [],
  };
fs.mkdirSync(dir, { recursive: true });
const baseURL = process.env.BASE_URL || "http://127.0.0.1:4173/";
const b = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN }
    : process.platform === "win32"
      ? {
          executablePath:
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        }
      : {}),
  args: ["--no-proxy-server"],
});
async function sample(p, mode) {
  return p.evaluate(async (mode) => {
    const a = NASAL,
      intervals = [],
      long = [];
    let observer,
      previous,
      rangeUpdates = 0;
    try {
      observer = new PerformanceObserver((l) =>
        long.push(...l.getEntries().map((e) => e.duration)),
      );
      observer.observe({ type: "longtask", buffered: false });
    } catch {}
    a.setState({
      playing: mode === "play",
      speed: 6,
      mapReach: mode === "play",
      tripOpen: false,
      sheet: null,
    });
    if (mode === "drive") a.eng.joystick(0, -1);
    const begin = performance.now(),
      time0 = a._visualUTC ?? a.state.start + a.state.ti * 3600000,
      position0 = a.state.rover?.dist || 0;
    await new Promise((done) => {
      let last;
      const step = (t) => {
        if (last) intervals.push(t - last);
        last = t;
        if (a._rangeImage && previous !== a._rangeImage) {
          previous = a._rangeImage;
          rangeUpdates++;
        }
        if (t - begin < 10000) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    a.eng.joystick(0, 0);
    a.setState({ playing: false });
    observer?.disconnect();
    const sorted = intervals.slice().sort((a, b) => a - b),
      mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return {
      mode,
      frames: intervals.length,
      meanFPS: 1000 / mean,
      meanFrameMs: mean,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
      maxFrameMs: sorted.at(-1),
      longTasks: long,
      modelSeconds: (a._visualUTC - time0) / 1000,
      driveMetres: ((a.state.rover?.dist || 0) - position0) * 1000,
      scrollY,
      rangeUpdates,
      rangeStillVisible: !!a._rangeImage,
    };
  }, mode);
}
try {
  for (const mobile of [false, true]) {
    const c = await b.newContext(
        mobile
          ? {
              ...devices["iPhone 12"],
              viewport: { width: 390, height: 844 },
              deviceScaleFactor: 3,
            }
          : { viewport: { width: 1440, height: 1000 } },
      ),
      p = await c.newPage();
    p.on("pageerror", (e) => report.errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("NASAL render"))
        report.errors.push(m.text());
    });
    await p.addInitScript(() =>
      localStorage.setItem("lunar-navigator-tour-v1", "done"),
    );
    await p.goto(baseURL);
    await p.waitForFunction(() => window.NASALInitialReadyMs);
    await p.getByRole("button", { name: "Terrain", exact: true }).click();
    await p.waitForFunction(() => NASAL.terrReady());
    await p.waitForTimeout(2000);
    const profile = {
      mobile,
      deviceScaleFactor: mobile ? 3 : 1,
      play: await sample(p, "play"),
    };
    assert(profile.play.rangeUpdates > 1, "range must refresh during playback");
    await p.getByRole("button", { name: "Drive", exact: true }).click();
    await p.waitForTimeout(1500);
    profile.drive = await sample(p, "drive");
    await p.screenshot({
      path: `${dir}/after-drive-${mobile ? "touch" : "desktop"}-perf.png`,
    });
    await p.evaluate(() =>
      NASAL.setState({
        view: "terrain",
        playing: false,
        mapReach: true,
        routeDays: 7,
        tripOpen: false,
      }),
    );
    const t = Date.now();
    await p.waitForFunction(
      () => NASAL._routeResult?.maxHours === 168 && !NASAL._routePending,
      null,
      { timeout: 120000 },
    );
    profile.sevenDayMs = Date.now() - t;
    await p.evaluate(() => NASAL.setState({ sheet: "charts" }));
    await p.locator(".charts").waitFor();
    for (const [selector, name] of [
      [".cols", "cards"],
      [".smgrid", "graphs"],
    ]) {
      await p.locator(selector).scrollIntoViewIfNeeded();
      await p.waitForTimeout(250);
      await p.screenshot({
        path: `${dir}/after-compare-${name}-${mobile ? 390 : 1440}.png`,
      });
    }
    await c.close();
    report.profiles.push(profile);
    console.log(JSON.stringify(profile));
  }
  const c = await b.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    p = await c.newPage();
  await p.goto(baseURL);
  await p.waitForSelector(".tour-card");
  assert.equal(await p.locator(".tour-count").innerText(), "1 / 6");
  await p.keyboard.press("Enter");
  assert.equal(await p.locator(".tour-count").innerText(), "2 / 6");
  await p.keyboard.press("ArrowRight");
  assert.equal(await p.locator(".tour-count").innerText(), "3 / 6");
  await p.keyboard.press("ArrowLeft");
  assert.equal(await p.locator(".tour-count").innerText(), "2 / 6");
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${dir}/after-onboarding-mission-390.png` });
  await p.keyboard.press("Escape");
  await p.reload();
  await p.waitForFunction(() => window.NASALInitialReadyMs);
  await p.waitForTimeout(1700);
  assert.equal(await p.locator(".tour-card").count(), 0);
  await p.getByRole("button", { name: "Start quick tour" }).click();
  await p.waitForSelector(".tour-card");
  await p.getByRole("button", { name: "Skip", exact: true }).click();
  assert.equal(
    await p.evaluate(() => localStorage.getItem("lunar-navigator-tour-v1")),
    "done",
  );
  report.tour.push(
    "First visit, keyboard next/back/escape, persisted dismissal, reload and manual replay pass",
  );
  await c.close();
  fs.writeFileSync(
    `${dir}/performance-and-tour.json`,
    JSON.stringify(report, null, 2),
  );
  assert.equal(report.errors.length, 0);
} finally {
  await b.close();
}
