# Data opportunities — assessment, not implemented features

Dark Vector · assessed 15 November 2026. S/M/L are implementation estimates, not data quality grades. Additional data sizes below are engineering estimates for selected local crops; actual product sizes and coverage must be checked before shipping. None of these proposals changes the current science outputs.

## 1. Earth eclipsing the Sun

**Benefit:** warn that solar charging can stop even when the Sun is above the terrain skyline. **Source:** the existing JPL-derived Sun/Earth vectors and distances, evaluated at the observer, permit angular separation and apparent disc overlap. **Complexity:** M. **Accuracy risk:** hourly sampling can miss contact times; the solid-Earth disc omits atmospheric extinction/refraction and the shape of the penumbra. Validate contact times against an independent ephemeris/eclipse calculation. Do not call the result a calibrated irradiance forecast. **New data:** no large new raster; finer time samples or an independent event table may be needed. This is an inference from the stored geometry, not a feature already validated or included in rover energy.

## 2. Earth phase

**Benefit:** show a geometric illuminated fraction and explain why Earth does not always look full. **Source:** existing observer–Earth and Earth–Sun geometry from the JPL vector table. **Complexity:** S. **Accuracy risk:** illuminated fraction is not brightness: clouds, ocean glint, atmosphere and surface reflectance matter. Label a simple rendered globe as illustrative; do not turn phase into a radio or photovoltaic performance claim. **New data:** none for phase; a measured Earth appearance texture would be a separate sourced asset.

## 3. Libration near the skyline

**Benefit:** an animated Earth track makes long gaps in Earth visibility understandable. **Source:** the existing Moon-fixed Earth directions, topocentric correction and measured terrain horizons. **Complexity:** S. **Accuracy risk:** explain longitudinal/latitudinal motion separately from the terrain obstruction and observer position; centre visibility differs from partial-disc visibility. Keep the current selected visibility definition. **New data:** none. This would reuse existing results rather than add a new physical model.

The geometry proposals above build on the project's existing documented SPICE inputs. See [NAIF's guidance on using SPICE data](https://naif.jpl.nasa.gov/naif/using_spice_data.html).

## 4. Orbiter passes and possible relays

**Benefit:** display geometric spacecraft passes during direct-to-Earth outages. **Source:** mission SPK, lunar orientation, clock/frame kernels and archived metadata from [NAIF PDS archives](https://naif.jpl.nasa.gov/naif/data_pds_archived.html); consult [kernel availability](https://naif.jpl.nasa.gov/naif/kernelsavailability.html). **Complexity:** L. **Accuracy risk:** archived coverage ends before the present and is not a prediction for arbitrary future missions. A visible LRO pass does not establish a usable relay: payload, pointing, scheduling, radio bands and link budget require independent mission information. **New data:** yes, mission kernels and possibly validated prediction products; estimate tens to hundreds of MB offline, with a much smaller derived pass table in the browser. Check each kernel's actual time bounds. NASA/JPL distribution is public; preserve attribution and the [NAIF rules](https://naif.jpl.nasa.gov/naif/rules.html) and toolkit license when distributing software. Do not assume those terms license unrelated services.

## 5. Surface temperature

**Benefit:** a temperature context layer highlights thermal extremes and candidate cold traps. **Source:** [LRO Diviner calibrated and derived archives](https://pds-geosciences.wustl.edu/missions/lro/diviner.htm), including product labels describing units and acquisition/aggregation. **Complexity:** M for an observed/context layer; L for predicting equipment temperatures. **Accuracy risk:** a gridded observation or extrema map is not temperature at the selected future hour. Different footprints, illumination, local time and no-data coverage must remain explicit. Surface temperature is not battery or spacecraft temperature. **New data:** yes; selected local products, estimated 1–20 MB per compact browser layer. Validate reprojection and timestamps before integrating with mission time.

## 6. Hydrogen and ice-related indicators

**Benefit:** compare resource-related evidence with illumination and access, without presenting a certainty map. **Sources:** [LEND neutron products](https://pds-geosciences.wustl.edu/missions/lro/lend.htm), [LAMP gridded far-UV products](https://pds.nasa.gov/ds-view/pds/viewProfile.jsp?dsid=LRO-L-LAMP-5-GDR-V1.0), and [Mini-RF radar products](https://pds-geosciences.wustl.edu/missions/lro/mrf.htm). **Complexity:** L. **Accuracy risk:** the instruments measure different quantities at different depths/scales; hydrogen, UV reflectance and radar scattering are not interchangeable and are not proof of extractable water ice. Roughness, composition and observing geometry can affect interpretation. Display separate measured indicators with uncertainty and literature attribution; do not create an unsupported combined “ice probability”. **New data:** yes, several aligned products; estimated 10–100 MB offline and optional reduced crops for the client. Preserve each native footprint and missing-data mask.

## 7. LROC NAC image crops

**Benefit:** inspect visible hazards and surface appearance at a chosen location. **Source:** calibrated/map-projected NAC observations in the LROC/PDS archive; use the [official NAC processing guide](https://lroc.im-ldi.com/data/support/downloads/LROC_NAC_Processing_Guide.pdf). NAC pixel scale varies with observation; it is not uniformly 0.5 m everywhere. **Complexity:** M for one verified crop; L for seamless streaming coverage. **Accuracy risk:** shadows are baked into an image acquired at a different time. Geolocation, projection, camera geometry and co-registration against LOLA must be checked. An image pixel size does not upgrade DEM accuracy. **New data:** yes; estimate 5–50 MB compressed for selected multi-resolution crops, far more for raw full frames. Show acquisition UTC, product ID, scale and footprint. Prefer this to generated “realistic” textures.

## 8. Moon Trek / QuickMap tiles

**Benefit:** progressively load detail while zooming, instead of one large texture. **Source:** [NASA Trek's documented RESTful WMTS services](https://trek.nasa.gov/tiles/apidoc/trekAPI.html). GetCapabilities supplies tile matrix, projection, format and extent; missing tiles can mean no coverage. **Complexity:** M–L for a polar 3D client with caching and offline fallbacks. **Accuracy risk:** a tile is a display derivative; resolve the underlying product, datum, projection and resampling before using it analytically. **New data:** yes, streamed/cache-controlled images; transfer depends on zoom and viewport. Tile availability does not by itself establish redistribution or bulk caching permission. Check layer credits and service terms. QuickMap API/WMTS access and redistribution terms were **not verified** in this assessment: treat it as a viewer/reference until its operator supplies an applicable documented interface and permission. No dependency on an undocumented endpoint is recommended.

## 9. LOLA slope and roughness products

**Benefit:** add context at documented spatial baselines and compare with our conservative route-cell slopes. **Source:** [PDS LOLA archive and documentation](https://pds-geosciences.wustl.edu/missions/lro/lola.htm), with additional product definitions in the [LRO archive plan](https://pds-geosciences.wustl.edu/missions/lro/docs/LROarchive.pdf). **Complexity:** M. **Accuracy risk:** roughness and slope are scale dependent. A product computed at one baseline cannot silently replace a 533 m conservative cell bound or certify metre-scale landing safety. Check units, baseline, projection, valid-data mask and vertical reference. **New data:** yes, selected products/crops, estimated 1–20 MB per layer. Add a comparison first; changing the route or landing model requires a separate scientific review and new regression baselines.

## Suggested priorities

1. **Geometric eclipse warnings:** direct value for energy planning, using existing vectors. Add only after independent timing validation; keep atmospheric uncertainty explicit.
2. **Earth phase + libration explanation:** low data cost and understandable visual value. Reuse existing geometry, with phase explicitly separated from brightness and communications.
3. **One carefully registered NAC inspection crop:** strong practical value for a shortlisted location. Start with verified coverage and acquisition metadata; keep imagery separate from current terrain precision. A Diviner context layer is a good alternative if the presentation emphasises thermal conditions.

These are proposals only. No relay availability, eclipse-aware battery model, thermal prediction, new ice inference or NAC hazard certification is claimed by this release.
