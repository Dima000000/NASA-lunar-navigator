# Scientific review — 14 November 2026

This is a research and educational planner, preserving the NASAL PR interface. It is not a NASA product, a flight dynamics simulator, a certified landing assessment, or a guaranteed power/radio-link analysis.

## 1. Independent JPL Horizons comparison

Fresh JPL observer tables cover **2026-11-14 through 2026-12-14 UTC**, hourly, for Connecting Ridge, Shackleton rim and de Gerlache rim. Both Sun and Earth were queried: **4326 comparisons**. Observer altitude includes the measured terrain elevation above the 1737.4 km reference sphere plus a 2 m mast. Quantity 4, airless apparent angles, east-positive lunar longitude.

The calculation module differs from JPL by at most **0.00002678° in elevation**. The actual website CSV, rounded to 0.001°, differs by at most **0.000520324° in elevation** and **0.000514550° in azimuth**. Both satisfy the requested 0.1° criterion. The live queries ran in GitHub Actions because direct JPL connections from the development machine failed. Raw JPL responses are retained in the repository under `public/research/horizons-raw/`.

Reproduce: `node tools/verify-horizons.mjs`, export the matching three sites and month from the browser, then `node tools/verify-browser-csv.mjs`. See [CSV vs JPL](browser-vs-horizons.csv), [full precision comparison](horizons-month-comparison.csv), [status](verification-status.json). This verifies sky directions; it does not independently verify every terrain horizon or shadow boundary.

## 2. Annual illumination and publications

Annual outputs use 8760 hourly samples in 2026, a circular solar disc, terrain rays to 300 km, and 2/10 m observer heights. `sunAny` means any appreciable part of the disc is visible (>0.05%); `meanSunDisc` averages the visible area of the disc. These are different quantities. Neither is electrical yield.

| Point / height | Model: any Sun | Model: mean visible disc | Published any Sun | Published mean disc |
|---|---:|---:|---:|---:|
| Connecting Ridge, Gläser spot 2 / 2 m | 92.07% | 87.90% | 92.3% | 87.9% |
| Connecting Ridge, Gläser spot 4 / 10 m | 95.63% | 92.26% | 95.66% | 91.9% |
| Shackleton S, −89.6866°, 197.19°E / 2 m | 89.99% | 85.87% | 89.4% | 85.5% |
| Shackleton S, −89.7815°, 204.70°E / 2 m | 87.08% | 80.95% | 89.8% | 82.1% |

Connecting Ridge references: [Gläser et al., EPSC 2014, table](https://elib.dlr.de/94242/1/EPSC2014-136-1.pdf) and [Icarus article](https://doi.org/10.1016/j.icarus.2014.08.013). The remembered “92% / 96%” numbers apply to selected, different points and heights, averaged over the paper's long period; they are not a universal annual property of the ridge.

Shackleton reference: [Gläser et al., Table 2, accepted manuscript, p. 12](https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf#page=12), DOI [10.1016/j.pss.2017.07.006](https://doi.org/10.1016/j.pss.2017.07.006). Its period is 2017–2037. Our largest difference in any-Sun fraction at these coordinates is 2.72 percentage points. Differences in period, DEM release, spatial interpolation, finite ray sampling and solar-limb criterion remain; this is a consistency check, not an identical-period replication. Longest-night estimates can differ by tens of hours even when annual percentages agree.

The selected UI “Shackleton rim · DEM crest” is a measured crop maximum, not a NASA landing coordinate. Its annual any-Sun results are **89.58% / 91.22% at 2 / 10 m**.

An independent **10 m** comparison is available in [Saha et al. (2023), Table 1, sites 4 and 8](https://doi.org/10.1109/ACCESS.2023.3239303). At the exact published coordinates, our 2026 centre-of-Sun visibility is **87.59% vs 86.90%**, and **86.67% vs 86.18%**: differences of 0.69 and 0.49 percentage points. The paper uses a point-Sun method; disc-average and any-disc predictions are reported separately. Table 1 does not specify an unambiguous averaging interval for its compiled values, so this is a consistency check, not an identical-period replication. See [10 m comparison](shackleton-10m-comparison.csv).

Files: [all selected annual results](annual-illumination.csv), [same-coordinate Shackleton comparisons](shackleton-literature-comparison.csv), profiles and reproducible scripts. Heights and coordinates must accompany every quoted percentage.

## 3. Permanent shadow and slopes

The old heuristic PSR classification has been replaced by the published NASA LRO/LOLA **LPSR_75S_120M_201608.TIF** product, supplied as a majority-resampled 296.875 m mask. It is static across selected dates and observer heights. A temporary shadow in a LROC photograph is not necessarily permanent shadow; a PSR is not a detection of ice.

[Three-region visual comparison](terrain-psr-audit.png) shows the actual LROC image, independently shaded LOLA terrain and the published PSR overlay in the same geographic coordinates. Large dark crater-floor regions align; small areas remain limited by the 297 m derivative. This is geographic/source integration verification, not an independent physical recomputation of an 18.6-year PSR mask. [NASA source and interpretation](https://pgda.gsfc.nasa.gov/products/69).

Landing suitability cutoff **15°** and rover cutoff **20°** are **explicit scenario assumptions**, not universal NASA requirements. Slopes are computed from metric height differences and the local 33.33 m display grid, with true source resolution stated separately. This does not resolve lander footprints, boulders, small crater hazards or terrain beneath the DEM's actual sampling scale.

## 4–6. Standalone product, true terrain and labels

Vite builds a static site for GitHub Pages. Runtime science products load from `data/sites/<key>/`. Local meshes contain **481×481 vertices**, spaced 33.33 m across 16 km. The measured input spacing is 20 m in four crest crops, 80 m in the central polar map and approximately 297 m farther out; interpolation does not create new measurements. The global context uses LOLA data at approximately 2.7 km/pixel. Its terrain is measured, including outside the yellow −84° guide.

Local photographic texture: official [LROC WAC South Pole Summer Mosaic](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_ROI_SOUTH_SUMMER), **100 m/pixel**. Tile URLs and checksums are recorded in `data/lroc-tile-provenance.json`. The photograph has fixed acquisition shadows; calculated visibility uses the selected date independently. The small-scale texture is not invented. Geographic control agrees visually with LOLA, but subpixel image registration has not been certified.

G1 is the default, named “LOLA relief.” Site sources and coordinate roles are linked. The original NASAL CSS is preserved. Original “demo terrain” labels have been removed from real-data views. The hypothetical rover and descent animation remain scenarios, and are described accordingly.

Browser tests exercise terrain, landing, manual driving, comparison, window selection, CSV export, time changes and mobile display. Measured initial driving rate was about 120 FPS on the development computer. After removing repeated PSR-area work, a 4× CPU-throttled browser run averaged 64.57 FPS with a 17 ms p95 frame interval. A separate 20 s test with driving and 6 h/s timeline playback under 4× CPU throttling averaged 63.27 FPS, but the p95 frame interval was 66.7 ms: intermittent pauses remain under this combined load. See `browser-qa.json`, `ui-check.json` and `dynamic-performance.json` for results and conditions. **A separate low-end laptop has not been physically tested, so that hardware criterion remains open.**

## 7–8. Mission windows and rover

The top-five search evaluates one year with 1 h visibility samples and start times every 6 h. The chosen mission duration and Sun/Earth/short-night weights determine the score. It returns five non-overlapping stays; clicking one selects its dates. It does not optimize launch trajectories or use a lander-specific safety model.

Catalogue sites use 300 km spatial horizons. Custom points retain time-aware routes with explicitly labelled crop-limited spatial horizons (16 km square, 7.5° azimuth), while their selected-pin profiles still extend to 300 km. Their spatial maps can miss distant obstructions.

Time-dependent routes use a 31×31 grid (533 m), true node coordinates, precomputed terrain horizons at 5° azimuth, 1 h time bins and 5% energy label bins. Energy remains continuous (Wh), solar power includes Sun-distance variation, and integration steps are at most 15 min; slow charging can accumulate across waiting edges, including waiting at full charge for moving shadows. Only the earliest label per time/energy bin is retained, so the search is approximate and can miss feasible alternatives. A route follows the full time/energy state chain, including charging stops. Green/orange segments show geometric Earth visibility at arrival. Coarse paths can miss obstacles narrower than a cell and must not be used for operational driving.

Vehicle assumptions: 160 Wh battery, initial charge 80%, tracking solar panel 0.5 m² at 28% efficiency, idle 10 W, additional driving load 45 W, flat speed 0.7 km/h, slope limit 20°. The manual 6× mode is an explicit accelerated exploration control. The no-drain control remains an explicit exploration override. There is no thermal, eclipse, panel pointing limit, wheel/soil traction or radio link-budget model. Positive time scrubs integrate changing light; moving backwards resets the vehicle battery scenario.

The browser check changed the start by 48 h: the number of reachable grid cells changed from **393 to 331**. This demonstrates time dependence; it is not a universal performance result.

## 9. Candidate catalogue and mission naming

Twelve source-linked research points include representatives of all nine historical NASA 2024 candidate regions and the Connecting Ridge study points. Region names come from [NASA's 2024 release](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/); representative CLS coordinates come from [2026 study, Table A1](https://doi.org/10.1029/2025JE009434). These research coordinates are **not NASA-approved precise landing coordinates**. The approximate Malapert and Leibnitz-area pins have been replaced with sourced representative points and accurate labels; Mons Mouton is not asserted to be a literal synonym for all of Leibnitz β.

NASA's [4 November 2026 update](https://www.nasa.gov/missions/artemis/nasa-shares-plans-to-accelerate-artemis-return-to-moon/) describes Artemis III as a 2027 Earth-orbit test and Artemis IV as the 2028 lunar landing. Consequently, advertising the historical regions as “current Artemis III landing sites” would be inaccurate. The catalogue says research/historical candidates instead.

## Hackathon conformity and data origin

The implemented planner supports the central brief confirmed in the official challenge: comparing lunar locations and dates through Sun/Earth geometry relative to a terrain horizon. It adds explicit criteria, sources, visibility definitions and reproducibility.

**The complete official 2026 challenge Details and Resources tabs were inspected in the browser on 14 November 2026 after automated requests had returned HTTP 502. Core objectives are covered: custom/curated sites and comparisons, flexible dates, Sun/Earth positions relative to the horizon, visibility-duration metrics, 2D/3D views and temporal exploration. Resources recommend Quickmap, Moon Trek, JPL Horizons and the CSA Moon Exploration portal. No exclusive data whitelist is stated in those tabs; non-U.S.-Government data sources require compliance with their individual use conditions. Team/event submission forms, deadlines and required attachments have not been submitted or separately audited.** This is an open submission gate; no blanket “all rules satisfied” claim is made.

Scientific sources are NASA/JPL NAIF, NASA LOLA/PGDA, NASA SVS and LROC; journal papers provide comparison values and research coordinates. The runtime elevation, ephemeris, PSR and global colour arrays were **rebuilt directly from authoritative NASA/JPL archives** in a successful GitHub Actions run, then tested against fresh JPL tables and a real browser CSV export. Official URLs, complete-download hashes and extracted COG-window hashes are in `data/direct-source-audit.json`. Local LROC imagery was downloaded directly from the official service. Earlier development used an attributed scientific mirror; its runtime arrays have been replaced. No application code from the data mirror is used. The original interface is the user-specified NASAL PR. [Detailed provenance](../data/PROVENANCE.md).

Remaining submission gates: team/event-specific project-submission checks; physical low-end laptop testing; physical mission/vehicle validation beyond this educational model. The 10 m Shackleton publication consistency check and direct NASA runtime-data rebuild are complete.
