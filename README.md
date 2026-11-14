# NASA Lunar Navigator

A standalone lunar mission planner preserving [NASAL PR #1](https://github.com/gleb31415/NASAL/pull/1), with measured NASA LOLA terrain and actual LROC images. Independent project; no NASA endorsement.

Public site: https://Dima000000.github.io/NASA-lunar-navigator/

## Run and build

Requires Node 24. Run `npm ci`, `npm test`, then `npm run start`. Production: `npm run build`. GitHub Pages deploys dist through `.github/workflows/pages.yml`. Runtime data load from `data/sites/<key>/`; the browser needs no JPL connection or Claude runtime.

## Implemented

Original overview, terrain, animated landing, manual rover, comparisons, charts and CSV exports; 481×481 local measured terrain; official 100 m LROC WAC imagery; hourly SPICE DE440/MOON_ME positions from 2024–2036; default LOLA horizon profiles to 300 km; published LRO permanent-shadow mask; twelve source-linked research points; top-five mission windows; and time/energy-dependent routes with charging waits and Earth visibility.

## Validation and limits

Fresh JPL tables: 4326 hourly comparisons, three sites, 2026-11-14 to 2026-12-14. Maximum model elevation difference 0.00002678°. Actual browser CSV difference 0.000524°, including rounding. Raw answers and comparisons are committed.

Annual Connecting Ridge and Shackleton results are compared with publications. The exact 10 m Shackleton benchmark, physical low-end laptop test, and team/event-specific submission checks remain open. The official challenge Details and Resources tabs have been checked. Historical Artemis regions are identified accurately; current Artemis III is an Earth-orbit test.

Read [the scientific review](public/research/SCIENCE_REVIEW.md), [provenance](public/data/PROVENANCE.md), [CSV vs JPL](public/research/browser-vs-horizons.csv), and browser test records in public/research/. This is not landing or navigation certification.

## Reproduce

`node tools/science-report.mjs` computes annual selected-site outputs. `node tools/literature-report.mjs` compares the prepared Shackleton profiles. `node tools/verify-horizons.mjs` obtains fresh independent JPL answers and updates verification status only after all samples pass. `node tools/verify-browser-csv.mjs` checks actual browser exports.

Python preparation scripts require NumPy and Pillow. build_science.py and build_atlases.py prepare site grids/horizons from documented encoded rasters; build_lroc.py obtains official image tiles. They do not recreate the full NASA processing chain from laser ranging observations.

## Credits

NASA/GSFC LOLA Science Team, NASA/JPL NAIF and Horizons, NASA SVS / Ernie Wright, LROC team, Gläser et al., the published CLS-coordinate study (10.1029/2025JE009434), and the original NASAL authors. Encoded science derivatives were delivered via the attributed public mirror daniel27-space/lunar-navigator; no application code from that mirror is used. Consult individual data and font metadata. This repository does not assert a blanket licence over third-party material.
