import { fetchBytes, fetchJSON, fetchImage } from "./data-loader.mjs";
// Real elevation adapter; body-fixed XYZ, radius=1 in the original overview renderer.
const R = 1737400,
  D = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
function basis(lat, lon) {
  const p = lat * D,
    l = lon * D;
  return {
    u: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
    e: [-Math.sin(l), Math.cos(l), 0],
    n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
  };
}
async function raster(file, options = {}) {
  const bitmap = await createImageBitmap(
    new Blob([await fetchBytes("data/" + file)]),
    { colorSpaceConversion: "none" },
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    h = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < h.length; i++)
    h[i] =
      (a[i * 4] * 256 + a[i * 4 + 1]) * (options.scale ?? 0.5) +
      (options.offset ?? -10000);
  bitmap.close();
  return { w: canvas.width, h: canvas.height, data: h, ...options };
}
function bil(a, c, r) {
  c = a.wrap ? ((c % a.w) + a.w) % a.w : clamp(c, 0, a.w - 1);
  r = clamp(r, 0, a.h - 1);
  const i = Math.floor(c),
    j = Math.floor(r),
    i1 = a.wrap ? (i + 1) % a.w : Math.min(i + 1, a.w - 1),
    j1 = Math.min(j + 1, a.h - 1),
    u = c - i,
    v = r - j;
  return (
    (a.data[j * a.w + i] * (1 - u) + a.data[j * a.w + i1] * u) * (1 - v) +
    (a.data[j1 * a.w + i] * (1 - u) + a.data[j1 * a.w + i1] * u) * v
  );
}
export async function loadRealMoon(onProgress = () => {}) {
  onProgress("Loading LOLA elevation maps…");
  const maps = await Promise.all([
    raster("overview/global.png", { wrap: true }),
    raster("overview/polar.png", { extent: 304000, cell: 1187.5 }),
  ]);
  const patches = [];
  let albedo = await fetchImage("data/overview/color.jpg");
  let localReady = false,
    localPending;
  async function ensureLocal() {
    if (localReady) return;
    if (localPending) return localPending;
    localPending = (async () => {
      const [global, polar, fine, pm] = await Promise.all([
        raster("moon_dem_4k.png", { wrap: true }),
        raster("sp_dem_L0.png", { extent: 304000, cell: 296.875 }),
        raster("sp_dem_L1.png", { extent: 163840, cell: 80 }),
        fetchJSON("data/patches.json"),
      ]);
      const crops = await Promise.all(
        pm.patches
          .filter((p) => p.kind === "crest20")
          .map(async (p) => ({
            ...(await raster(p.file, {
              scale: p.height_scale_m,
              offset: p.height_offset_m,
            })),
            ...p,
            ...basis(p.lat, p.lon),
            extent: (p.size * p.pixel_m) / 2,
          })),
      );
      maps.splice(0, maps.length, global, polar, fine);
      patches.push(...crops);
      localReady = true;
    })().catch((e) => {
      localPending = null;
      throw e;
    });
    return localPending;
  }
  function sample(lat, lon) {
    const rho = 2 * R * Math.tan(((90 + lat) * D) / 2),
      x = rho * Math.sin(lon * D),
      y = rho * Math.cos(lon * D);
    let h = null;
    for (let k = 1; k < maps.length; k++) {
      const a = maps[k];
      if (Math.abs(x) < a.extent - a.cell && Math.abs(y) < a.extent - a.cell)
        h = bil(
          a,
          ((x + a.extent) / (2 * a.extent)) * a.w - 0.5,
          ((a.extent - y) / (2 * a.extent)) * a.h - 0.5,
        );
    }
    if (h === null) {
      const a = maps[0];
      h = bil(
        a,
        (((lon + 540) % 360) / 360) * a.w - 0.5,
        ((90 - lat) / 180) * a.h - 0.5,
      );
    }
    const u = basis(lat, lon).u;
    for (const p of patches) {
      const den = 1 + dot(u, p.u),
        xx = (2 * R * dot(u, p.e)) / den,
        yy = (2 * R * dot(u, p.n)) / den;
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
  function resolution(lat, lon) {
    const u = basis(lat, lon).u;
    for (const p of patches) {
      const den = 1 + dot(u, p.u),
        x = (2 * R * dot(u, p.e)) / den,
        y = (2 * R * dot(u, p.n)) / den;
      if (
        Math.abs(x) < p.extent - p.pixel_m &&
        Math.abs(y) < p.extent - p.pixel_m
      )
        return 20;
    }
    const x = (2 * R * u[1]) / (1 - u[2]),
      y = (2 * R * u[0]) / (1 - u[2]);
    return Math.max(Math.abs(x), Math.abs(y)) < 163760
      ? 80
      : Math.max(Math.abs(x), Math.abs(y)) < 303703.125
        ? 296.875
        : 2700;
  }
  function position(lat, lon) {
    const u = basis(lat, lon).u,
      rr = 1 + sample(lat, lon) / R;
    return u.map((x) => x * rr);
  }
  function normal(lat, lon) {
    const f = basis(lat, lon),
      step = Math.max(
        maps.length < 3 ? maps[1].cell : 80,
        resolution(lat, lon),
      ),
      a = step / R;
    const hs = (dir, sign) => {
      const u = f.u.map(
        (x, j) => x * Math.cos(a) + dir[j] * Math.sin(a) * sign,
      );
      return sample(
        Math.asin(clamp(u[2], -1, 1)) / D,
        Math.atan2(u[1], u[0]) / D,
      );
    };
    const de = (hs(f.e, 1) - hs(f.e, -1)) / (2 * step),
      dn = (hs(f.n, 1) - hs(f.n, -1)) / (2 * step);
    return unit(f.u.map((x, j) => x - de * f.e[j] - dn * f.n[j]));
  }
  function localDEM(site) {
    const N = 241,
      L = 16,
      cell = L / (N - 1),
      h = new Float32Array(N * N),
      f = basis(site.lat, site.lon),
      center = sample(site.lat, site.lon);
    let min = Infinity,
      max = -Infinity;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (-L / 2 + i * cell) * 1000,
          y = (-L / 2 + j * cell) * 1000,
          q = (x * x + y * y) / (4 * R * R),
          k = 1 / (1 + q),
          u = f.u.map(
            (v, c) =>
              v * (1 - q) * k + f.e[c] * (x / R) * k + f.n[c] * (y / R) * k,
          ),
          lat = Math.asin(clamp(u[2], -1, 1)) / D,
          lon = Math.atan2(u[1], u[0]) / D;
        const z = (sample(lat, lon) - center) / 1000;
        h[j * N + i] = z;
        min = Math.min(min, z);
        max = Math.max(max, z);
      }
    return {
      N,
      L,
      cell,
      h,
      min,
      max,
      seed: 0,
      source: "NASA LRO/LOLA, measured terrain",
      centerHeightM: center,
      sourceResolutionM: resolution(site.lat, site.lon),
      lat: site.lat,
      lon: site.lon,
    };
  }
  onProgress("Building real lunar geometry…");
  await new Promise((r) => setTimeout(r, 20));
  const meshes = [];
  function meshGrid(cols, rows, coords, valid = () => true) {
    const pos = new Float32Array((cols + 1) * (rows + 1) * 3),
      nrm = new Float32Array(pos.length),
      idx = [];
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const p = coords(i, j),
          k = (j * (cols + 1) + i) * 3;
        pos.set(position(p.lat, p.lon), k);
        nrm.set(normal(p.lat, p.lon), k);
      }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (!valid(i, j)) continue;
        const a = j * (cols + 1) + i,
          b = a + cols + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    meshes.push({ pos, nrm, idx: new Uint16Array(idx) });
  }
  async function buildMeshes(detail = false) {
    meshes.length = 0;
    const columns = detail ? 256 : 128,
      rows = detail ? 128 : 64;
    meshGrid(columns, rows, (i, j) => ({
      lat: -80 + (j / rows) * 170,
      lon: (i / columns) * 360,
    }));
    // Native projected cap with 16-bit strips: no Uint32 extension dependency.
    const size = detail ? 512 : 256,
      extent = 2 * R * Math.tan(5 * D);
    for (let row = 0; row < size; row += 32) {
      meshGrid(
        size,
        32,
        (i, j) => {
          const x = -extent + (i / size) * 2 * extent,
            y = -extent + ((row + j) / size) * 2 * extent;
          return {
            lat: -90 + (2 * Math.atan(Math.hypot(x, y) / (2 * R))) / D,
            lon: Math.atan2(x, y) / D,
          };
        },
        (i, j) =>
          Math.hypot(
            -extent + ((i + 0.5) / size) * 2 * extent,
            -extent + ((row + j + 0.5) / size) * 2 * extent,
          ) < extent,
      );
      if (row % 128 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  await buildMeshes();
  const overviewHeights = await Promise.all(
    ["overview/global.png", "overview/polar.png"].map((file) =>
      fetchImage("data/" + file),
    ),
  );
  const heightImages = [
    overviewHeights[0],
    overviewHeights[1],
    overviewHeights[1],
  ];
  const fragmentShader = new TextDecoder().decode(
    await fetchBytes("app/moon.frag.glsl"),
  );
  let detailReady = false,
    detailPending;
  async function ensureDetail() {
    if (detailReady) return;
    if (detailPending) return detailPending;
    detailPending = (async () => {
      await ensureLocal();
      const [images, color] = await Promise.all([
        Promise.all(
          ["moon_dem_4k.png", "sp_dem_L0.png", "sp_dem_L1.png"].map((file) =>
            fetchImage("data/" + file),
          ),
        ),
        fetchImage("data/moon_color_4k.jpg"),
      ]);
      await buildMeshes(true);
      heightImages.splice(0, heightImages.length, ...images);
      albedo = color;
      detailReady = true;
    })().catch((e) => {
      detailPending = null;
      throw e;
    });
    return detailPending;
  }
  return {
    ensureDetail,
    get detailReady() {
      return detailReady;
    },
    ensureLocal,
    get localReady() {
      return localReady;
    },
    R,
    maps,
    patches,
    get albedo() {
      return albedo;
    },
    heightImages,
    fragmentShader,
    sample,
    position,
    normal,
    localDEM,
    resolution,
    meshes,
    provenance: "data/PROVENANCE.md",
    source:
      "NASA LRO/LOLA, direct-source derivatives; overview is progressively sampled",
  };
}
