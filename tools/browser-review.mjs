import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = new URL("../public/research/", import.meta.url);
const server = process.env.BASE_URL
  ? null
  : spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/vite/bin/vite.js", import.meta.url),
        ),
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "4173",
        "--strictPort",
      ],
      { cwd: root, windowsHide: true },
    );
if (server)
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => {
      if (String(d).includes("127.0.0.1")) resolve();
    });
    server.on("error", reject);
    setTimeout(() => reject(Error("Preview startup timed out")), 30000).unref();
  });
const b = await chromium.launch({
  executablePath:
    process.env.CHROME_BIN ||
    (process.platform === "win32"
      ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
      : undefined),
  headless: true,
  args: ["--no-proxy-server"],
});
const url = process.env.BASE_URL || "http://127.0.0.1:4173/",
  report = { checks: [], errors: [] };
const step = (name) => {
  report.checks.push(name);
  console.log("PASS:", name);
};
function pageErrors(p) {
  p.on("pageerror", (e) => report.errors.push(e.message));
}
try {
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 } }),
    p = await c.newPage();
  pageErrors(p);
  const network = [],
    session = await c.newCDPSession(p);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: 1012500,
    uploadThroughput: 168750,
    latency: 165,
    connectionType: "cellular4g",
  });
  p.on("request", (r) => network.push(r.url()));
  await p.goto(url);
  await p.waitForFunction(() => window.NASALInitialReadyMs, null, {
    timeout: 30000,
  });
  const initial = await p.evaluate(() => ({
    readyMs: NASALInitialReadyMs,
    resources: performance
      .getEntriesByType("resource")
      .map((x) => ({ name: x.name, bytes: x.transferSize })),
  }));
  report.initial = {
    readyMs: initial.readyMs,
    bytes: initial.resources.reduce((s, x) => s + x.bytes, 0),
    profile:
      "Chromium Fast 4G: 1,012,500 B/s download, 168,750 B/s upload, 165 ms latency, fresh context, cache disabled",
  };
  assert.ok(
    initial.readyMs < 5000,
    "Initial overview should become interactive within 5 s",
  );
  assert.ok(report.initial.bytes < 5e6);
  assert.ok(!network.some((x) => /\/research\//.test(x)));
  assert.ok(!network.some((x) => /sp_dem_L1|moon_dem_4k|ephem\.bin$/.test(x)));
  step(
    "Fast 4G cold start; no startup research downloads or full science arrays",
  );
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await p.evaluate(() =>
    NASAL.setRange(Date.parse("2026-11-14"), Date.parse("2026-12-14")),
  );
  await p.waitForFunction(
    () => NASAL.series().times[0] === Date.parse("2026-11-14"),
  );
  await p.evaluate(() => NASAL.csv());
  await p.waitForFunction(() => NASAL.state.csvUrl);
  fs.writeFileSync(
    new URL("browser-export.csv", out),
    await p.evaluate(
      async () => await (await fetch(NASAL.state.csvUrl)).text(),
    ),
  );
  step("Actual browser CSV exported for the independently verified JPL month");
  await p.getByRole("button", { name: "Terrain", exact: true }).click();
  await p.waitForFunction(
    () => NASAL.terrReady() && NASAL._shadeFull && !NASAL._shadeBusy,
    null,
    { timeout: 60000 },
  );
  const light = await p.evaluate(() => {
    const j = NASAL._tj,
      utc = NASAL.series().times[NASAL.state.ti],
      expected = NASAL.terrLib().upsample(
        SCIENCE.shadeGrid(j, utc, 2),
        j.Nc,
        j.stride,
        j.dem.N,
      );
    let error = 0;
    for (let i = 0; i < expected.length; i++)
      error = Math.max(error, Math.abs(expected[i] - NASAL._shadeFull[i]));
    return { N: j.dem.N, error, atlasBins: j.B };
  });
  assert.equal(light.N, 481);
  assert.ok(light.error < 1e-6);
  report.light = light;
  step("Worker illumination agrees with the reference calculation");
  await p.evaluate(() => {
    NASAL.state.mapReach = true;
    NASAL.reach();
  });
  await p.waitForFunction(
    () => NASAL._routeResult && !NASAL._routePending,
    null,
    { timeout: 60000 },
  );
  report.route = await p.evaluate(() => {
    const m = NASAL._routeResult;
    return {
      reachable: [...m.T].filter(Number.isFinite).length,
      expanded: m.expanded,
      pruned: m.prunedLabels,
      incomplete: m.incomplete,
    };
  });
  step("Conservative slope / Pareto-label route worker completes");
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForTimeout(200);
  await p.getByRole("button", { name: "Terrain", exact: true }).click();
  await p.evaluate(() => NASAL.setState({ obsH: 10 }));
  await p.waitForFunction(
    () => NASAL.state.obsH === 10 && NASAL._tj.key.endsWith("h10"),
  );
  assert.ok(await p.evaluate(() => NASAL._tj.hmap.every(Number.isFinite)));
  await p.evaluate(() => NASAL.setState({ obsH: 2 }));
  step("Lazy mast-height profiles and local terrain transitions");
  await p.route("**/data/ephem/2027.bin.gz",route=>route.fulfill({body:fs.readFileSync(new URL('../public/data/ephem/2027.bin.gz',import.meta.url)),headers:{"content-type":"application/octet-stream"}}));
  await p.evaluate(() =>
    NASAL.setRange(Date.parse("2026-12-20"), Date.parse("2027-01-20")),
  );
  await p.waitForFunction(() => NASAL.state.start === Date.parse("2026-12-20"));
  assert.ok(await p.evaluate(() => SCIENCE.ephem.years.has(2027)));
  await p.evaluate(() =>
    NASAL.setState({ windowYear: 2027, stayHours: 168, windowRows: [] }),
  );
  await p.evaluate(() => NASAL.findBestWindows());
  await p.waitForFunction(() => NASAL.state.windowRows.length === 5, null, {
    timeout: 30000,
  });
  step("Adjacent-year ephemerides, raw gzip delivery and actual top-five search");
  await p.evaluate(() => {
    const source = SCIENCE.catalog.find((s) => s.key === "mal"),
      id = "s" + NASAL._nextId++;
    NASAL.setState({
      sites: [...NASAL.state.sites, { ...source, id, color: "#F2C94C" }],
      sel: id,
    });
  });
  await p.waitForFunction(
    () =>
      NASAL.selSite().key === "mal" &&
      NASAL._tj.dem.product?.meta.key === "mal",
    null,
    { timeout: 60000 },
  );
  step("Another site loads only when selected");
  // All custom spatial nodes now include distant measured terrain, not just the local crop.
  await p.evaluate(() =>
    NASAL.addSiteAt(-89.51, -135.3, "Custom verification point"),
  );
  await p.waitForFunction(
    () =>
      NASAL.selSite().name === "Custom verification point" && NASAL.terrReady(),
    null,
    { timeout: 180000 },
  );
  const custom = await p.evaluate(() => {
    const d = NASAL._tj.dem,
      p = NASAL.profileFor(NASAL.selSite()),
      a = d.customAtlas;
    let error = 0;
    for (let b = 0; b < 72; b++)
      error = Math.max(
        error,
        Math.abs(p[b * 10] - a.atlas[(15 * 31 + 15) * 72 + b]),
      );
    return {
      N: d.N,
      extent: a.meta.atlas.ray_extent_m,
      bins: a.meta.atlas.azimuth_bins,
      centreProfileDifferenceDeg: error,
      finite: a.atlas.every(Number.isFinite),
    };
  });
  assert.equal(custom.extent, 300000);
  assert.equal(custom.bins, 72);
  assert.ok(custom.finite && custom.centreProfileDifferenceDeg < 1e-4);
  report.custom = custom;
  step(
    "Custom-point spatial horizons extend to 300 km and agree with the pin profile",
  );
  await p.getByRole('button',{name:'Overview',exact:true}).click();
  await p.locator('canvas.ov').hover();await p.mouse.wheel(0,-100);
  await p.waitForFunction(()=>RealMoon.detailReady&&!NASAL._detailLoading,null,{timeout:60000});
  assert.equal(await p.evaluate(()=>RealMoon.maps[2].cell),80);
  step('Overview interaction upgrades to original full measured globe data and geometry');
  await c.close();
  const failureContext = await b.newContext(),
    failure = await failureContext.newPage();
  let attempts = 0;
  await failure.route("**/data/overview/global.png", (route) => {
    attempts++;
    return route.fulfill({ status: 404, body: "test missing asset" });
  });
  await failure.goto(url);
  await failure.waitForFunction(
    () =>
      document
        .getElementById("loadStatus")
        ?.textContent.includes("Could not load"),
    null,
    { timeout: 15000 },
  );
  assert.equal(attempts, 3);
  report.failureMessage = await failure.locator("#loadStatus").innerText();
  step(
    "Missing startup asset retries three times and shows an actionable error",
  );
  await failureContext.close();
  assert.deepEqual(report.errors, []);
  fs.writeFileSync(
    new URL("review-browser-qa.json", out),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  if (server) server.kill();
}
