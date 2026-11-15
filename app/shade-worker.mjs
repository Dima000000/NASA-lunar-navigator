import { enu, dot, R_M, RAD, clamp, discFraction } from "./science-core.mjs";
let grid;
onmessage = ({ data: q }) => {
  try {
    if (q.type === "init") {
      grid = q;
      grid.nodes = [];
      const f = enu(q.lat, q.lon);
      for (let y = 0; y < q.Nc; y++)
        for (let x = 0; x < q.Nc; x++) {
          const i = x * q.stride,
            j = y * q.stride,
            xx = ((q.ox || 0) - q.L / 2 + i * q.cell) * 1000,
            yy = ((q.oy || 0) - q.L / 2 + j * q.cell) * 1000,
            v = (xx * xx + yy * yy) / (4 * R_M * R_M),
            a = 1 / (1 + v),
            u = f.up.map(
              (z, c) =>
                (z * (1 - v) +
                  (f.east[c] * xx) / R_M +
                  (f.north[c] * yy) / R_M) *
                a,
            );
          grid.nodes.push({
            f: enu(
              Math.asin(clamp(u[2], -1, 1)) / RAD,
              Math.atan2(u[1], u[0]) / RAD,
            ),
            ground: q.centerHeightM + q.h[j * q.N + i] * 1000,
          });
        }
      return;
    }
    if (q.type !== "shade" || !grid || grid.key !== q.key) return;
    const g = grid,
      coarse = new Float32Array(g.Nc * g.Nc);
    for (let k = 0; k < coarse.length; k++) {
      const { f, ground } = g.nodes[k],
        r = (R_M + ground + g.height) / 1000,
        v = q.sun.map((z, c) => z - r * f.up[c]),
        distance = Math.hypot(...v),
        az = (Math.atan2(dot(v, f.east), dot(v, f.north)) / RAD + 360) % 360,
        el = Math.asin(clamp(dot(v, f.up) / distance, -1, 1)) / RAD,
        rad = Math.asin(695700 / distance) / RAD,
        pos = (az / 360) * g.B,
        b = Math.floor(pos),
        w = pos - b,
        off = k * g.B,
        h = g.hmap[off + b] * (1 - w) + g.hmap[off + ((b + 1) % g.B)] * w;
      coarse[k] = discFraction(el - h, rad);
    }
    const shade = new Float32Array(g.N * g.N);
    for (let y = 0; y < g.N; y++) {
      const fy = y / g.stride,
        yy = Math.min(g.Nc - 2, Math.floor(fy)),
        wy = fy - yy;
      for (let x = 0; x < g.N; x++) {
        const fx = x / g.stride,
          xx = Math.min(g.Nc - 2, Math.floor(fx)),
          wx = fx - xx,
          k = yy * g.Nc + xx;
        shade[y * g.N + x] =
          (coarse[k] * (1 - wx) + coarse[k + 1] * wx) * (1 - wy) +
          (coarse[k + g.Nc] * (1 - wx) + coarse[k + g.Nc + 1] * wx) * wy;
      }
    }
    const step = q.bigMap ? 1 : 2,
      M = Math.ceil((g.N - 1) / step) + 1,
      pixels = new Uint8ClampedArray(M * M * 4);
    g.hillshade ??= Float32Array.from(g.h, (_, k) => {
      const i = k % g.N,
        j = Math.floor(k / g.N),
        il = Math.max(0, i - 1),
        ir = Math.min(g.N - 1, i + 1),
        jd = Math.max(0, j - 1),
        ju = Math.min(g.N - 1, j + 1),
        gx =
          ((g.h[j * g.N + ir] - g.h[j * g.N + il]) / ((ir - il) * g.cell)) *
          2.5,
        gy =
          ((g.h[ju * g.N + i] - g.h[jd * g.N + i]) / ((ju - jd) * g.cell)) *
          2.5;
      return Math.max(0, (gx * 0.5 - gy * 0.5 + 0.707) / Math.hypot(gx, gy, 1));
    });
    for (let y = 0; y < M; y++)
      for (let x = 0; x < M; x++) {
        const k =
            Math.min(g.N - 1, y * step) * g.N + Math.min(g.N - 1, x * step),
          p = ((M - 1 - y) * M + x) * 4,
          base = 0.25 + 0.75 * g.hillshade[k];
        let r, b, c;
        if (g.psr[k]) {
          r = 40 + 50 * base;
          c = 105 + 70 * base;
          b = 220 + 35 * base;
        } else {
          const lit = 26 + 205 * base * (0.18 + 0.82 * shade[k]);
          r = c = lit;
          b = lit + 5;
          if (g.slope[k] > 20) {
            r = r * 0.45 + 201 * 0.55;
            c = c * 0.45 + 87 * 0.55;
            b = b * 0.45 + 75 * 0.55;
          }
        }
        pixels[p] = r;
        pixels[p + 1] = c;
        pixels[p + 2] = b;
        pixels[p + 3] = 255;
      }
    postMessage({ key: q.key, token: q.token, utc: q.utc, shade, pixels, M }, [
      shade.buffer,
      pixels.buffer,
    ]);
  } catch (e) {
    postMessage({ error: e.message, key: q.key });
  }
};
