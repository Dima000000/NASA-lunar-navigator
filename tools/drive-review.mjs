import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const out =
  process.env.UI_REVIEW_OUT ||
  fileURLToPath(new URL("../work/drive-review/", import.meta.url));
fs.mkdirSync(out, { recursive: true });
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
const report = { errors: [], checks: [], routes: [] };
try {
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 } }),
    p = await c.newPage();
  p.on("pageerror", (e) => report.errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("NASAL render:"))
      report.errors.push(m.text());
  });
  await p.addInitScript(() =>
    localStorage.setItem("lunar-navigator-tour-v1", "done"),
  );
  await p.goto(process.env.BASE_URL || "http://127.0.0.1:4173/");
  await p.waitForFunction(() => window.NASALInitialReadyMs);
  await p.evaluate(() => {
    NASAL.setRange(
      Date.parse("2026-11-15T00:00:00Z"),
      Date.parse("2026-12-15T00:00:00Z"),
    );
    NASAL.setState({ ti: 13 });
    NASAL._tf = 13;
  });
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForFunction(() => NASAL.terrReady());
  await p.waitForTimeout(500);
  assert.equal(await p.locator(".card").count(), 0);
  assert(await p.locator(".layerbox .drive-zoom").count());
  await p
    .getByRole("button", { name: "Show place details", exact: true })
    .click();
  await p.locator(".card").waitFor();
  const sidebar = await p.evaluate(() => {
    const card = document.querySelector(".card").getBoundingClientRect();
    const close = document.querySelector(".chide").getBoundingClientRect();
    return {
      left: card.left,
      right: card.right,
      top: card.top,
      bottom: card.bottom,
      closeLeft: close.left,
      closeTop: close.top,
      closeRight: close.right,
      closeBottom: close.bottom,
    };
  });
  assert(sidebar.left >= 0 && sidebar.right <= 1440);
  assert(
    sidebar.closeLeft >= sidebar.left && sidebar.closeRight <= sidebar.right,
  );
  assert(
    sidebar.closeTop >= sidebar.top && sidebar.closeBottom <= sidebar.bottom,
  );
  await p.screenshot({ path: `${out}/sidebar-open.png` });
  await p
    .getByRole("button", { name: "Hide place details while driving" })
    .click();
  await p.locator(".card").waitFor({ state: "detached" });
  report.checks.push(
    "Clean initial Drive; zoom and find controls share the right column",
  );
  const input = p.getByRole("spinbutton", {
    name: "Drive time multiplier",
    exact: true,
  });
  await input.fill("");
  await input.pressSequentially("123.45", { delay: 120 });
  assert.equal(await input.inputValue(), "123.45");
  await input.press("Enter");
  assert.equal(await p.evaluate(() => NASAL.state.driveTimeScale), 123.45);
  await p
    .getByRole("button", { name: "Pause simulation", exact: true })
    .click();
  const t0 = await p.evaluate(() => NASAL._visualUTC);
  await p.waitForTimeout(500);
  assert.equal(await p.evaluate(() => NASAL._visualUTC), t0);
  await p.getByRole("button", { name: "Mission", exact: true }).click();
  await p
    .getByRole("spinbutton", { name: "Mission time multiplier" })
    .fill("12.5");
  await p
    .getByRole("spinbutton", { name: "Mission time multiplier" })
    .press("Enter");
  await p.waitForFunction(
    () =>
      NASAL.state.driveTimeScale === 12.5 &&
      document.querySelector('[aria-label="Drive time multiplier"]').value ===
        "12.5",
  );
  assert.equal(await input.inputValue(), "12.5");
  await p.getByRole("button", { name: "Mission", exact: true }).click();
  report.checks.push(
    "Free numeric editing survives live refresh; Enter commits, pause stops time, Mission input stays synchronised",
  );
  for (const [layer, title] of [
    ["sun", "Sunlight over the period"],
    ["earth", "Earth in view over the period"],
    ["slope", "Ground slope"],
    ["off", "Plain ground"],
  ]) {
    await p.getByTitle(title, { exact: true }).click();
    assert.equal(await p.evaluate(() => NASAL.state.layer), layer);
    await p.waitForFunction(
      (title) =>
        document
          .querySelector('.layerbox button[title="' + title + '"]')
          ?.getAttribute("aria-pressed") === "true",
      title,
    );
    assert.equal(
      await p.getByTitle(title, { exact: true }).getAttribute("aria-pressed"),
      "true",
    );
    await p.waitForTimeout(180);
    await p.screenshot({ path: `${out}/layer-${layer}.png` });
  }
  report.checks.push(
    "Every Drive analytical layer can be selected while fine texture is enabled",
  );
  // A real terrain destination near the rover, not its landing-site marker.
  await p.evaluate(() => {
    const d = NASAL._tj.dem,
      r = NASAL.eng.getDriveState(),
      i = Math.round((r.x + d.L / 2) / d.cell),
      j = Math.round((-r.z + d.L / 2) / d.cell);
    NASAL.setState({ target: { i: i + 5, j: j + 5, key: NASAL._tj.key } });
  });
  const action = p.getByRole("button", { name: "Route here ↗", exact: true });
  await action.waitFor();
  const actionBox = await action.boundingBox();
  assert(actionBox.width < 260);
  const before = await p.evaluate(() => NASAL.eng.getDriveState());
  await action.click();
  await p.waitForFunction(() => !NASAL._navBusy, null, { timeout: 90000 });
  assert(
    await p.evaluate(() => NASAL._navigation?.plan.reachable),
    await p.evaluate(() => NASAL.state.routeAlert),
  );
  await p.waitForTimeout(300);
  assert.equal(await p.locator(".drive-route-here").count(), 0);
  const plan = await p.evaluate(() => {
    const m = NASAL._navigation;
    return {
      points: m.plan.rows.length,
      hours: m.plan.hours,
      expanded: m.expanded,
      origin: m.origin,
      first: m.plan.rows[0],
      last: m.plan.rows.at(-1),
      rover: NASAL.eng.getDriveState(),
    };
  });
  assert(
    Math.abs(plan.rover.x - before.x) < 1e-10 &&
      Math.abs(plan.rover.z - before.z) < 1e-10,
  );
  assert(
    Math.hypot(
      plan.rover.routeStart.x - plan.rover.x,
      plan.rover.routeStart.z - plan.rover.z,
    ) < 1e-9,
  );
  report.routes.push(plan);
  await p.screenshot({ path: `${out}/route-ready.png` });
  await p
    .getByRole("button", { name: "Resume simulation", exact: true })
    .click();
  await p.evaluate(() => {
    NASAL.setState({ driveTimeScale: 60 });
    NASAL.eng.key("up", true);
  });
  await p.waitForTimeout(1800);
  await p.evaluate(() => NASAL.eng.key("right", true));
  await p.waitForTimeout(650);
  await p.evaluate(() => {
    NASAL.eng.key("up", false);
    NASAL.eng.key("right", false);
  });
  await p.waitForTimeout(600);
  const moved = await p.evaluate(() => NASAL.eng.getDriveState());
  assert(moved.dist > before.dist + 0.005);
  assert(moved.navigationDraws > plan.rover.navigationDraws + 10);
  assert(
    Math.hypot(moved.routeStart.x - moved.x, moved.routeStart.z - moved.z) <
      1e-9,
  );
  report.checks.push(
    "Route starts at the live rover and stays rendered during movement and steering",
  );
  report.frameTiming = await p.evaluate(
    () =>
      new Promise((resolve) => {
        const intervals = [];
        let begin = performance.now(),
          last = begin;
        function frame(now) {
          intervals.push(now - last);
          last = now;
          if (now - begin < 5000) return requestAnimationFrame(frame);
          intervals.sort((a, b) => a - b);
          resolve({
            seconds: (now - begin) / 1000,
            frames: intervals.length,
            fps: (intervals.length * 1000) / (now - begin),
            p95FrameMs: intervals[Math.floor(intervals.length * 0.95)],
            routeDraws: NASAL.eng.getDriveState().navigationDraws,
            context:
              "Headless browser on the current machine, active navigation; not a weak-laptop benchmark",
          });
        }
        requestAnimationFrame(frame);
      }),
  );
  await p.evaluate(() => NASAL.eng.setDriveZoom(3));
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}/rover-marker.png` });
  const located = await p.evaluate(() => NASAL.eng.getDriveState());
  await p.getByRole("button", { name: "Find rover", exact: true }).click();
  await p.waitForTimeout(800);
  const found = await p.evaluate(() => NASAL.eng.getDriveState());
  assert(Math.abs(found.camera.distance - 0.025) < 0.001);
  assert(Math.abs(found.camera.yaw) < 0.02);
  assert(Math.hypot(found.x - located.x, found.z - located.z) < 0.01);
  assert(Math.abs(found.camera.followHeading - found.heading) < 0.05);
  report.checks.push(
    "Find rover restores the follow camera without resetting rover position; steering centres the view",
  );
  await p
    .getByRole("button", { name: "Pause simulation", exact: true })
    .click();
  for (const [width, height] of [
    [1920, 1080],
    [1440, 1000],
    [1280, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
    [844, 390],
    [390, 844],
  ]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(450);
    const boxes = await p.evaluate(() => {
      const r = (e) => e.getBoundingClientRect().toJSON();
      return {
        hud: r(document.querySelector(".hud")),
        pill: r(document.querySelector(".dpill")),
        zoom: r(document.querySelector(".drive-zoom")),
        layer: r(document.querySelector(".layerbox")),
      };
    });
    assert(
      boxes.pill.bottom <= boxes.hud.top || boxes.pill.top >= boxes.hud.bottom,
      JSON.stringify({ width, height, boxes }),
    );
    assert(boxes.zoom.left >= boxes.layer.left - 1);
    await p.screenshot({ path: `${out}/drive-${width}x${height}.png` });
  }
  report.checks.push(
    "Portrait/landscape resizing while paused keeps HUD, site pill and right column aligned",
  );
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.evaluate(() => {
    NASAL.setState({ target: { i: 210, j: 210, key: NASAL._tj.key } });
    NASAL.routeHere();
  });
  await p.waitForFunction(() => !NASAL._navBusy, null, { timeout: 90000 });
  assert(
    await p.evaluate(() => NASAL._navigation?.plan.reachable),
    await p.evaluate(() => NASAL.state.routeAlert),
  );
  await p.waitForTimeout(200);
  const longRoute = await p.evaluate(() => {
    const n = NASAL._navigation,
      r = NASAL.eng.getDriveState();
    return {
      scenario: "Real Connecting Ridge route over 1 km",
      points: n.plan.rows.length,
      hours: n.plan.hours,
      expanded: n.expanded,
      searchScope: n.searchScope,
      origin: n.origin,
      first: n.plan.rows[0],
      last: n.plan.rows.at(-1),
      rover: r,
    };
  });
  assert(longRoute.points > 30);
  assert(
    Math.hypot(
      longRoute.rover.routeEnd.x - longRoute.rover.x,
      longRoute.rover.routeEnd.z - longRoute.rover.z,
    ) > 1,
  );
  assert(
    Math.hypot(
      longRoute.rover.routeStart.x - longRoute.rover.x,
      longRoute.rover.routeStart.z - longRoute.rover.z,
    ) < 1e-9,
  );
  report.routes.push(longRoute);
  await p.screenshot({ path: `${out}/long-route.png` });
  await p.getByRole("button", { name: "Terrain", exact: true }).click();
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForTimeout(300);
  const returned = await p.evaluate(() => NASAL.eng.getDriveState());
  assert(
    Math.hypot(returned.x - longRoute.rover.x, returned.z - longRoute.rover.z) <
      1e-9,
  );
  assert(
    returned.routeEnd &&
      returned.navigationDraws > longRoute.rover.navigationDraws,
  );
  report.checks.push(
    "A real route over 1 km starts at the fractional rover position; changing Terrain/Drive preserves rover and route",
  );
  await p.evaluate(() => {
    const d = NASAL._tj.dem,
      k = d.slope.findIndex((v) => v > 25);
    NASAL.setState({
      target: { i: k % d.N, j: Math.floor(k / d.N), key: NASAL._tj.key },
    });
    NASAL.routeHere();
  });
  await p.locator(".route-alert").waitFor({ timeout: 20000 });
  assert.match(await p.locator(".route-alert").innerText(), /20°|slope/);
  assert.equal(await p.evaluate(() => NASAL._navigation), null);
  await p.screenshot({ path: `${out}/unreachable-alert.png` });
  report.checks.push(
    "Undrivable destination raises a visible red alert and removes the obsolete route",
  );
  assert.equal(report.errors.length, 0);
  assert.equal(await p.evaluate(() => NASAL.state.glError), "");
  fs.writeFileSync(`${out}/drive-review.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await b.close();
}
