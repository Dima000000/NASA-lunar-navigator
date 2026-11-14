# Data provenance — 14 November 2026

Interface baseline: [NASAL PR #1](https://github.com/gleb31415/NASAL/pull/1), commit f0732335864ab7c93a63a95542f48bda4a3d43b6. Original CSS retained. See [scientific review](../research/SCIENCE_REVIEW.md).

| Input | Authoritative origin | Processing and delivery |
|---|---|---|
| sp_dem_L0 / L1 | NASA LOLA LDEM_80S_80MPP_ADJ.TIF, [PGDA 90](https://pgda.gsfc.nasa.gov/products/90) | Mirror derivative: 296.875 m average and 80 m central crop; sp_meta.json records bounds. |
| Four crest/rim PNGs | NASA LOLA LDEM_80S_20MPP_ADJ.TIF, PGDA 90 | Mirror 20 m local crops; centre, scale, offset and orientation in patches.json. Not separate 5 m site products. |
| moon_dem_4k | NASA SVS LOLA ldem_16.tif, [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) | Mirror 4096×2048 derivative, 8 m vertical quantization, about 2.7 km/pixel. |
| moon_color_4k | NASA SVS / Ernie Wright, LROC WAC colour with polar LOLA albedo fill | Mirror visualization derivative. Polar fill is not detailed polar photography. |
| psr.png | NASA LOLA LPSR_75S_120M_201608.TIF, [PGDA 69](https://pgda.gsfc.nasa.gov/products/69) | Mirror majority mask at 296.875 m from native 120 m. Not an ice map; layers.json supplies interpretation. |
| ephem.bin | [NASA JPL NAIF kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) | Mirror hourly SPICE DE440 MOON_ME LT+S vectors, 2024–2036. Kernels/format in ephem.json. Independently checked against fresh JPL observer tables. |
| sites/*/lroc-wac.png | Official [LROC WAC South Pole Summer Mosaic](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_ROI_SOUTH_SUMMER), 100 m/pixel | Downloaded directly from official LROC tile service, reprojected locally. Tile URLs/hashes in lroc-tile-provenance.json. Acquisition shadows are fixed. |

Public scientific mirror: [daniel27-space/lunar-navigator](https://github.com/daniel27-space/lunar-navigator); source blob identifiers in mirror-source-tree.json. Its encoded data were a delivery route when direct NASA archive downloads failed locally. This is **not a fresh complete rebuild of NASA original archives**. No application code from that mirror is used. Credit original science teams and the mirror's derivative processing on redistribution. No project-wide software licence is inferred for unrelated upstream material.

Coordinates: sphere R=1,737,400 m, planetocentric latitude, east-positive longitude. Polar stereographic x=2R tan((90°+lat)/2) sin(lon), y=2R tan((90°+lat)/2) cos(lon). Local grids are site-centred east/north stereographic. Preparation heights are metres; display heights are relative to site centre in kilometres. Global radius is 1+h/R, with no invented crater geometry.

The 481² grid spacing is 33.33 m, which adds no measurements beyond the source. Selected-site horizon profiles use 0.5° azimuth samples and finite rays to 300 km. Spatial routing atlases use 533 m / 5° sampling and may miss narrow obstacles.

Sources and coordinate roles are in catalog.json and each site's meta.json. Research points are not NASA-approved landing points; the Shackleton DEM crest is a crop maximum. Published PSRs, geometric visibility, hypothetical power and vehicle energy are different quantities. Descent is an animation. Landing and rover limits are explicit scenario assumptions.

Credits: NASA/GSFC LOLA team and collaborators, NASA SVS / Ernie Wright, LROC team / Speyerer et al., NASA/JPL, cited publications, and data-mirror processing. No NASA endorsement. The official challenge Details and Resources tabs were checked in the browser. They recommend LRO imagery/topography and JPL Horizons and do not state an exclusive data whitelist; third-party use conditions still apply. Team/event-specific submission requirements remain separate.
