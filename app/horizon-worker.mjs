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
// ---- Roaming windows (Drive) -------------------------------------------------
// A window is another crop of the same measured rasters on the selected site's
// local stereographic grid, offset by (ox, oy) km. Nodes that overlap the window
// the rover is leaving are copied, so heights and horizons stay bit-identical there.
let psrMask;
function sampleAt(ux, uy, uz) {
  const x = (2 * R_M * uy) / (1 - uz),
    y = (2 * R_M * ux) / (1 - uz);
  let h, res = 2700;
  for (let i = maps.length - 1; i >= 1; i--) {
    const a = maps[i];
    if (Math.abs(x) < a.extent - a.cell && Math.abs(y) < a.extent - a.cell) {
      h = bil(
        a,
        ((x + a.extent) / (2 * a.extent)) * a.w - 0.5,
        ((a.extent - y) / (2 * a.extent)) * a.h - 0.5,
      );
      res = a.cell;
      break;
    }
  }
  if (h === undefined) {
    const a = maps[0],
      lon = Math.atan2(uy, ux) / RAD,
      lat = Math.asin(clamp(uz, -1, 1)) / RAD;
    h = bil(
      a,
      (((lon + 540) % 360) / 360) * a.w - 0.5,
      ((90 - lat) / 180) * a.h - 0.5,
    );
  }
  for (const p of patches) {
    const d = ux * p.u[0] + uy * p.u[1] + uz * p.u[2];
    if (d < 0.99996) continue;
    const xx = (2 * R_M * (ux * p.e[0] + uy * p.e[1] + uz * p.e[2])) / (1 + d),
      yy = (2 * R_M * (ux * p.n[0] + uy * p.n[1] + uz * p.n[2])) / (1 + d);
    if (
      Math.abs(xx) < p.extent - p.pixel_m &&
      Math.abs(yy) < p.extent - p.pixel_m
    ) {
      h = bil(
        p,
        (xx + p.extent) / p.pixel_m - 0.5,
        (p.extent - yy) / p.pixel_m - 0.5,
      );
      res = p.pixel_m;
    }
  }
  sampleAt.res = res;
  return h;
}
// Same rays as horizon() above (identical distances and angles), without per-sample allocations.
function horizonInto(out, offset, f, ground, height, bins) {
  const [ux, uy, uz] = f.up,
    eye = R_M + ground + height;
  for (let b = 0; b < bins; b++) {
    const az = (b / bins) * 2 * Math.PI,
      sa = Math.sin(az),
      ca = Math.cos(az),
      dx = f.east[0] * sa + f.north[0] * ca,
      dy = f.east[1] * sa + f.north[1] * ca,
      dz = f.east[2] * sa + f.north[2] * ca;
    let peak = -90;
    for (const d of distances) {
      const r =
          R_M + sampleAt(ux * d.c + dx * d.s, uy * d.c + dy * d.s, uz * d.c + dz * d.s),
        angle = Math.atan2(r * d.c - eye, r * d.s) / RAD;
      if (angle > peak) peak = angle;
    }
    out[offset + b] = peak;
  }
}
function buildWindow(q) {
  const { N, L, cell, Nc, B, height } = q,
    f = enu(q.site.lat, q.site.lon),
    h = new Float32Array(N * N),
    slope = new Float32Array(N * N),
    psr = psrMask ? new Uint8Array(N * N) : null,
    atlas = new Float32Array(Nc * Nc * B),
    stride = (N - 1) / (Nc - 1),
    reuse = q.reuse,
    unit = [0, 0, 0];
  const direction = (i, j) => {
    const xx = (q.ox - L / 2 + i * cell) * 1000,
      yy = (q.oy - L / 2 + j * cell) * 1000,
      v = (xx * xx + yy * yy) / (4 * R_M * R_M),
      a = 1 / (1 + v);
    for (let k = 0; k < 3; k++)
      unit[k] =
        (f.up[k] * (1 - v) + (f.east[k] * xx) / R_M + (f.north[k] * yy) / R_M) *
        a;
    return unit;
  };
  let min = Infinity,
    max = -Infinity,
    coarsest = 0,
    psrCovered = !!psr;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i,
        oi = i + (reuse ? reuse.di : 0),
        oj = j + (reuse ? reuse.dj : 0),
        inside = reuse && oi >= 0 && oj >= 0 && oi < N && oj < N;
      let z;
      if (inside) z = reuse.h[oj * N + oi];
      else {
        const u = direction(i, j);
        z = (sampleAt(u[0], u[1], u[2]) - q.centerHeightM) / 1000;
        if (sampleAt.res > coarsest) coarsest = sampleAt.res;
      }
      h[k] = z;
      if (z < min) min = z;
      if (z > max) max = z;
      if (psr) {
        if (inside && reuse.psr) psr[k] = reuse.psr[oj * N + oi];
        else {
          const u = inside ? direction(i, j) : unit,
            x = (2 * R_M * u[1]) / (1 - u[2]),
            y = (2 * R_M * u[0]) / (1 - u[2]),
            c = Math.floor((x + 304000) / 296.875),
            r = Math.floor((304000 - y) / 296.875);
          if (c >= 0 && c < psrMask.w && r >= 0 && r < psrMask.h)
            psr[k] = psrMask.data[r * psrMask.w + c];
          else psrCovered = false;
        }
      }
    }
  // Same finite differences as the display slope map (component terrLib().slopes).
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const il = Math.max(0, i - 1),
        ir = Math.min(N - 1, i + 1),
        jd = Math.max(0, j - 1),
        ju = Math.min(N - 1, j + 1),
        gx = (h[j * N + ir] - h[j * N + il]) / ((ir - il) * cell),
        gy = (h[ju * N + i] - h[jd * N + i]) / ((ju - jd) * cell);
      slope[j * N + i] = Math.atan(Math.hypot(gx, gy)) / RAD;
    }
  let traced = 0;
  for (let y = 0; y < Nc; y++)
    for (let x = 0; x < Nc; x++) {
      const ax = x + (reuse ? reuse.ai : 0),
        ay = y + (reuse ? reuse.aj : 0),
        target = (y * Nc + x) * B;
      if (reuse?.atlas && ax >= 0 && ay >= 0 && ax < Nc && ay < Nc) {
        atlas.set(
          reuse.atlas.subarray((ay * Nc + ax) * B, (ay * Nc + ax + 1) * B),
          target,
        );
        continue;
      }
      const i = Math.round(x * stride),
        j = Math.round(y * stride),
        u = direction(i, j),
        frame = enu(
          Math.asin(clamp(u[2], -1, 1)) / RAD,
          Math.atan2(u[1], u[0]) / RAD,
        );
      horizonInto(
        atlas,
        target,
        frame,
        q.centerHeightM + h[j * N + i] * 1000,
        height,
        B,
      );
      traced++;
    }
  return {
    h,
    slope,
    psr: psrCovered ? psr : null,
    atlas,
    min,
    max,
    traced,
    // 0: every node was copied from the previous window.
    coarsestSourceM: coarsest,
  };
}
onmessage = ({ data: q }) => {
  try {
    if (q.type === "init") {
      maps = q.maps;
      patches = q.patches;
      return;
    }
    if (q.type === "psr") {
      psrMask = q.mask;
      return;
    }
    if (q.type === "window") {
      const w = buildWindow(q);
      postMessage({ type: "window", job: q.job, ...w }, [
        w.h.buffer,
        w.slope.buffer,
        w.atlas.buffer,
        ...(w.psr ? [w.psr.buffer] : []),
      ]);
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
