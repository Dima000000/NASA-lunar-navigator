# Drive follow-up review

Dark Vector · 15 November 2026. This follows the owner's screenshots and Drive feedback. Publication to main is authorised after a backup.

## Backup and preserved science

[backup-before-drive-fix-20261115](https://github.com/Dima000000/NASA-lunar-navigator/tree/backup-before-drive-fix-20261115) was pushed before editing, at `a9660c0e4e50e4810393f7711327f1e5123cfa03`.

`public/data/**`, `public/research/**`, `app/science-core.mjs`, `app/csv-export.mjs` and `app/original.css` have zero diff from that backup. The actual scientific browser CSV remains byte-identical: SHA-256 `ee9538bfcb367b48690c9e07176af1f79d40862c231c723eec9d2f1eef025237`. Existing colours, fonts and card styling are retained; the requested Drive arrangement is changed through additive styles.

## Result

| Feedback | Implemented behaviour |
|---|---|
| Clipped side panel | Drive starts with a compact place pill. Details remain available; the close control stays within the bounded, scrollable panel. |
| Zoom in the right column | Zoom and a purple Find rover control share the layer column. On short landscape screens the same controls form a compact horizontal row. |
| Analytical layers do not work | Ground colouring works with fine surface detail enabled. A separate compact legend avoids interfering with the timeline; touch screens have a Map layers toggle. |
| Wrong route origin | Navigation snapshots the actual fractional DEM position, UTC and battery of the rover. It uses a separate cancellable worker; a range-map update does not erase the route. |
| Huge Route here button | Compact action, disabled while planning and removed after success. A small status and Trip plan action replace it. |
| Route vanishes or shines through hills | The route uses depth-tested WebGL geometry on the exact terrain triangles. A live prefix starts at the rover every rendered frame. Off-course movement and changing time trigger replanning. |
| Find me and distinct marker | Find rover restores the camera without resetting position. Purple markers distinguish the rover from green place pins on the map and at distant zoom. Explicit vehicle reset remains in Mission. |
| Camera and turning | Smooth orbit and follow heading keep the rover centred. Driving returns the camera behind the heading after the manual-orbit grace period. Switching Terrain/Drive preserves the rover. |
| Arbitrary time speed and redundant Options | Editable nonnegative numeric multiplier, including decimals and zero. Both fields share one value and preserve typing during live updates. Mission retains dates, landing/liftoff, surface-detail and reset controls. Pause stops both motion and time. |
| Unreachable destination | A prominent dismissible red alert distinguishes steep/blocked terrain, planning horizon, energy failure and exhausted search budget. A budget failure is not labelled physical impossibility. |

## Navigation method and limits

Navigation uses the selected display DEM (481×481 at the built-in sites, about 33 m spacing over 16 km). Heights and the rendered route follow the same triangles. An energy-free reverse terrain search provides a travel-time lower bound and detects disconnected terrain. A narrow terrain corridor is tried first with the existing time-dependent energy model; if unsuitable, search expands to the full fine grid. Corridor and full-grid searches are bounded at 20,000 and 80,000 state expansions respectively, are cancellable and run away from the rendering thread. These are feasible candidate paths, not a global optimality or mission-safety guarantee.

Lighting retains the published input atlas: 31×31 spatial profiles (about 533 m), 5° azimuth bins, interpolated across the fine route. Energy integration uses samples no more than 15 minutes apart. Finer path geometry does not increase the source horizon resolution. The existing 20° rover threshold and vehicle power/battery remain scenario assumptions. Extremely large numeric multipliers use a maximum of 30 simulated seconds per frame for clock and rover stability; the Mission menu states this limit. No synthetic terrain has been inserted into lunar data.

## Validation

- **22 tests passed**, including exact triangle splitting, fractional route origins, blocked corridors, reverse travel-time agreement with exhaustive search, energy accounting and bounded time steps.
- [Drive browser report](drive-fix-evidence/drive-review.json): all analytical layers; slow decimal typing; pause; compact action; continuous route during driving/turning; Find rover; eight viewport transitions from 390×844 to 1920×1080, including paused resizing; a real route over 1 km starting at a fractional rover position; Terrain/Drive continuity; red failure alert. No page/render errors.
- [Touch report](drive-fix-evidence/touch-controls.json): over 200 m driven using the selected ×300 multiplier, steering, two-finger zoom and reset, mobile layer switching and portrait/landscape controls. This is touch emulation, not a physical-phone test.
- [Depth test](drive-fix-evidence/depth-occlusion.json): 832 cyan route pixels on flat terrain, zero behind the test ridge. Its three [fixture screenshots](drive-fix-evidence/fixture-ridge-hidden-route.png) use an isolated synthetic rendering fixture only; it is never a scientific input or part of the site.
- [Full-site browser report](drive-fix-evidence/full-browser-qa.json): startup, lazy downloads, real terrain, ephemerides across year boundaries, spatial horizons, top-five windows and failure recovery passed. All 4,326 actual scientific CSV comparisons still pass: maximum elevation error `0.000520324°`, azimuth `0.000514550°`.
- The active-route frame sample is preserved in the Drive report. Results vary with display scheduling and hardware; this is not a weak-laptop benchmark.
- The existing deployment gates, including fresh JPL verification of 100 fractional-time positions, remain enabled. New Drive/touch/depth checks and their downloadable artifacts are added before deployment.
- Browser animation checks wait for the measured camera position, completed layout and travelled distance, with bounded timeouts. This avoids treating the slower software renderer on GitHub's Linux runner as a failed fixed-duration animation.
- The render fixture detaches the live component and waits for painted frames, then verifies that its terrain key and absence of a rover remain intact before measuring route pixels. Queued live-data callbacks cannot replace its synthetic test scene.

Reproduce after installing dependencies: `npm test`, `npm run build`, `npx playwright install chromium`, `node tools/run-drive-reviews.mjs`. The last command starts/stops its own preview and saves reports/screenshots under ignored `work/drive-review/`. `CHROME_BIN` selects a local Chromium/Edge executable. Full-site/CSV checks remain `npm run test:browser` and `node tools/verify-browser-csv.mjs`.

Screenshots: [desktop](drive-fix-evidence/drive-1440x1000.png), [portrait](drive-fix-evidence/drive-390x844.png), [landscape touch](drive-fix-evidence/after-touch-landscape.png), [Sun layer](drive-fix-evidence/layer-sun.png), [red alert](drive-fix-evidence/unreachable-alert.png).
