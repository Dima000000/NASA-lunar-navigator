import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
const out =
  process.env.UI_REVIEW_OUT ||
  fileURLToPath(new URL("../work/ui-pass-review/", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
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
const report = { errors: [], screens: [], buttonCollisions: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript(() =>
    localStorage.setItem("lunar-navigator-tour-v1", "done"),
  );
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("NASAL render:"))
      report.errors.push(m.text());
  });
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:4173/");
  await page.waitForFunction(() => window.NASALInitialReadyMs);
  const widths = [1920, 1440, 1280, 1024, 768, 390];
  async function shot(name, w) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    await page.waitForTimeout(350);
    const file = `after-${name}-${w}.png`;
    await page.screenshot({
      path: `${out}/${file}`,
      fullPage: name === "overview",
    });
    report.screens.push(file);
    const collisions = await page.evaluate(() => {
      const controls = [
        ...document.querySelectorAll("button,input,select"),
      ].filter((e) => {
        const s = getComputedStyle(e),
          r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return (
          (!document.querySelector(".charts,.sheet,.bigmap") ||
            document.querySelector(".charts,.sheet,.bigmap").contains(e)) &&
          e.checkVisibility() &&
          hit &&
          (hit === e || e.contains(hit)) &&
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          r.width > 0 &&
          r.height > 0 &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          r.left >= 0 &&
          r.right <= innerWidth &&
          e.getClientRects().length
        );
      });
      const pairs = [];
      for (let i = 0; i < controls.length; i++)
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i],
            b = controls[j];
          if (a.contains(b) || b.contains(a)) continue;
          const x = a.getBoundingClientRect(),
            y = b.getBoundingClientRect(),
            area =
              Math.max(
                0,
                Math.min(x.right, y.right) - Math.max(x.left, y.left),
              ) *
              Math.max(
                0,
                Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top),
              );
          if (area > 80) {
            const px =
                (Math.max(x.left, y.left) + Math.min(x.right, y.right)) / 2,
              py = (Math.max(x.top, y.top) + Math.min(x.bottom, y.bottom)) / 2,
              top = document.elementFromPoint(px, py);
            if (
              top &&
              (a === top || a.contains(top) || b === top || b.contains(top))
            )
              pairs.push([
                (a.getAttribute("aria-label") || a.textContent)
                  .trim()
                  .slice(0, 65),
                (b.getAttribute("aria-label") || b.textContent)
                  .trim()
                  .slice(0, 65),
                Math.round(area),
              ]);
          }
        }
      return pairs;
    });
    if (collisions.length)
      report.buttonCollisions.push({ name, width: w, collisions });
  }
  for (const mode of ["Overview", "Terrain", "Land", "Drive"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    if (mode !== "Overview")
      await page.waitForFunction(() => NASAL.terrReady());
    await page.waitForTimeout(mode === "Land" ? 1300 : 400);
    if (mode === "Overview")
      await page.evaluate(() =>
        NASAL.setState({ open: { [NASAL.state.sel]: true } }),
      );
    for (const w of widths) await shot(mode.toLowerCase(), w);
  }
  await page.evaluate(() =>
    NASAL.setState({ sheet: "charts", driveCard: false }),
  );
  for (const w of widths) await shot("compare", w);
  await page.evaluate(() => NASAL.setState({ sheet: "expert" }));
  for (const w of widths) await shot("science", w);
  await page.evaluate(() => NASAL.findBestWindows());
  await page.waitForFunction(() => NASAL.state.windowRows.length === 5, null, {
    timeout: 60000,
  });
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    await page.getByRole("button", { name: /#1 ·/ }).scrollIntoViewIfNeeded();
    await shot("windows", w);
  }
  assert(
    await page.evaluate(() =>
      NASAL.renderVals().places.every((p) => p.rows.length === 4),
    ),
  );
  await page.evaluate(() =>
    NASAL.setState({
      sheet: null,
      driveCard: true,
      open: { [NASAL.state.sel]: true },
    }),
  );
  for (const w of [1440, 390]) await shot("place-stats", w);
  fs.writeFileSync(
    `${out}/layout-review.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.equal(report.errors.length, 0);
} finally {
  await browser.close();
}
