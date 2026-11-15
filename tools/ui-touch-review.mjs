import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
const dir =
  process.env.UI_REVIEW_OUT ||
  fileURLToPath(new URL("../work/ui-pass-review/", import.meta.url));
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
const report = { errors: [] };
try {
  const c = await b.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    }),
    p = await c.newPage();
  await p.addInitScript(() =>
    (localStorage.setItem("lunar-navigator-tour-v1", "done"),
    localStorage.setItem("lunar-navigator-drive-help-v1", "done")),
  );
  p.on("pageerror", (e) => report.errors.push(e.message));
  await p.goto(baseURL);
  await p.waitForFunction(() => window.NASALInitialReadyMs);
  await p.evaluate(() => {
    NASAL.setRange(
      Date.parse("2026-11-15T00:00:00Z"),
      Date.parse("2026-12-15T00:00:00Z"),
    );
    NASAL.setState({ ti: 13 });
    NASAL._tf = 13;
    NASAL.setState({ driveTimeScale: 300 });
  });
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForFunction(() => NASAL.terrReady());
  await p.waitForTimeout(1500);
  const s = await c.newCDPSession(p),
    joy = await p.locator(".joystick").boundingBox(),
    x = joy.x + joy.width / 2,
    y = joy.y + joy.height / 2;
  await s.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await s.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: y - 42, id: 1 }],
  });
  const start = await p.evaluate(() => ({
    distance: NASAL.state.rover.dist,
    time: NASAL._visualUTC,
  }));
  await p.waitForFunction(
    (distance) => NASAL.state.rover.dist - distance >= 0.205,
    start.distance,
    { timeout: 120000 },
  );
  await s.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x + 32, y: y - 32, id: 1 }],
  });
  const heading = await p.evaluate(() => NASAL.state.rover.heading);
  await p.waitForFunction(
    (heading) => Math.abs(NASAL.state.rover.heading - heading) > 0.3,
    heading,
    { timeout: 30000 },
  );
  await s.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await p.waitForTimeout(600);
  report.drive = await p.evaluate(
    ({ start, heading }) => ({
      metres: (NASAL.state.rover.dist - start.distance) * 1000,
      modelSeconds: (NASAL._visualUTC - start.time) / 1000,
      selectedTimeMultiplier: NASAL.state.driveTimeScale,
      headingChange: NASAL.state.rover.heading - heading,
      scrollY,
      joystick: document.querySelector(".joystick").style.cssText,
    }),
    { start, heading },
  );
  assert(report.drive.metres >= 200);
  assert(Math.abs(report.drive.headingChange) > 0.1);
  assert.equal(report.drive.scrollY, 0);
  const zoom = await p.evaluate(() => NASAL.eng.getDriveZoom());
  await s.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 120, y: 380, id: 1 },
      { x: 200, y: 380, id: 2 },
    ],
  });
  await s.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 100, y: 380, id: 1 },
      { x: 230, y: 380, id: 2 },
    ],
  });
  await s.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await p.waitForFunction(() => NASAL.eng.getDriveZoom() < 0.025, null, {
    timeout: 30000,
  });
  const nextZoom = await p.evaluate(() => NASAL.eng.getDriveZoom());
  assert(nextZoom < zoom);
  await p.getByRole("button", { name: "Reset rover camera distance" }).click();
  await p.waitForTimeout(500);
  assert(
    Math.abs((await p.evaluate(() => NASAL.eng.getDriveZoom())) - 0.025) < 1e-6,
  );
  report.pinch = { before: zoom, after: nextZoom, reset: 0.025 };
  await p.getByRole("button", { name: "Map layers", exact: true }).click();
  await p.getByTitle("Sunlight over the period", { exact: true }).click();
  await p.waitForFunction(() => NASAL.state.layer === "sun");
  await p.getByRole("button", { name: "Map layers", exact: true }).click();
  await p.setViewportSize({ width: 844, height: 390 });
  await p.waitForTimeout(500);
  report.landscape = await p.evaluate(() => {
    const j = document.querySelector(".joystick").getBoundingClientRect();
    const t = document.querySelector(".time").getBoundingClientRect();
    return { joystick: j.toJSON(), timeline: t.toJSON(), scrollY };
  });
  assert(report.landscape.joystick.top >= 0);
  assert(report.landscape.joystick.bottom <= report.landscape.timeline.top);
  assert.equal(report.landscape.scrollY, 0);
  await p.screenshot({ path: dir + "/after-touch-landscape.png" });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: dir + "/after-touch-200m.png" });
  fs.writeFileSync(
    dir + "/touch-controls.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.equal(report.errors.length, 0);
} finally {
  await b.close();
}
