// Isolated render-only fixture. Synthetic ridge is never used by the product or scientific exports.
import { chromium } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
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
try {
  const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
  await p.addInitScript(() =>
    localStorage.setItem("lunar-navigator-tour-v1", "done"),
  );
  await p.goto(process.env.BASE_URL || "http://127.0.0.1:4173/");
  await p.waitForFunction(() => window.NASALInitialReadyMs);
  await p.getByRole("button", { name: "Drive", exact: true }).click();
  await p.waitForFunction(() => NASAL.terrReady());
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    NASAL._alive = false;
    cancelAnimationFrame(NASAL._raf);
    NASAL._shadeWorker.terminate();
    NASAL._scienceWorker.terminate();
    NASAL._navWorker.terminate();
  });
  await p.addStyleTag({
    content:
      ".app>:not(.stage),.stage>:not(canvas),canvas.ov{visibility:hidden!important}",
  });
  async function scene(ridge, route, key) {
    await p.evaluate(
      ({ ridge, route, key }) => {
        const N = 65,
          L = 4,
          cell = L / (N - 1),
          h = new Float32Array(N * N),
          slope = new Float32Array(N * N);
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++)
            h[j * N + i] = ridge
              ? 2 * Math.exp(-Math.pow((L / 2 - j * cell) / 0.16, 2))
              : 0;
        const d = { N, L, cell, h, slope };
        NASAL.eng.setTerrain(d, key);
        NASAL.eng.set({
          view: "terrain",
          rover: null,
          drivePaused: true,
          heatOn: false,
          travelOverlay: false,
          target: null,
          best: null,
          siteName: "RENDER TEST ONLY",
          tc: { yaw: Math.PI, pitch: 0.1, dist: 3, tgt: [0, 0, 0] },
          navigation: route
            ? {
                key,
                points: [
                  { i: 16, j: 50 },
                  { i: 48, j: 50 },
                ],
              }
            : null,
        });
      },
      { ridge, route, key },
    );
    await p.waitForTimeout(200);
    const bytes = await p.screenshot({ path: `${out}/${key}.png` });
    return p.evaluate(async (base64) => {
      const im = new Image();
      im.src = "data:image/png;base64," + base64;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const g = c.getContext("2d");
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let blue = 0;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const k = (y * c.width + x) * 4;
          if (
            Math.abs(d[k] - 64) <= 2 &&
            Math.abs(d[k + 1] - 168) <= 2 &&
            d[k + 2] >= 252
          )
            blue++;
        }
      return blue;
    }, bytes.toString("base64"));
  }
  const baseline = await scene(true, false, "fixture-ridge-no-route"),
    blocked = await scene(true, true, "fixture-ridge-hidden-route"),
    visible = await scene(false, true, "fixture-flat-visible-route");
  const result = {
    fixture:
      "Synthetic test ridge; rendering verification only, not lunar data",
    baselineBluePixels: baseline,
    behindRidgeBluePixels: blocked,
    onFlatGroundBluePixels: visible,
    passed: blocked <= baseline + 5 && visible > 100,
  };
  fs.writeFileSync(
    `${out}/depth-occlusion.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert(
    result.passed,
    "The ridge must occlude the route while the same route is visible on flat terrain",
  );
} finally {
  await b.close();
}
