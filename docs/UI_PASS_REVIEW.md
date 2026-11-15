# UI and mission-planning review

Dark Vector · 15 November 2026. Changes are based on the supplied UI feature brief. The owner explicitly authorised publication to main after making a backup, overriding the brief's branch-only publishing restriction.

## Backup and preservation

- [Backup tag: backup-before-ui-pass](https://github.com/Dima000000/NASA-lunar-navigator/tree/backup-before-ui-pass), commit `71e98b77dd21b2308a0c241e94976092126f8330`, pushed before editing.
- Work is retained in `feat/ui-pass`. The task's primary implementations have separate commits; follow-up review fixes are listed below.
- `public/data/**`, `public/research/**`, `app/science-core.mjs`, `app/csv-export.mjs` and `app/original.css` have **zero diff** from the backup.
- The original scientific browser CSV remains byte-identical to the backup. SHA-256: `ee9538bfcb367b48690c9e07176af1f79d40862c231c723eec9d2f1eef025237`. Trip CSV is a separate, new export; it does not replace the scientific export.
- Existing UI colours, fonts and card styles are retained. Layout and features are additive.

## Implemented tasks

| Task | Primary commit | Result |
|---|---|---|
| U1 | `e765a6b` | keep driving status clear of mode controls at all widths |
| U2 | `66c1919` | prevent overflowing cards, controls and long place names |
| U3 | `376915f` | separate plot labels, show full timeline names and percentage axes |
| U4 | `3afd000` | prioritize four understandable site metrics and collapse extra statistics |
| U6 | `2d55d61` | collapse detailed methods while retaining sources and scientific limitations |
| D1 | `6d835fb` | start the rover camera farther back using one named distance |
| D3 | `9b160dc` | add smooth rover zoom controls sharing the wheel zoom state |
| P1 | `6df4628` | retain and crossfade range textures with cancellable cooperative search |
| P2 | `e70546a` | animate continuous celestial directions and blend calculated lighting on GPU |
| D2 | `fa28a5a` | synchronize rover motion, battery and timeline with an explicit time multiplier |
| D5 | `d3aa6e7` | add a smoothed touch joystick and independent two-finger camera zoom |
| U5 | `eb224d6` | replace opaque sky circles with a terrain horizon panorama |
| U7 | `7123b5e` | explain charts through questions, target bands and time-specific readouts |
| D4 | `25fd2a2` | add explicitly illustrative near-camera surface detail without changing terrain |
| R5 | `41ae741` | make landing and liftoff editable mission dates shared by every analysis |
| R4 | `7c619c0` | show a labelled fading trace of the illustrative descent animation |
| R1 | `7826eb6` | route to a selected coordinate and reconstruct a timed energy-aware trip plan |
| R2 | `0b05ef5` | rank top five terrain-grid spots for the selected mission in a cancellable worker |
| R3 | `7f46abf` | plan 1–30 days and show travel-time terrain, contours and trip exports |
| O1 | `103a9db` | guide first-time visitors through six keyboard-accessible steps |
| X1 | `ed5355b` | assess nine unused NASA data opportunities and their accuracy and delivery limits |
| P1 | `6e52152` | display completed range snapshots during playback without requiring an exact current-hour match |
| R2 | `9be882d` | cancel and clear rankings when mission dates, place or ranking settings change |
| U2 | `1cef98b` | clear overview tips and terrain controls from navigation and mission handles |
| P2 | `76e7ca7` | gate deployment on independent Horizons checks at 100 irregular times and archive the responses |

P1 uses cooperative worker cancellation and retained crossfading canvas snapshots, including completed snapshots whose departure hour is older than the live clock. P2 interpolates only visual directions; hourly scientific values are preserved. Drive time multipliers replace the old overlapping turbo meaning with one explicit time scale; the fast-mode button toggles ×60/×300.

R1/R3 routes snap the current rover or landing origin and destination to a 533 m grid. A selected range-map cell opens a timed trip plan with drive/wait segments, geometric Earth visibility, battery trace and a separate CSV. The solver remains a bounded approximation, not a global-optimality or flight-safety claim. R2 uses the same score, weights, any-disc definition and measured horizon as Landing windows; it clears results when dates/settings change. Mission dates feed the existing analysis period directly.

## Verification

- `npm test`: **17 passed, 0 failed**. Includes existing archived Horizons, byte/hash, illumination, conservative-slope and energy tests plus new interpolation, ranking, charging-stop, route-chain and contour checks.
- `npm run build`: passed. Full output: [test-and-build.txt](ui-pass-evidence/test-and-build.txt).
- Existing end-to-end browser review: 10 scenarios passed, including Fast 4G startup (3.45 s / 1.17 MB in this run), 481 × 481 lighting, 300 km custom horizons, cross-year data, missing-asset recovery and scientific CSV export. [Result](ui-pass-evidence/science-browser-qa.json).
- Original browser CSV vs archived independent JPL month: 4,326 samples, maximum elevation difference **0.000520324°**, azimuth **0.00051455°**, dominated by 0.001° CSV rounding. Original baseline files are unchanged.
- Visual interpolation unit check: 100 seeded irregular times, exact equality at hourly nodes and <0.01° difference from unchanged table interpolation. This unit check is not an independent Horizons measurement. An **additional deployment gate** queries fresh JPL Horizons for Sun and Earth at 100 irregular times across 2024–2035; raw replies and the comparison table are attached to the deployment run as `visual-interpolation-horizons`. The local direct JPL connection reset TLS, so that independent check runs on GitHub's runner.
- Functional browser checks: nonzero seven-day route, trip plan, top-five slope-safe spots, SVG viewports, mission-date propagation and stale-ranking invalidation. [Result](ui-pass-evidence/ui-functional.json).
- Layout review: Overview, Terrain, Land, Drive, Compare, Science and Landing windows at **1920 / 1440 / 1280 / 1024 / 768 / 390 px**. No collisions among visible active controls; covered background controls and closed-details fields are excluded. [Result](ui-pass-evidence/layout-review.json).
- Touch input through browser touch events: **251 m**, a **1.48 rad** turn, no page scroll, two-finger zoom from 0.025 to 0.015625 km and reset to 0.025 km. [Result](ui-pass-evidence/touch-controls.json).
- First visit, next/back/escape, persistent dismissal, reload and manual tour replay verified. [Result](ui-pass-evidence/performance-and-tour.json).

## Published verification

Implementation commit `4311aae1897a2e494658ec188ff5c3c29be8b07e` passed [GitHub's full build and deployment](https://github.com/Dima000000/NASA-lunar-navigator/actions/runs/43708411304). The independent irregular-time Horizons comparison **passed**: 100 seeded times, 200 Sun/Earth samples across 2024–2035, maximum elevation error **0.000109815°**, maximum azimuth error **0.000097262°**; both below 0.01°. Raw NASA replies, the actual request URLs, the [200-row table](ui-pass-evidence/jpl-fractional-time/visual-interpolation-horizons.csv) and [summary](ui-pass-evidence/jpl-fractional-time/visual-interpolation-horizons.json) are preserved in this repository. This checks topocentric directions, not the terrain-shadow model.

The [public site](https://dima000000.github.io/NASA-lunar-navigator/) was then opened anonymously in fresh desktop and mobile browser contexts: first-run tour and keyboard back/next, measured terrain, touch controls, five valid chart SVG viewports and the published route worker passed, without runtime errors. [Check results](ui-pass-evidence/public-site-check.json), [desktop frame](ui-pass-evidence/published-drive-1440.png), [mobile frame](ui-pass-evidence/published-drive-390.png). This documentation/evidence update changes no application or scientific inputs.

## Frame timing

Ten-second samples after warm-up on this Windows host, headless Edge. Play = 6 h/s; Drive = ×60 model time. Mobile is touch/viewport emulation with DPR 3 (renderer caps DPR at 1.75), **not a physical phone or weak-laptop benchmark**. These are measured animation-frame timings, not a guarantee for other hardware.

| Profile | Scenario | Mean FPS | p95 frame interval | >50 ms main-thread tasks |
|---|---|---:|---:|---:|
| Desktop 1440 × 1000 | play | 119.8 | 8.4 ms | 0 |
| Desktop 1440 × 1000 | drive | 120.0 | 8.4 ms | 0 |
| Mobile emulation, DPR 3 | play | 119.9 | 8.5 ms | 0 |
| Mobile emulation, DPR 3 | drive | 120.0 | 8.5 ms | 0 |

Seven-day reachability: **5.70 s desktop / 5.75 s mobile emulation** in the measured run. During 6 h/s playback, the range layer refreshed 16/19 times and remained visible. [Raw timing results](ui-pass-evidence/performance-and-tour.json).

## Visual evidence

| Task / screen | Before, 1440 | After, 1440 | Before, 390 | After, 390 |
|---|---|---|---|---|
| U1/U2 Drive | [image](ui-pass-evidence/before-drive-1440.png) | [image](ui-pass-evidence/after-drive-1440.png) | [image](ui-pass-evidence/before-drive-390.png) | [image](ui-pass-evidence/after-drive-390.png) |
| U3 comparison | [image](ui-pass-evidence/before-compare-1440.png) | [graphs](ui-pass-evidence/after-compare-graphs-1440.png) | [image](ui-pass-evidence/before-compare-390.png) | [graphs](ui-pass-evidence/after-compare-graphs-390.png) |
| U4 place metrics | [comparison](ui-pass-evidence/before-compare-1440.png) | [cards](ui-pass-evidence/after-compare-cards-1440.png) | [comparison](ui-pass-evidence/before-compare-390.png) | [cards](ui-pass-evidence/after-compare-cards-390.png) |
| U5 sky panorama | [old circles](ui-pass-evidence/before-compare-1440.png) | [panorama](ui-pass-evidence/after-compare-cards-1440.png) | [old circles](ui-pass-evidence/before-compare-390.png) | [panorama](ui-pass-evidence/after-compare-cards-390.png) |

All six Drive widths and all reviewed screens are in [ui-pass-evidence](ui-pass-evidence/). Also see [trip plan](ui-pass-evidence/after-trip-1440.png), [touch driving frame](ui-pass-evidence/after-touch-200m.png), [mission tour](ui-pass-evidence/after-onboarding-mission-390.png) and [expanded place details](ui-pass-evidence/after-place-stats-390.png).

Found and fixed: HUD/mode collision; mobile toolbar wrapping; zoom/pad overlap; scene settings covering the rover; tips over navigation; terrain camera buttons over liftoff; mobile terrain layer buttons over cards; clipped graph SVG viewports; labels beside coincident scatter points; narrow timeline names; missing percentage-label margins; projected coordinate-label collisions; expanded Drive card bounds. Overlay windows intentionally cover background scene controls.

## Reproduce

Install dependencies, restore data with `npm run prepare:data`, run `npm test` and `npm run build`. Start `npm run preview -- --port 4173` in one terminal. In another run:

```text
node tools/ui-functional-review.mjs
node tools/ui-layout-review.mjs
node tools/ui-performance-review.mjs
node tools/ui-touch-review.mjs
node tools/verify-visual-interpolation.mjs
```

`BASE_URL`, `UI_REVIEW_OUT` and `CHROME_BIN` are optional overrides. Outputs default to ignored `work/ui-pass-review/`. The independent Horizons check requires NASA network access. Deployment still includes the original science/browser/CSV checks and additionally archives the new independent interpolation comparison.

## Limits and remaining hardware validation

Physical iPhone/Pixel and a weak laptop were not available. Their thermal behaviour and sustained frame rate remain unverified. Long route horizons may reach the declared search budget; grey cells then include unsearched cells and are not proof of impossibility. Routes can revisit cells and do not guarantee minimum distance. Grid snapping can shift endpoints by hundreds of metres. Sky panoramas clip their display to −5…+15° without changing underlying values. Fine surface normals and descent traces are explicitly illustrative. Eclipse attenuation, spacecraft thermal dynamics and a certified RF link budget remain outside the current vehicle scenario. X1 is a [documented assessment](IDEAS_UNUSED_DATA.md), not nine newly implemented scientific features.

## Full commit record

```text
e765a6b U1: keep driving status clear of mode controls at all widths
66c1919 U2: prevent overflowing cards, controls and long place names
376915f U3: separate plot labels, show full timeline names and percentage axes
3afd000 U4: prioritize four understandable site metrics and collapse extra statistics
2d55d61 U6: collapse detailed methods while retaining sources and scientific limitations
6d835fb D1: start the rover camera farther back using one named distance
9b160dc D3: add smooth rover zoom controls sharing the wheel zoom state
6df4628 P1: retain and crossfade range textures with cancellable cooperative search
e70546a P2: animate continuous celestial directions and blend calculated lighting on GPU
fa28a5a D2: synchronize rover motion, battery and timeline with an explicit time multiplier
d3aa6e7 D5: add a smoothed touch joystick and independent two-finger camera zoom
eb224d6 U5: replace opaque sky circles with a terrain horizon panorama
7123b5e U7: explain charts through questions, target bands and time-specific readouts
25fd2a2 D4: add explicitly illustrative near-camera surface detail without changing terrain
41ae741 R5: make landing and liftoff editable mission dates shared by every analysis
7c619c0 R4: show a labelled fading trace of the illustrative descent animation
7826eb6 R1: route to a selected coordinate and reconstruct a timed energy-aware trip plan
0b05ef5 R2: rank top five terrain-grid spots for the selected mission in a cancellable worker
7f46abf R3: plan 1–30 days and show travel-time terrain, contours and trip exports
103a9db O1: guide first-time visitors through six keyboard-accessible steps
862d894 R1/R2/R3: verify worker payloads, preserve prior ranges and draw grounded route references
1942e7b U1/U2/U3: resolve compact and touch layout collisions found in six-width browser review
10aa17a P2/R1/R2/R3: add reproducible interpolation, ranking, trip and contour regression checks
1a5c339 U1/U2/D1/O1: keep mobile controls clear and tune the opening rover camera
ed5355b X1: assess nine unused NASA data opportunities and their accuracy and delivery limits
82ae4e7 P1/R1/R3: retain in-flight fades, route from the rover and open plans from range-map clicks
6e52152 P1: display completed range snapshots during playback without requiring an exact current-hour match
d1d68f0 U3/U4/U6/R4: restore SVG viewport binding and complete clear four-metric place cards
f812339 U2/U4: make expanded driving place details readable above the scene on narrow screens
9be882d R2: cancel and clear rankings when mission dates, place or ranking settings change
026e643 U6/R2: show concise scientific checks and apply the exact landing-window visibility definition to spot ranking
e56e327 R3/U6: keep the 3D travel-time legend visible and tighten the scientific summary
2d10074 UI: preserve reproducible visual, performance and touch reviews alongside readable feature modules
6cac3a3 U1/U2/D5: keep touch status expansion and surface settings clear of the rover
1cef98b U2: clear overview tips and terrain controls from navigation and mission handles
8572731 U2/R3: declutter projected coordinate labels and ignore covered controls during dialog layout checks
76e7ca7 P2: gate deployment on independent Horizons checks at 100 irregular times and archive the responses
```

## Diff from the backup (implementation, before evidence/report commit)

```text
.github/workflows/pages.yml           |    8 +
 app/component.js                      |  106 ++-
 app/entry.mjs                         |    4 +-
 app/guided-tour.mjs                   |  164 +++++
 app/planning-analysis.mjs             |  246 +++++++
 app/route-search.mjs                  |   11 +-
 app/science-runtime.mjs               |   21 +-
 app/science-worker.mjs                |  190 ++++--
 app/sky-panorama.mjs                  |   66 ++
 app/standalone-runtime.js             |    2 +-
 app/template.html                     |   94 +--
 app/ui-pass.css                       | 1183 +++++++++++++++++++++++++++++++++
 app/ui-pass.mjs                       |  789 ++++++++++++++++++++++
 app/visual-time.mjs                   |   37 ++
 docs/IDEAS_UNUSED_DATA.md             |   49 ++
 index.html                            |   94 +--
 tests/science.test.mjs                |    2 +
 tests/ui-analysis.test.mjs            |  186 ++++++
 tools/browser-review.mjs              |    2 +
 tools/ui-functional-review.mjs        |  175 +++++
 tools/ui-layout-review.mjs            |  162 +++++
 tools/ui-performance-review.mjs       |  200 ++++++
 tools/ui-touch-review.mjs             |  118 ++++
 tools/verify-visual-interpolation.mjs |  145 ++++
 24 files changed, 3859 insertions(+), 195 deletions(-)
```
