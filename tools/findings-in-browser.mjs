import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const b = await chromium.launch({
    executablePath:
      process.env.CHROME_BIN ||
      (process.platform === "win32"
        ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
        : undefined),
    headless: true,
    args: ["--no-proxy-server"],
  }),
  p = await b.newPage(),
  errors = [];
p.on("pageerror", (e) => errors.push(e.message));
try {
  await p.goto(process.env.BASE_URL || "http://127.0.0.1:4173/");
  await p.waitForFunction(() => window.NASAL?.eng, null, { timeout: 60000 });
  const rows = [],
    exports = [];
  for (const id of ["s1", "s3"]) {
    await p.evaluate((id) => {
      NASAL.selectSite(id);
      NASAL.setState({ windowRows: [], windowYear: 2027, stayHours: 168 });
    }, id);
    await p.evaluate(() => NASAL.findBestWindows());
    await p.waitForFunction(() => NASAL.state.windowRows.length === 5, null, {
      timeout: 30000,
    });
    const result = await p.evaluate(() => ({
      site: NASAL.selSite(),
      top: NASAL.state.windowRows[0],
    }));
    rows.push({
      kind: "best_window",
      key: result.site.key,
      name: result.site.name,
      height_m: 2,
      ...result.top,
    });
    await p.evaluate((w) => NASAL.setRange(w.start, w.end), result.top);
    await p.waitForFunction(
      (start) => NASAL.series().times[0] === start,
      result.top.start,
    );
    await p.evaluate(() => NASAL.csv());
    await p.waitForTimeout(100);
    exports.push(
      await p.evaluate(
        async () => await (await fetch(NASAL.state.csvUrl)).text(),
      ),
    );
    if (id === "s1") {
      rows.push(
        await p.evaluate(() => {
          const ser = NASAL.series(),
            o = ser.sites.s3,
            site = NASAL.state.sites.find((s) => s.id === "s3");
          let sun = 0,
            earth = 0,
            run = 0,
            dark = 0;
          for (let i = 0; i < 168; i++) {
            if (o.sF[i] > 0.0005) {
              sun++;
              run = 0;
            } else dark = Math.max(dark, ++run);
            earth += o.eF[i] > 0.0005;
          }
          return {
            kind: "same_week_comparison",
            key: site.key,
            name: site.name,
            height_m: 2,
            start: ser.times[0],
            end: ser.times[168],
            sun: sun / 168,
            earth: earth / 168,
            darkHours: dark,
          };
        }),
      );
    }
  }
  const header = [
    "kind",
    "key",
    "name",
    "height_m",
    "start_utc",
    "end_utc",
    "sun_any_fraction",
    "earth_any_fraction",
    "longest_dark_h",
    "score",
  ];
  const csv = [
    header.join(","),
    ...rows.map((r) =>
      [
        r.kind,
        r.key,
        JSON.stringify(r.name),
        r.height_m,
        new Date(r.start).toISOString(),
        new Date(r.end).toISOString(),
        r.sun,
        r.earth,
        r.darkHours,
        r.score ?? "",
      ].join(","),
    ),
  ].join("\n");
  const root = fileURLToPath(new URL("../public/research/", import.meta.url));
  fs.writeFileSync(root + "findings-2027.csv", csv);
  fs.writeFileSync(
    root + "findings-2027.json",
    JSON.stringify(
      {
        height_m: 2,
        stepHours: 1,
        startGridHours: 6,
        stayHours: 168,
        weights: [50, 30, 20],
        source: "Actual browser search and CSV exports",
        rows,
        errors,
      },
      null,
      2,
    ),
  );
  for (let i = 0; i < exports.length; i++)
    fs.writeFileSync(
      root +
        "findings-2027-export-" +
        rows.filter((r) => r.kind === "best_window")[i].key +
        ".csv",
      exports[i],
    );
  console.log(rows);
  console.log({ errors });
} finally {
  await b.close();
}
