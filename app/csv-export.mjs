// CSV schema and formatting extracted from the team prototype. Existing numeric fields are unchanged.
export function buildCSV(app, resolution) {
  const s = app.state,
    ser = app.series(),
    met = app.metrics(ser),
    f = (x, d) => x.toFixed(d);
  const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
  const rows = [
    "time_utc,site,lat_deg,lon_deg_east,sun_az_deg,sun_el_deg,sun_horizon_deg,sun_disk_visible_frac,earth_az_deg,earth_el_deg,earth_horizon_deg,earth_disk_visible_frac,earth_dist_km,horizon_model,terrain_resolution_m",
  ];
  for (const site of s.sites) {
    const o = ser.sites[site.id];
    for (let i = 0; i < ser.n; i++) {
      rows.push(
        [
          iso(ser.times[i]),
          '"' + site.name.replace(/"/g, '""') + '"',
          f(site.lat, 4),
          f(site.lon, 4),
          f(o.sAz[i], 3),
          f(o.sEl[i], 3),
          f(o.sH[i], 3),
          f(o.sF[i], 3),
          f(o.eAz[i], 3),
          f(o.eEl[i], 3),
          f(o.eH[i], 3),
          f(o.eF[i], 3),
          f(o.eDist[i], 0),
          s.model,
          resolution(site),
        ].join(","),
      );
    }
  }
  const sum = [
    "site,lat_deg,lon_deg_east,period_start_utc,period_end_utc,step_h,visibility_rule,horizon_model,sun_frac,earth_frac,both_frac,longest_dark_h,longest_earth_blackout_h,score,rank,w_sun,w_earth,w_gap,terrain_resolution_m",
  ];
  for (const site of s.sites) {
    const m = met.res[site.id];
    sum.push(
      [
        '"' + site.name.replace(/"/g, '""') + '"',
        f(site.lat, 4),
        f(site.lon, 4),
        iso(ser.times[0]),
        iso(ser.times[ser.n - 1]),
        ser.stepH,
        s.visDef,
        s.model,
        f(m.sun, 4),
        f(m.ear, 4),
        f(m.both, 4),
        f(m.dark, 1),
        f(m.nocomm, 1),
        f(m.score, 4),
        m.rank,
        s.wSun,
        s.wEarth,
        s.wGap,
        resolution(site),
      ].join(","),
    );
  }
  return { rows, sum, ser, met };
}
