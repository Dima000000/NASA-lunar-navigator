import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
const dir =
    process.env.UI_REVIEW_OUT ||
    fileURLToPath(new URL("../work/ui-pass-review/", import.meta.url)),
  report = { errors: [], screens: [], checks: [] };
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
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  p.on("pageerror", (e) => report.errors.push(e.stack));
  p.on("console", (m) => {
    if (m.type() === "error") report.errors.push(m.text());
  });
  await p.addInitScript(() =>
    (localStorage.setItem("lunar-navigator-tour-v1", "done"),
    localStorage.setItem("lunar-navigator-drive-help-v1", "done")),
  );
  await p.goto(baseURL);
  await p.waitForFunction(() => window.NASALInitialReadyMs);
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForFunction(() => NASAL.terrReady());
  await p.waitForTimeout(1400);
  for (const w of [1920, 1440, 1280, 1024, 768, 390]) {
    await p.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    await p.waitForTimeout(500);
    const file = `after-drive-${w}.png`;
    await p.screenshot({ path: `${dir}/${file}` });
    report.screens.push(file);
  }
  for (const w of [1440, 390]) {
    await p.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    await p.evaluate(() => NASAL.setState({ sheet: "charts" }));
    await p.locator(".charts").waitFor();
    await p.waitForTimeout(500);
    assert.equal(await p.locator(".chart-site-legend").count(), 1);
    assert(
      await p
        .locator(".panels svg")
        .evaluateAll((s) => s.every((e) => e.viewBox.baseVal.width === 400)),
    );
    const file = `after-compare-${w}.png`;
    await p.screenshot({ path: `${dir}/${file}`, fullPage: true });
    report.screens.push(file);
    for (const [selector, name] of [
      [".cols", "cards"],
      [".smgrid", "graphs"],
    ]) {
      await p.locator(selector).scrollIntoViewIfNeeded();
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${dir}/after-compare-${name}-${w}.png` });
    }
    await p.evaluate(() => NASAL.setState({ sheet: null, driveCard: true }));
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${dir}/after-card-${w}.png` });
  }
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.evaluate(() => {
    NASAL.setState({
      view: "terrain",
      driveCard: false,
      mapReach: true,
      routeDays: 7,
      target: { i: 240, j: 240, key: NASAL._tj.key },
    });
    NASAL.routeHere();
  });
  await p.waitForFunction(
    () => NASAL._routeResult && NASAL._routeResult.maxHours === 168,
    null,
    { timeout: 90000 },
  );
  await p.evaluate(() => {
    const d = NASAL._tj.dem,
      r = NASAL.eng.getDriveState(),
      i = Math.round((r.x + d.L / 2) / d.cell),
      j = Math.round((-r.z + d.L / 2) / d.cell);
    NASAL.setState({
      target: { i: i + 5, j: j + 5, key: NASAL._tj.key },
      travelOverlay: true,
    });
    NASAL.routeHere();
  });
  await p.waitForFunction(
    () => NASAL._navigation?.plan?.hours > 0 && !NASAL._navBusy,
    null,
    { timeout: 60000 },
  );
  assert(
    await p.evaluate(() =>
      NASAL._navigation.plan.steps.some((s) => s.kind === "drive"),
    ),
  );
  report.route = await p.evaluate(() => ({
    status: NASAL.state.routeStatus,
    expanded: NASAL._routeResult.expanded,
    finite: [...NASAL._routeResult.T].filter(Number.isFinite).length,
    trip: NASAL._navigation.plan.reachable,
    tripHours: NASAL._navigation.plan.hours,
    navigationExpanded: NASAL._navigation.expanded,
  }));
  await p.screenshot({ path: `${dir}/after-trip-1440.png` });
  await p.evaluate(() => {
    NASAL.setState({ tripOpen: false, sheet: "expert" });
    NASAL.findBestSpots();
  });
  await p.waitForFunction(() => NASAL.state.bestSpots?.length === 5, null, {
    timeout: 120000,
  });
  report.best = await p.evaluate(() =>
    NASAL.state.bestSpots.map((p) => ({
      score: p.score,
      slope: p.slope,
      lat: p.lat,
      lon: p.lon,
    })),
  );
  assert(report.best.every((p) => p.slope <= 15));
  report.checks.push(
    "Seven-day route worker and best-five spot worker complete",
  );
  await p.screenshot({ path: `${dir}/after-best-spots.png` });
  const oldStart = await p.evaluate(() => NASAL.state.start);
  await p.evaluate(() =>
    NASAL.setMission(NASAL.state.start + 3600000, NASAL.state.end),
  );
  await p.waitForFunction(
    (start) => NASAL.state.start === start + 3600000,
    oldStart,
  );
  await p.waitForFunction(() => NASAL.state.bestSpots.length === 0);
  assert.equal(await p.evaluate(() => NASAL.state.bestSpots.length), 0);
  assert.equal(
    await p.evaluate(() => NASAL.series().times[0]),
    oldStart + 3600000,
  );
  report.checks.push(
    "Mission dates feed analysis and invalidate previous spot rankings",
  );
  report.runtime = await p.evaluate(() => ({
    renderError: window.NASALRuntimeError,
    glError: NASAL.state.glError,
  }));
  fs.writeFileSync(
    `${dir}/ui-functional.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.errors.length, 0);
  assert(!report.runtime.renderError);
  assert(!report.runtime.glError);
} finally {
  await b.close();
}
