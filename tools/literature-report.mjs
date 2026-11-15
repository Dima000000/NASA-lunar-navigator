import fs from "node:fs";
import { Ephemeris, summarizeVisibility } from "../app/science-core.mjs";
const root = new URL("../public/", import.meta.url),
  read = (p) => JSON.parse(fs.readFileSync(new URL(p, root), "utf8")),
  b = fs.readFileSync(new URL("data/ephem.bin", root)),
  e = new Ephemeris(
    new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4),
    read("data/ephem.json"),
  ),
  results = [];
for (const site of read("research/shackleton-literature-inputs.json"))
  for (const height of [2, 10]) {
    const model = summarizeVisibility(
      e,
      site,
      site.profiles[height],
      Date.UTC(2026, 0, 1),
      Date.UTC(2027, 0, 1),
      height,
    );
    results.push({
      key: site.key,
      lat: site.lat,
      lon: site.lon,
      height_m: height,
      year: 2026,
      modelAnyPercent: model.sunAny * 100,
      modelMeanDiscPercent: model.meanSunDisc * 100,
      modelLongestDarkHours: model.longestDarkHours,
      paperAnyPercent: height === 2 ? site.paper_any_percent : null,
      paperMeanDiscPercent: height === 2 ? site.paper_mean_percent : null,
      differenceAnyPercentagePoints:
        height === 2 ? model.sunAny * 100 - site.paper_any_percent : null,
      differenceMeanPercentagePoints:
        height === 2 ? model.meanSunDisc * 100 - site.paper_mean_percent : null,
      paperPeriod: "2017-01-01 / 2037-01-01, hourly",
      reference:
        "https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf#page=12",
      note:
        height === 2
          ? "Same published coordinate and height, different averaging periods and DEM editions; not an identical-period replication."
          : "Annual model output; Table 2 has no 10 m benchmark for this exact point. No invented reference value.",
    });
  }
fs.writeFileSync(
  new URL("research/shackleton-literature-comparison.json", root),
  JSON.stringify(results, null, 2),
);
const keys = Object.keys(results[0]);
fs.writeFileSync(
  new URL("research/shackleton-literature-comparison.csv", root),
  keys.join(",") +
    "\n" +
    results
      .map((r) => keys.map((k) => JSON.stringify(r[k])).join(","))
      .join("\n"),
);
console.log(results);
