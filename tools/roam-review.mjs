// Drive roaming review: the rover leaves the 16 km square around the place and the world follows it.
// Checks that the terrain window re-centres without moving the rover on the Moon, without a reset, and that
// sunlight / Earth visibility at the rover are unchanged by the swap; then that "return" restores the place's square.
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
  args: [
    "--no-proxy-server",
    ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(" ") : []),
  ],
});
const report = { errors: [], checks: [], windows: [] };
try {
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 } }),
    p = await c.newPage();
  p.on("pageerror", (e) => report.errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("NASAL render:"))
      report.errors.push(m.text());
  });
  await p.addInitScript(() =>
    (localStorage.setItem("lunar-navigator-tour-v1", "done"),
    localStorage.setItem("lunar-navigator-drive-help-v1", "done")),
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
  await p.waitForFunction(
    () => NASAL.terrReady() && NASAL.eng?.getDriveState(),
    null,
    { timeout: 60000 },
  );
  await p.waitForTimeout(500);
  // Where the rover stands, independent of the loaded window: km east / north of the place pin, plus its light.
  const where = () =>
    p.evaluate(() => {
      const d = NASAL._tj.dem,
        r = NASAL.eng.getDriveState(),
        sky = SCIENCE.skyAt(
          d,
          (r.x + d.L / 2) / d.cell,
          (-r.z + d.L / 2) / d.cell,
          NASAL._visualUTC,
          NASAL.state.obsH || 2,
        );
      return {
        key: NASAL._tj.key,
        engineKey: NASAL.eng.terrainKey(),
        roverKey: r.terrainKey,
        east: (d.ox || 0) + r.x,
        north: (d.oy || 0) - r.z,
        x: r.x,
        z: r.z,
        height:
          d.h[
            Math.round((-r.z + d.L / 2) / d.cell) * d.N +
              Math.round((r.x + d.L / 2) / d.cell)
          ],
        heading: r.heading,
        battery: r.batt,
        driven: r.dist,
        sun: sky.sun,
        earth: sky.earth,
        // Sun / Earth disc fractions over the month on a 5 x 5 set of fixed lunar spots that every window of this
        // review contains.
        light: [0, 5, 10, 15, 20, 25].flatMap((day) =>
          [0.51, 2.03, 3.9, 5.52, 7.01].flatMap((east) =>
            [-6.02, -3.01, -0.7, 2.03, 5.01].map((north) => {
              const q = SCIENCE.skyAt(
                d,
                (east - (d.ox || 0) + d.L / 2) / d.cell,
                (north - (d.oy || 0) + d.L / 2) / d.cell,
                NASAL.state.start + day * 86400000,
                NASAL.state.obsH || 2,
              );
              return [q.sun, q.earth];
            }),
          ),
        ),
        roam: NASAL.roamStatus(),
        stateRover: NASAL.state.rover && [NASAL.state.rover.x, NASAL.state.rover.z],
      };
    });
  // Put the rover 3.9 km east of the pin (inside the square, close enough to its border to need the next window).
  await p.evaluate(() => {
    NASAL.setState({ drivePaused: true });
    // (roamReset is the engine's own "respawn at home", without the return-to-place step)
    NASAL.eng.set({ home: [3.9, 0, 0.7] });
    NASAL.eng.roamReset();
  });
  await p.waitForFunction(
    () => Math.abs(NASAL.eng.getDriveState().x - 3.9) < 1e-6,
  );
  await p.waitForTimeout(400);
  const before = await where();
  assert.equal(before.roam, null);
  await p.screenshot({ path: `${out}/roam-before.png` });
  await p.waitForFunction(() => NASAL.roamStatus(), null, { timeout: 90000 });
  const after = await where();
  await p.screenshot({ path: `${out}/roam-after.png` });
  report.windows.push({ before, after });
  assert.notEqual(after.key, before.key);
  assert.equal(after.engineKey, after.key);
  assert.equal(after.roverKey, after.key);
  // Same spot on the Moon (the window moved by whole grid nodes; float32 world coordinates agree to millimetres)…
  assert(Math.abs(after.east - before.east) < 1e-5);
  assert(Math.abs(after.north - before.north) < 1e-5);
  assert.equal(after.height, before.height);
  // …now well inside the new window, with nothing reset.
  assert(Math.max(Math.abs(after.x), Math.abs(after.z)) < 1);
  assert.equal(after.heading, before.heading);
  assert.equal(after.driven, before.driven);
  assert(Math.abs(after.battery - before.battery) < 0.5);
  assert(Math.abs(after.stateRover[0] - after.x) < 1e-6);
  // Lighting and Earth visibility at the rover come from the same measured horizons.
  assert.equal(after.sun, before.sun);
  assert.equal(after.earth, before.earth);
  const lightStep = Math.max(
    ...after.light.flatMap((q, k) => [
      Math.abs(q[0] - before.light[k][0]),
      Math.abs(q[1] - before.light[k][1]),
    ]),
  );
  report.windows.at(-1).largestLightDifference = lightStep;
  assert(lightStep < 1e-6, "light changed across the window swap: " + lightStep);
  for (const k of [0, 1])
    assert(
      before.light.some((q) => q[k] > 0.5) && before.light.some((q) => q[k] === 0),
    );
  assert(after.roam.sourceResolutionM >= 20);
  report.checks.push(
    "Leaving the 16 km square loads the next terrain window around the rover: same lunar position, heading, battery, light",
  );
  // The top-down map, Terrain view and a second crossing keep working on the new window.
  await p.evaluate(() => {
    NASAL.eng.set({ home: [-3.8, 0, -3.8] });
    NASAL.eng.roamReset();
  });
  const second = await where();
  await p.waitForFunction(
    (key) => NASAL._tj.key !== key && !NASAL._roamJob,
    second.key,
    { timeout: 90000 },
  );
  const third = await where();
  assert(Math.abs(third.east - second.east) < 1e-5);
  assert(Math.abs(third.north - second.north) < 1e-5);
  assert.equal(third.sun, second.sun);
  await p.getByRole("button", { name: "Terrain", exact: true }).click();
  await p.waitForFunction(() => NASAL.state.view === "terrain");
  await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => NASAL._tj.key), third.key);
  await p.screenshot({ path: `${out}/roam-terrain.png` });
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForFunction(() => NASAL.state.view === "drive");
  await p.waitForTimeout(600);
  const back = await where();
  assert.equal(back.key, third.key);
  assert(Math.abs(back.east - third.east) < 1e-5);
  report.checks.push(
    "A second crossing and a Terrain/Drive round trip keep the rover and the roaming window",
  );
  // Returning the rover brings back the place's own square.
  await p.evaluate(() => {
    NASAL.eng.set({ home: null });
    NASAL.eng.resetRover();
  });
  await p.waitForFunction(
    (key) => !NASAL.roamStatus() && NASAL._tj.key === key,
    before.key,
    { timeout: 30000 },
  );
  const home = await where();
  assert.equal(home.engineKey, before.key);
  assert(Math.max(Math.abs(home.x), Math.abs(home.z)) < 7.6);
  report.checks.push("Returning the rover restores the place's own terrain square");
  assert.equal(report.errors.length, 0);
  assert.equal(await p.evaluate(() => NASAL.state.glError), "");
  fs.writeFileSync(`${out}/roam-review.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await b.close();
}
