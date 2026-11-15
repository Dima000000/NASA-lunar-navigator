import fs from "node:fs";
import { Ephemeris, summarizeVisibility } from "../app/science-core.mjs";
const root = new URL("../", import.meta.url),
  read = (p) => JSON.parse(fs.readFileSync(new URL(p, root))),
  bytes = fs.readFileSync(new URL("public/data/ephem.bin", root)),
  ephem = new Ephemeris(
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    read("public/data/ephem.json"),
  );
const out = "public/research/",
  annual = [];
for (const key of ["cr", "cr10", "shackleton"])
  for (const height of [2, 10]) {
    const m = read(`public/data/sites/${key}/meta.json`),
      profile = read(
        `public/data/sites/${key}/horizon_h${height}.json`,
      ).elev_deg;
    annual.push({
      key,
      lat: m.lat,
      lon: m.lon,
      height_m: height,
      year: 2026,
      ...summarizeVisibility(
        ephem,
        { lat: m.lat, lon: m.lon, centerHeightM: m.center_height_m },
        profile,
        Date.UTC(2026, 0, 1),
        Date.UTC(2027, 0, 1),
        height,
      ),
      coordinate_source: m.source,
    });
  }
fs.writeFileSync(
  new URL(out + "annual-illumination.json", root),
  JSON.stringify(annual, null, 2),
);
const cols = Object.keys(annual[0]);
fs.writeFileSync(
  new URL(out + "annual-illumination.csv", root),
  cols.join(",") +
    "\n" +
    annual
      .map((r) => cols.map((c) => JSON.stringify(r[c])).join(","))
      .join("\n"),
);
const archived = read("public/data/validation_vectors.json"),
  reg = [];
for (const r of archived) {
  const p = ephem.topo(
    ephem.state(Date.parse(r.utc)),
    r.lat,
    r.lon,
    r.h_m / 1000,
  );
  for (const body of ["sun", "earth"])
    reg.push({
      site: r.site,
      utc: r.utc,
      body,
      model_az: p[body].az,
      horizons_archived_az: r[body + "_az"],
      delta_az: ((p[body].az - r[body + "_az"] + 540) % 360) - 180,
      model_el: p[body].el,
      horizons_archived_el: r[body + "_el"],
      delta_el: p[body].el - r[body + "_el"],
    });
}
const rc = Object.keys(reg[0]);
fs.writeFileSync(
  new URL(out + "horizons-archived-regression.csv", root),
  rc.join(",") +
    "\n" +
    reg.map((r) => rc.map((c) => JSON.stringify(r[c])).join(",")).join("\n"),
);
const summary = {
  rows: reg.length,
  maxElevationErrorDeg: Math.max(...reg.map((r) => Math.abs(r.delta_el))),
  maxAzimuthErrorDeg: Math.max(...reg.map((r) => Math.abs(r.delta_az))),
  note: "Archived mirror reference, not a fresh month-long JPL download.",
};
fs.writeFileSync(
  new URL(out + "horizons-archived-regression.json", root),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ annual, regression: summary }, null, 2));
