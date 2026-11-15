import { enu, R_M, RAD, clamp } from "./science-core.mjs";
let maps, patches;
function bil(a, c, r) {
  c = a.wrap ? ((c % a.w) + a.w) % a.w : clamp(c, 0, a.w - 1);
  r = clamp(r, 0, a.h - 1);
  const i = Math.floor(c),
    j = Math.floor(r),
    u = c - i,
    v = r - j,
    i1 = a.wrap ? (i + 1) % a.w : Math.min(i + 1, a.w - 1),
    j1 = Math.min(j + 1, a.h - 1);
  return (
    (a.data[j * a.w + i] * (1 - u) + a.data[j * a.w + i1] * u) * (1 - v) +
    (a.data[j1 * a.w + i] * (1 - u) + a.data[j1 * a.w + i1] * u) * v
  );
}
function sample(u) {
  const x = (2 * R_M * u[1]) / (1 - u[2]),
    y = (2 * R_M * u[0]) / (1 - u[2]);
  let h;
  for (let i = 1; i < maps.length; i++) {
    const a = maps[i];
    if (Math.abs(x) < a.extent - a.cell && Math.abs(y) < a.extent - a.cell)
      h = bil(
        a,
        ((x + a.extent) / (2 * a.extent)) * a.w - 0.5,
        ((a.extent - y) / (2 * a.extent)) * a.h - 0.5,
      );
  }
  if (h === undefined) {
    const a = maps[0],
      lon = Math.atan2(u[1], u[0]) / RAD,
      lat = Math.asin(clamp(u[2], -1, 1)) / RAD;
    h = bil(
      a,
      (((lon + 540) % 360) / 360) * a.w - 0.5,
      ((90 - lat) / 180) * a.h - 0.5,
    );
  }
  for (const p of patches) {
    const d = u[0] * p.u[0] + u[1] * p.u[1] + u[2] * p.u[2];
    if (d < 0.99996) continue;
    const xx =
        (2 * R_M * (u[0] * p.e[0] + u[1] * p.e[1] + u[2] * p.e[2])) / (1 + d),
      yy =
        (2 * R_M * (u[0] * p.n[0] + u[1] * p.n[1] + u[2] * p.n[2])) / (1 + d);
    if (
      Math.abs(xx) < p.extent - p.pixel_m &&
      Math.abs(yy) < p.extent - p.pixel_m
    )
      h = bil(
        p,
        (xx + p.extent) / p.pixel_m - 0.5,
        (p.extent - yy) / p.pixel_m - 0.5,
      );
  }
  return h;
}
const distances = Array.from({ length: 230 }, (_, i) => {
  const d = i < 50 ? 20 + i * 20 : 1000 * Math.pow(300, (i - 50) / 179);
  return { c: Math.cos(d / R_M), s: Math.sin(d / R_M) };
});
function horizon(f, ground, height, bins) {
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const az = (b / bins) * 2 * Math.PI,
      sa = Math.sin(az),
      ca = Math.cos(az),
      dir = f.east.map((z, k) => z * sa + f.north[k] * ca);
    let peak = -90;
    for (const d of distances) {
      const u = f.up.map((z, k) => z * d.c + dir[k] * d.s),
        r = R_M + sample(u),
        angle = Math.atan2(r * d.c - (R_M + ground + height), r * d.s) / RAD;
      peak = Math.max(peak, angle);
    }
    out[b] = peak;
  }
  return out;
}
onmessage = ({ data: q }) => {
  try {
    if (q.type === "init") {
      maps = q.maps;
      patches = q.patches;
      return;
    }
    if (q.type !== "horizon") return;
    const { dem, site, height } = q,
      Nc = 31,
      B = 72,
      stride = (dem.N - 1) / (Nc - 1),
      atlas = new Float32Array(Nc * Nc * B),
      f = enu(site.lat, site.lon);
    for (let y = 0; y < Nc; y++) {
      for (let x = 0; x < Nc; x++) {
        const i = x * stride,
          j = y * stride,
          xx = (-dem.L / 2 + i * dem.cell) * 1000,
          yy = (-dem.L / 2 + j * dem.cell) * 1000,
          v = (xx * xx + yy * yy) / (4 * R_M * R_M),
          a = 1 / (1 + v),
          u = f.up.map(
            (z, k) =>
              (z * (1 - v) + (f.east[k] * xx) / R_M + (f.north[k] * yy) / R_M) *
              a,
          ),
          frame = enu(
            Math.asin(clamp(u[2], -1, 1)) / RAD,
            Math.atan2(u[1], u[0]) / RAD,
          ),
          ground = dem.centerHeightM + dem.h[j * dem.N + i] * 1000;
        atlas.set(horizon(frame, ground, height, B), (y * Nc + x) * B);
      }
      postMessage({ type: "progress", job: q.job, fraction: (y + 1) / Nc });
    }
    const profile = horizon(f, dem.centerHeightM, height, 720);
    postMessage(
      {
        type: "horizon",
        job: q.job,
        atlas,
        profile,
        meta: {
          atlas: {
            N: Nc,
            azimuth_bins: B,
            heights_m: [height],
            ray_extent_m: 300000,
          },
        },
      },
      [atlas.buffer, profile.buffer],
    );
  } catch (e) {
    postMessage({ type: "error", job: q.job, message: e.message });
  }
};
