# Direct NASA/JPL data provenance — 14 November 2026

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

Selected-site horizon profiles use finite rays to 300 km, 0.5° azimuth sampling. Catalogue map/route atlases use 533 m cells and 5° azimuth sampling; narrow obstacles may be missed. Custom-point spatial maps use explicitly labelled crop-limited horizons. A 15° landing and 20° rover cutoff are scenario assumptions, not NASA safety requirements. Vehicle battery/panel/load/speed and the descent animation are hypothetical; geometric Earth visibility is not a guaranteed radio link.

Coordinate roles and citations are in catalog.json and each meta.json. Research points are not NASA-approved landing points. Publications supply comparison facts, not copied article images/text. Original interface: [NASAL PR #1](https://github.com/gleb31415/NASAL/pull/1), f0732335864ab7c93a63a95542f48bda4a3d43b6; CSS retained. Font: Inter, bundled SIL OFL.

Credits: NASA/GSFC LOLA science team; NASA SVS / Ernie Wright; LROC team / Speyerer et al.; NASA/JPL NAIF and Horizons; cited research authors; original NASAL interface authors. NASA data use implies no NASA endorsement. The official challenge Details/Resources tabs have been checked; they do not state an exclusive data whitelist. Team/event submission requirements are separate. See the [scientific review](../research/SCIENCE_REVIEW.md).
