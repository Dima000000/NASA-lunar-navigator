// Optional independent check; writes new UI-review evidence, never scientific baseline files.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Ephemeris } from "../app/science-core.mjs";
import { interpolateVisualState } from "../app/visual-time.mjs";
const root = new URL("../", import.meta.url),
  out =
    process.env.UI_REVIEW_OUT ||
    fileURLToPath(new URL("../work/ui-pass-review/", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, root))),
  meta = read("public/data/ephem.json"),
  buffer = fs.readFileSync(new URL("public/data/ephem.bin", root)),
  ephem = new Ephemeris(
    new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4),
    meta,
  ),
  site = read("public/data/sites/cr/meta.json"),
  height = (site.center_height_m + 2) / 1000;
let seed = 20261115;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  },
  times = Array.from({ length: 100 }, () =>
    Math.round(ephem.first + random() * (ephem.last - ephem.first - 3600000)),
  ).sort((a, b) => a - b),
  rows = [];
for (const [body, command] of [
  ["sun", "10"],
  ["earth", "399"],
])
  for (let offset = 0; offset < 100; offset += 25) {
    const batch = times.slice(offset, offset + 25),
      params = {
        format: "json",
        COMMAND: command,
        OBJ_DATA: "NO",
        MAKE_EPHEM: "YES",
        EPHEM_TYPE: "OBSERVER",
        CENTER: "coord@301",
        COORD_TYPE: "GEODETIC",
        SITE_COORD: `${site.lon},${site.lat},${height}`,
        TLIST: batch
          .map((t) => "'" + (t / 86400000 + 2440587.5).toFixed(10) + "'")
          .join(" "),
        TLIST_TYPE: "JD",
        TIME_TYPE: "UT",
        QUANTITIES: "4",
        ANG_FORMAT: "DEG",
        APPARENT: "AIRLESS",
        EXTRA_PREC: "YES",
        CSV_FORMAT: "YES",
      },
      url =
        "https://ssd.jpl.nasa.gov/api/horizons.api?" +
        new URLSearchParams(
          Object.entries(params).map(([k, v]) => [
            k,
            k === "format" || k === "TLIST" ? v : `'${v}'`,
          ]),
        );
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (response.ok || response.status < 500) break;
      } catch (e) {
        if (attempt === 2) throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!response.ok) throw Error("Horizons HTTP " + response.status);
    const result = await response.json();
    if (result.error) throw Error(result.error);
    const lines = result.result
      .split("$$SOE")[1]
      ?.split("$$EOE")[0]
      .trim()
      .split("\n");
    if (lines?.length !== batch.length)
      throw Error(
        "Unexpected Horizons sample count: " + result.result.slice(-1200),
      );
    fs.writeFileSync(
      `${out}/visual-horizons-${body}-${offset}.json`,
      JSON.stringify(
        { url, retrieved: new Date().toISOString(), ...result },
        null,
        2,
      ),
    );
    for (let i = 0; i < batch.length; i++) {
      const fields = lines[i].split(",").map((s) => s.trim()),
        az = Number(fields[3]),
        el = Number(fields[4]),
        p = ephem.topo(
          interpolateVisualState(ephem, batch[i]),
          site.lat,
          site.lon,
          height,
        )[body],
        deltaAz = ((p.az - az + 540) % 360) - 180,
        deltaEl = p.el - el;
      rows.push({
        utc: new Date(batch[i]).toISOString(),
        body,
        visualAz: p.az,
        horizonsAz: az,
        deltaAz,
        visualElevation: p.el,
        horizonsElevation: el,
        deltaElevation: deltaEl,
      });
    }
    console.log(body, offset + batch.length, "samples");
  }
const summary = {
  seed: 20261115,
  moments: 100,
  bodySamples: rows.length,
  coverage: "2024–2035; Connecting Ridge topocentric view at 2 m",
  maxElevationErrorDeg: Math.max(
    ...rows.map((r) => Math.abs(r.deltaElevation)),
  ),
  maxAzimuthErrorDeg: Math.max(...rows.map((r) => Math.abs(r.deltaAz))),
  reference:
    "Fresh JPL Horizons observer quantity 4, airless, irregular Julian-date UT inputs",
  passed: rows.every(
    (r) => Math.abs(r.deltaElevation) <= 0.01 && Math.abs(r.deltaAz) <= 0.01,
  ),
};
fs.writeFileSync(
  `${out}/visual-interpolation-horizons.json`,
  JSON.stringify(summary, null, 2),
);
const cols = Object.keys(rows[0]);
fs.writeFileSync(
  `${out}/visual-interpolation-horizons.csv`,
  cols.join(",") +
    "\n" +
    rows.map((r) => cols.map((c) => JSON.stringify(r[c])).join(",")).join("\n"),
);
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
