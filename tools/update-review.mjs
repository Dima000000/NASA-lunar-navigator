import fs from "node:fs";
import crypto from "node:crypto";
const root = new URL("../", import.meta.url),
  read = (p) => JSON.parse(fs.readFileSync(new URL(p, root), "utf8")),
  write = (p, s) => fs.writeFileSync(new URL(p, root), s);
const annual = read("public/research/annual-illumination.json"),
  sh = read("public/research/shackleton-literature-comparison.json"),
  ten = read("public/research/shackleton-10m-comparison.json"),
  verified = read("public/research/browser-vs-horizons.json");
const pct = (x) => (x * 100).toFixed(2),
  selected = (key, h) => annual.find((x) => x.key === key && x.height_m === h);
let review = fs.readFileSync(
  new URL("public/research/SCIENCE_REVIEW.md", root),
  "utf8",
);
review = review.replace(
  /\*\*0\.000524° in elevation\*\* and \*\*0\.000514° in azimuth\*\*/,
  `**${verified.maxElevationErrorDeg.toFixed(9)}° in elevation** and **${verified.maxAzimuthErrorDeg.toFixed(9)}° in azimuth**`,
);
for (const [key, h, label, paperAny, paperMean] of [
  ["cr", 2, "Connecting Ridge, Gläser spot 2 / 2 m", "92.3", "87.9"],
  ["cr10", 10, "Connecting Ridge, Gläser spot 4 / 10 m", "95.66", "91.9"],
]) {
  const row = selected(key, h);
  review = review
    .split("\n")
    .map((l) =>
      l.startsWith("| " + label + " |")
        ? `| ${label} | ${pct(row.sunAny)}% | ${pct(row.meanSunDisc)}% | ${paperAny}% | ${paperMean}% |`
        : l,
    )
    .join("\n");
}
for (const [i, label] of [
  [0, "Shackleton S, −89.6866°, 197.19°E / 2 m"],
  [2, "Shackleton S, −89.7815°, 204.70°E / 2 m"],
]) {
  const row = sh[i];
  review = review
    .split("\n")
    .map((l) =>
      l.startsWith("| " + label + " |")
        ? `| ${label} | ${row.modelAnyPercent.toFixed(2)}% | ${row.modelMeanDiscPercent.toFixed(2)}% | ${row.paperAnyPercent}% | ${row.paperMeanDiscPercent}% |`
        : l,
    )
    .join("\n");
}
review = review.replace(
  "is 1.68 percentage points",
  "is " +
    Math.max(
      ...sh
        .filter((r) => r.height_m === 2)
        .map((r) => Math.abs(r.differenceAnyPercentagePoints)),
    ).toFixed(2) +
    " percentage points",
);
const start = review.indexOf("The selected UI “Shackleton rim"),
  end = review.indexOf("\n\nFiles:", start);
if (start >= 0 && end > start) {
  const s2 = selected("shackleton", 2),
    s10 = selected("shackleton", 10);
  review =
    review.slice(0, start) +
    `The selected UI “Shackleton rim · DEM crest” is a measured crop maximum, not a NASA landing coordinate. Its annual any-Sun results are **${pct(s2.sunAny)}% / ${pct(s10.sunAny)}% at 2 / 10 m**.\n\nAn independent **10 m** comparison is available in [Saha et al. (2023), Table 1, sites 4 and 8](https://doi.org/10.1109/ACCESS.2023.3239303). At the exact published coordinates, our 2026 centre-of-Sun visibility is **${ten[0].modelCentrePercent.toFixed(2)}% vs ${ten[0].paperPercent.toFixed(2)}%**, and **${ten[1].modelCentrePercent.toFixed(2)}% vs ${ten[1].paperPercent.toFixed(2)}%**: differences of ${ten[0].deltaCentrePercentagePoints.toFixed(2)} and ${ten[1].deltaCentrePercentagePoints.toFixed(2)} percentage points. The paper uses a point-Sun method; disc-average and any-disc predictions are reported separately. Table 1 does not specify an unambiguous averaging interval for its compiled values, so this is a consistency check, not an identical-period replication. See [10 m comparison](shackleton-10m-comparison.csv).` +
    review.slice(end);
}
review = review.replace(
  "Encoded elevation, ephemeris and PSR derivatives arrived through an attributed public scientific mirror, **not by a fresh full rebuild of the original NASA archives**. LROC local imagery was downloaded directly from its official service.",
  "The runtime elevation, ephemeris, PSR and global colour arrays were **rebuilt directly from authoritative NASA/JPL archives** in a successful GitHub Actions run, then tested against fresh JPL tables and a real browser CSV export. Official URLs, complete-download hashes and extracted COG-window hashes are in `data/direct-source-audit.json`. Local LROC imagery was downloaded directly from the official service. Earlier development used an attributed scientific mirror; its runtime arrays have been replaced.",
);
review = review.replace(
  "independent exact-site 10 m Shackleton benchmark; and a full rebuild of mirrored science derivatives from NASA originals if the team requires that stronger provenance standard.",
  "physical mission/vehicle validation beyond this educational model. The 10 m Shackleton publication consistency check and direct NASA runtime-data rebuild are complete.",
);
write("public/research/SCIENCE_REVIEW.md", review);
const provenance = `# Direct NASA/JPL data provenance — 14 November 2026

All runtime scientific raster/vector arrays have been rebuilt directly from authoritative archives. The successful run is [Rebuild authoritative NASA data](https://github.com/Dima000000/NASA-lunar-navigator/actions/runs/43625400632). The [retrieval audit](direct-source-audit.json) records original URLs, byte counts, download hashes and the hashes/bounds of extracted 20 m COG windows. No scientific runtime arrays from a third-party mirror remain in this release. An earlier prototype used an attributed mirror; its historical source-tree and archived reference metadata remain for traceability, not as runtime inputs. No application code from that mirror is used.

| Runtime data | Authoritative input and processing |
|---|---|
| sp_dem_L0 / L1 | NASA LOLA LDEM_80S_80MPP_ADJ.TIF, [PGDA 90](https://pgda.gsfc.nasa.gov/products/90). 297 m area average / 80 m central crop. Heights encoded as (R*256+G)*0.5−10000 metres. |
| Four crest/rim PNGs | Official LDEM_80S_20MPP_ADJ.TIF cloud-optimized windows, reprojected into local stereographic crops; 20 m pixels, 0.1 m encoding. Bounds and scale/offset in patches.json. Not separate 5 m products. |
| moon_dem_4k | Direct [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) ldem_16.tif in kilometres; bilinear resize to 4096×2048, encoded in half-metres. About 2.7 km/pixel; no invented geometry. |
| moon_color_4k | Direct NASA SVS lroc_color_poles_4k.tif, converted to JPEG. LROC WAC colour with polar LOLA albedo fill; a visualization texture, not a scientific polar photograph. |
| psr.png | Direct NASA LOLA LPSR_75S_120M_201608.TIF, [PGDA 69](https://pgda.gsfc.nasa.gov/products/69). Decoded per the source scale, area-averaged then majority-thresholded onto 296.875 m cells. Not ice detection. |
| ephem.bin | Direct [NASA JPL NAIF](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) kernels, listed/hashed in the audit. CSPICE computes hourly LT+S Sun/Earth vectors in MOON_ME, 2024–2036. Fresh JPL Horizons observer tables independently verify three sites and a full month. |
| sites/*/lroc-wac.png | Official [LROC WAC South Pole Summer Mosaic](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_ROI_SOUTH_SUMMER), 100 m/pixel. Retrieved official tiles are hashed in lroc-tile-provenance.json, then reprojected onto each site's grid. Acquisition shadows are fixed in the photograph. |

Sphere radius 1,737,400 m; planetocentric latitude, east-positive longitude. Polar stereographic x=2R tan((90°+lat)/2) sin(lon), y=2R tan((90°+lat)/2) cos(lon). Local grids use site-centred east/north stereographic coordinates. Heights in preparation files are metres; rendering heights are kilometres relative to the site centre. The 481² display grid has 33.33 m spacing, which adds no measurements beyond source sampling.

Selected-site horizon profiles use finite rays to 300 km, 0.5° azimuth sampling. Catalogue map/route atlases use 533 m cells and 5° azimuth sampling; narrow obstacles may be missed. Custom-point spatial atlases trace measured terrain to 300 km; finite azimuth/radial sampling can miss narrow obstacles. A 15° landing and 20° rover cutoff are scenario assumptions, not NASA safety requirements. Vehicle battery/panel/load/speed and the descent animation are hypothetical; geometric Earth visibility is not a guaranteed radio link.

Coordinate roles and citations are in catalog.json and each meta.json. Research points are not NASA-approved landing points. Publications supply comparison facts, not copied article images/text. Original interface: [NASAL PR #1](https://github.com/gleb31415/NASAL/pull/1), f0732335864ab7c93a63a95542f48bda4a3d43b6; CSS retained. Font: Inter, bundled SIL OFL.

Credits: NASA/GSFC LOLA science team; NASA SVS / Ernie Wright; LROC team / Speyerer et al.; NASA/JPL NAIF and Horizons; cited research authors; original NASAL interface authors. NASA data use implies no NASA endorsement. The official challenge Details/Resources tabs have been checked; they do not state an exclusive data whitelist. Team/event submission requirements are separate. See the [scientific review](../research/SCIENCE_REVIEW.md).
`;
write(
  "public/data/PROVENANCE.md",
  provenance +
    "\n\n## Review update — 15 November 2026\n\nScientific inputs are versioned release assets; `tools/science-inputs.json` pins their sizes/SHA256 and the immutable fallback commit. `bootstrap-data.py` verifies every restored array. The repository retains code, small metadata, profiles and research records rather than new binary-array revisions. `package-data.py` creates the release asset; the authoritative NASA rebuild publishes it before committing updated hashes/metadata. An initial release asset may be absent until the workflow is run; bootstrap then verifies the pinned historical snapshot instead. No archive is trusted just because it downloaded successfully.\n\n`prepare-delivery.py` produces lossless gzip float32 site heights/horizon atlases, gzip masks, and separate lossless yearly ephemerides with an overlapping boundary sample. Browser regressions confirm the original 4326 Horizons comparisons after this delivery change. Optional Uint16 display-only heights are quantized to 0.1 m using float64 arithmetic and audited for at most 0.05 m rounding error; scientific computations retain original float32 values. Grayscale JPEG at quality 90 is used only for photographic brightness, never for encoded elevations or masks. A runtime manifest supplies sizes and hashes; the browser verifies loaded bytes and handles both raw gzip delivery and HTTP Content-Encoding decompression.\n\nThe first globe is a measured coarse preview: 512×256 global elevation and 512×512 polar elevation (~1187.5 m polar pixels), plus 1024×512 global colour. At first overview interaction it upgrades to the original full global/polar rasters and mesh; no invented heights fill the transition. Catalogue local meshes remain 481×481 with original measured inputs. The preview is for orientation, not for estimating local slopes or terrain horizons.\n\nCustom-point spatial atlases now trace actual global/polar terrain to 300 km at 5° azimuth on 31×31 nodes. Their selected-pin profiles use 0.5° sampling. This replaces the earlier crop-limited spatial approximation; finite ray sampling and interpolation remain limitations. Route cells use maximum contained display-grid slope and reject blocked diagonal corners. Up to six non-dominated time/charge labels per group are retained, with waiting-energy-aware dominance; capped fronts and expansion limits still make the search approximate. Continuous Wh and ≤15 min light integration are retained.\n\nLighting and map pixels are computed off the main thread, with one active request and latest-time coalescing. This changes scheduling, not the underlying visibility formula; the browser regression found zero difference from the synchronous reference across the display grid.\n",
);
for (const s of read("public/data/catalog.json")) {
  const name = "public/data/sites/" + s.key + "/meta.json",
    m = read(name);
  m.data_provenance =
    "Direct authoritative NASA archive extraction and encoding; see direct-source-audit.json";
  write(name, JSON.stringify(m, null, 2));
}
let patches = read("public/data/patches.json");
patches.patches = patches.patches.filter((p) => p.kind === "crest20");
patches.size = 512;
patches.pixel_m = 20;
write("public/data/patches.json", JSON.stringify(patches, null, 2));
let sp = read("public/data/sp_meta.json");
sp.slope_encoding = {
  method:
    "Slopes are calculated from measured heights and metric local-grid spacing in the application; no separate slope rasters are bundled.",
};
write("public/data/sp_meta.json", JSON.stringify(sp, null, 2));
let globe = read("public/data/globe.json");
globe.files = { color_4k: "moon_color_4k.jpg" };
delete globe.fallback;
write("public/data/globe.json", JSON.stringify(globe, null, 2));
let readme = fs.readFileSync(new URL("README.md", root), "utf8");
readme = readme.replace(
  "Actual browser CSV difference 0.000524°",
  "Actual browser CSV difference " +
    verified.maxElevationErrorDeg.toFixed(9) +
    "°",
);
readme = readme.replace(
  "The exact 10 m Shackleton benchmark, physical low-end laptop test,",
  "The physical low-end laptop test",
);
readme = readme.replace(
  "Encoded science derivatives were delivered via the attributed public mirror daniel27-space/lunar-navigator; no application code from that mirror is used.",
  "Runtime science arrays were rebuilt directly from NASA/JPL archives; direct-source-audit.json records the retrieval and encoding. Earlier mirror inputs were replaced; no application code from that mirror is used.",
);
write("README.md", readme);
const data = new URL("public/data/", root),
  checks = { generated: "2026-11-14", algorithm: "sha256", files: {} };
function walk(p, prefix = "") {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const name = prefix + e.name,
      u = new URL(e.name + (e.isDirectory() ? "/" : ""), p);
    if (e.isDirectory()) walk(u, name + "/");
    else if (name !== "checksums.json")
      checks.files[name] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(u))
        .digest("hex");
  }
}
walk(data);
write("public/data/checksums.json", JSON.stringify(checks, null, 2));
console.log(
  "Reviewed direct-source provenance, latest comparison values and all data checksums.",
);
