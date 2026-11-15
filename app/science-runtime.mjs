import { conservativeSlopes } from "./route-search.mjs";
import {
  Ephemeris,
  enu,
  horizonValue,
  discFraction,
  R_M,
  RAD,
  clamp,
  dot,
  VEHICLE,
  solarPower,
  batteryAfter,
} from "./science-core.mjs";
import { fetchBytes, fetchJSON, fetchImage } from "./data-loader.mjs";
import { EphemerisStore } from "./ephemeris-store.mjs";
const json = fetchJSON,
  binary = fetchBytes,
  picture = fetchImage;
function pointAt(site, xKm, yKm) {
  const f = enu(site.lat, site.lon),
    x = xKm * 1000,
    y = yKm * 1000,
    q = (x * x + y * y) / (4 * R_M * R_M),
    k = 1 / (1 + q),
    u = f.up.map(
      (v, c) =>
        (v * (1 - q) + (f.east[c] * x) / R_M + (f.north[c] * y) / R_M) * k,
    );
  return {
    lat: Math.asin(clamp(u[2], -1, 1)) / RAD,
    lon: Math.atan2(u[1], u[0]) / RAD,
  };
}
export async function loadScience(moon) {
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const [ephem, catalog, status] = await Promise.all([
    EphemerisStore.create(today, today + 30 * 86400000),
    json("data/catalog.json"),
    json("data/verification-status.json"),
  ]);
  const products = new Map(),
    profileCache = new Map(),
    terrainCache = new Map();
  await Promise.all(
    catalog.map(async (site) =>
      products.set(site.key, {
        meta: await json("data/sites/" + site.key + "/meta.json"),
        profiles: {},
      }),
    ),
  );
  const loadProfile = (key, height = 2) => {
    const p = products.get(key);
    if (!p) return Promise.resolve();
    if (p.profiles[height]) return Promise.resolve(p);
    const id = key + "|" + height;
    if (!profileCache.has(id))
      profileCache.set(
        id,
        json("data/sites/" + key + "/horizon_h" + height + ".json")
          .then((h) => {
            p.profiles[height] = h.elev_deg;
            return p;
          })
          .catch((e) => {
            profileCache.delete(id);
            throw e;
          }),
      );
    return profileCache.get(id);
  };
  const loadTerrain = (key) => {
    const p = products.get(key);
    if (!p) return Promise.resolve();
    if (p.heights) return Promise.resolve(p);
    if (!terrainCache.has(key)) {
      const base = "data/sites/" + key + "/";
      terrainCache.set(
        key,
        Promise.all([
          binary(base + "dem.f32.gz", { gzip: true }),
          binary(base + "psr.u8.gz", { gzip: true }),
          binary(base + "horizon-atlas.f32.gz", { gzip: true }),
          picture(base + "lroc-wac.jpg"),
        ])
          .then(([dem, psr, atlas, image]) => {
            Object.assign(p, {
              heights: new Float32Array(dem),
              psr: new Uint8Array(psr),
              atlas: new Float32Array(atlas),
              image,
            });
            return p;
          })
          .catch((e) => {
            terrainCache.delete(key);
            throw e;
          }),
      );
    }
    return terrainCache.get(key);
  };
  await Promise.all(catalog.slice(0, 3).map((p) => loadProfile(p.key, 2)));
  const bySite = (site) => {
    const product = products.get(site.key);
    if (
      product &&
      Math.abs(product.meta.lat - site.lat) < 1e-5 &&
      Math.abs(product.meta.lon - site.lon) < 1e-5
    )
      return product;
    return [...products.values()].find(
      (p) =>
        Math.abs(p.meta.lat - site.lat) < 1e-5 &&
        Math.abs(p.meta.lon - site.lon) < 1e-5,
    );
  };
  let sourceMask, psrImage;
  const loadMask = async () => {
    if (sourceMask) return;
    psrImage = await picture("data/psr.png");
    const c = document.createElement("canvas");
    c.width = psrImage.width;
    c.height = psrImage.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(psrImage, 0, 0);
    sourceMask = g.getImageData(0, 0, c.width, c.height).data;
  };
  let baseLocal;
  const attachMoon = (value) => {
    moon = value;
    baseLocal = moon.localDEM;
    moon.localDEM = localDEM;
  };
  const localDEM = (site) => {
    const p = bySite(site);
    if (!p) {
      const d = baseLocal(site);
      d.source =
        "Measured LOLA crop; no precomputed far horizon for this custom point";
      return d;
    }
    if (!p.heights) throw Error("Terrain is still loading for " + site.name);
    const h = Float32Array.from(p.heights, (x) => x / 1000);
    let min = Infinity,
      max = -Infinity;
    for (const x of h) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    return {
      N: p.meta.N,
      L: p.meta.L_km,
      cell: p.meta.cell_m / 1000,
      h,
      min,
      max,
      seed: 0,
      centerHeightM: p.meta.center_height_m,
      lat: site.lat,
      lon: site.lon,
      source: p.meta.source_dem,
      sourceResolutionM: p.meta.terrain_resolution_m,
      publishedPSR: p.psr,
      imagery: p.image,
      product: p,
    };
  };
  const geoFor = (dem, i, j) =>
    pointAt(
      { lat: dem.lat, lon: dem.lon },
      -dem.L / 2 + i * dem.cell,
      -dem.L / 2 + j * dem.cell,
    );
  const maskFor = (dem) => {
    if (!sourceMask) return null;
    const mask = new Uint8Array(dem.N ** 2);
    let covered = 0;
    for (let j = 0; j < dem.N; j++)
      for (let i = 0; i < dem.N; i++) {
        const p = geoFor(dem, i, j),
          rho = 2 * R_M * Math.tan(((90 + p.lat) * RAD) / 2),
          x = rho * Math.sin(p.lon * RAD),
          y = rho * Math.cos(p.lon * RAD),
          c = Math.floor((x + 304000) / 296.875),
          r = Math.floor((304000 - y) / 296.875);
        if (c >= 0 && c < psrImage.width && r >= 0 && r < psrImage.height) {
          mask[j * dem.N + i] =
            sourceMask[(r * psrImage.width + c) * 4] >= 128 ? 1 : 0;
          covered++;
        }
      }
    return covered === dem.N ** 2 ? mask : null;
  };
  const skyAt = (dem, i, j, utc, height = 2) => {
    const p = dem.product || dem.customAtlas;
    if (!p) return { sun: 0, earth: 0, unavailable: true };
    const loc = geoFor(dem, i, j),
      ground =
        dem.centerHeightM + dem.h[Math.round(j) * dem.N + Math.round(i)] * 1000,
      sky = ephem.topo(
        ephem.state(utc),
        loc.lat,
        loc.lon,
        (ground + height) / 1000,
      ),
      a = p.meta.atlas,
      N = a.N,
      B = a.azimuth_bins,
      k = a.heights_m.indexOf(height);
    const x = (i / (dem.N - 1)) * (N - 1),
      y = (j / (dem.N - 1)) * (N - 1),
      i0 = Math.min(N - 2, Math.floor(x)),
      j0 = Math.min(N - 2, Math.floor(y)),
      wi = x - i0,
      wj = y - j0;
    const hz = (az) => {
      const f = (az / 360) * B,
        b = Math.floor(f) % B,
        w = f - Math.floor(f);
      const at = (ii, jj, bb) =>
        p.atlas[((k * N + jj) * N + ii) * B + (bb % B)];
      const sample = (bb) =>
        (at(i0, j0, bb) * (1 - wi) + at(i0 + 1, j0, bb) * wi) * (1 - wj) +
        (at(i0, j0 + 1, bb) * (1 - wi) + at(i0 + 1, j0 + 1, bb) * wi) * wj;
      return sample(b) * (1 - w) + sample(b + 1) * w;
    };
    return {
      sun: discFraction(sky.sun.el - hz(sky.sun.az), sky.sun.rad),
      earth: discFraction(sky.earth.el - hz(sky.earth.az), sky.earth.rad),
      sunDirection: sky.sun,
      earthDirection: sky.earth,
    };
  };
  const custom = new Map(),
    customJobs = new Map();
  let horizonWorker,
    horizonJob = 0;
  const customKey = (site, height) => site.lat + "|" + site.lon + "|" + height;
  const prepareCustom = async (site, height) => {
    const key = customKey(site, height);
    if (custom.has(key)) return custom.get(key);
    await Promise.all([moon.ensureLocal(), loadMask()]);
    if (!horizonWorker) {
      horizonWorker = new Worker(
        new URL("./horizon-worker.mjs", import.meta.url),
        { type: "module" },
      );
      horizonWorker.postMessage({
        type: "init",
        maps: moon.maps,
        patches: moon.patches,
      });
      horizonWorker.onmessage = ({ data: m }) => {
        const job = customJobs.get(m.job);
        if (!job || m.type === "progress") return;
        customJobs.delete(m.job);
        if (m.type === "error") job.reject(Error(m.message));
        else {
          Object.assign(job.dem, {
            customAtlas: {
              atlas: m.atlas,
              meta: m.meta,
              heightReady: [job.height],
            },
            publishedPSR: maskFor(job.dem),
          });
          const result = { dem: job.dem, profile: m.profile };
          custom.set(job.key, result);
          job.resolve(result);
        }
      };
      horizonWorker.onerror = () => {
        for (const job of customJobs.values())
          job.reject(Error("Custom horizon worker failed. Please reload."));
        customJobs.clear();
      };
    }
    const dem = baseLocal(site),
      job = ++horizonJob;
    return new Promise((resolve, reject) => {
      customJobs.set(job, { resolve, reject, dem, key, height });
      horizonWorker.postMessage({ type: "horizon", job, site, height, dem });
    });
  };
  const farProfile = (site, height) => {
    const f = enu(site.lat, site.lon),
      ground = moon.sample(site.lat, site.lon),
      out = new Float32Array(720);
    for (let b = 0; b < 720; b++) {
      const az = b * 0.5 * RAD,
        dir = f.east.map(
          (v, k) => v * Math.sin(az) + f.north[k] * Math.cos(az),
        );
      let best = -90;
      for (let k = 0; k < 230; k++) {
        const d = k < 50 ? 20 + k * 20 : 1000 * Math.pow(300, (k - 50) / 179),
          a = d / R_M,
          u = f.up.map((v, c) => v * Math.cos(a) + dir[c] * Math.sin(a)),
          lat = Math.asin(clamp(u[2], -1, 1)) / RAD,
          lon = Math.atan2(u[1], u[0]) / RAD,
          h = moon.sample(lat, lon);
        best = Math.max(
          best,
          Math.atan2(
            (R_M + h) * Math.cos(a) - (R_M + ground + height),
            (R_M + h) * Math.sin(a),
          ) / RAD,
        );
      }
      out[b] = best;
    }
    return out;
  };
  const shadeGrid = (job, utc, height) => {
    const { dem, Nc, B, hmap, stride } = job;
    dem.shadeNodes ??= Array.from({ length: Nc * Nc }, (_, index) => {
      const i = index % Nc,
        j = Math.floor(index / Nc),
        ii = i * stride,
        jj = j * stride,
        p = geoFor(dem, ii, jj);
      return {
        f: enu(p.lat, p.lon),
        ground: dem.centerHeightM + dem.h[jj * dem.N + ii] * 1000,
      };
    });
    const sun = ephem.state(utc).sun,
      out = new Float32Array(Nc * Nc);
    for (let index = 0; index < out.length; index++) {
      const { f, ground } = dem.shadeNodes[index],
        r = (R_M + ground + height) / 1000,
        v = [sun[0] - r * f.up[0], sun[1] - r * f.up[1], sun[2] - r * f.up[2]],
        distance = Math.hypot(...v),
        az = (Math.atan2(dot(v, f.east), dot(v, f.north)) / RAD + 360) % 360,
        el = Math.asin(clamp(dot(v, f.up) / distance, -1, 1)) / RAD,
        rad = Math.asin(695700 / distance) / RAD,
        q = (az / 360) * B,
        b = Math.floor(q),
        w = q - b,
        offset = index * B,
        h = hmap[offset + b] * (1 - w) + hmap[offset + ((b + 1) % B)] * w;
      out[index] = discFraction(el - h, rad);
    }
    return out;
  };
  return {
    prepareCustom,
    customKey,
    custom,
    attachMoon,
    ephem,
    catalog,
    products,
    bySite,
    status,
    loadProfile,
    loadTerrain,
    loadMask,
    geoFor,
    skyAt,
    shadeGrid,
    farProfile,
    maskFor,
    vehicle: VEHICLE,
    pointAt,
  };
}
export function enhancedComponent(Base, S) {
  return class ScientificComponent extends Base {
    constructor(...args) {
      super(...args);
      this.state.model = "G1";
      this.state.stayHours = 156;
      this.state.windowYear = 2026;
      this.state.windowStatus =
        "Choose a place, then find its best five windows.";
      this.state.windowRows = [];
      this._routeJob = 0;
      this._scienceWorker = new Worker(
        new URL("./science-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this.syncWorkerYears();
      this._scienceWorker.onmessage = ({ data: m }) => {
        if(m.type==='bestProgress'&&m.job===this._bestJob){this._bestProgress=m.progress;if(performance.now()-(this._progressPaint||0)>200){this._progressPaint=performance.now();this.setState({bestStatus:'Ranking measured grid points… '+Math.round(m.progress*100)+'%'});}return;}
        if(m.type==='bestSpots'&&m.job===this._bestJob){this.setState({bestSpots:m.rows,bestStatus:'Top five spots · 533 m grid · LOLA horizon · any part of each disc visible'});return;}
        if(m.type==='trip'){this._trip=m;this.setState({});return;}
        if(m.type==='routeProgress'&&m.job===this._routeJob){this._routeExpanded=m.expanded;if(performance.now()-(this._progressPaint||0)>200){this._progressPaint=performance.now();this.setState({});}return;}
        if (m.type === "windows") {
          this.setState({
            windowRows: m.rows,
            windowStatus:
              "Top five non-overlapping stays · 6 h start grid · 1 h visibility sampling",
          });
        }
        if (m.type === "route" && m.job === this._routeJob) {
          this._routePending = false;
          this._routeResult = m;
          this._reach = null;
          this._routeToken++;
          this.setState({
            routeStatus: m.incomplete
              ? "Approximate route search reached its budget; reachable cells shown are feasible."
              : "Time + energy route ready · Pareto labels, conservative cell slopes",
          });
        }
        if (m.type === "error") {
          this._routePending = false;
          this.setState({ windowStatus: m.message, routeStatus: m.message });
        }
      };
      this._routeToken = 0;
      this._prepareToken = 0;
      this._shadeWorker = new Worker(
        new URL("./shade-worker.mjs", import.meta.url),
        { type: "module" },
      );
      this._shadeToken = 0;
      this._shadeWorker.onmessage = ({ data: m }) => {
        this._shadeBusy = false;
        if (m.error) {
          this._dataError = m.error;
          this.setState({});
          return;
        }
        if (this._tj?.key === m.key) {
          this._shadeFull = m.shade;
          this._shadeKey = m.key + "|" + m.utc;
          this._tj.mapPixels = { data: m.pixels, M: m.M, key: this._shadeKey };
          this.eng?.setShade(m.shade);
          this.drawMaps();
        }
        if (this._shadeNext) {
          const next = this._shadeNext;
          this._shadeNext = null;
          this.sendShade(next);
        }
      };
      this._shadeWorker.onerror = () => {
        this._shadeBusy = false;
        this._dataError = "Illumination worker failed. Please reload.";
        this.setState({});
      };
      this._scienceWorker.onerror = (e) => {
        this._routePending = false;
        this._dataError = "Scientific worker failed. Please reload.";
        this.setState({
          routeStatus: this._dataError,
          windowStatus: this._dataError,
        });
      };
    }
    componentDidMount() {
      super.componentDidMount();
      this._detailHandler = () => {
        if (
          !this._detailLoading &&
          !window.RealMoon.detailReady
        ) {
          this._detailLoading = true;
          this.setState({});
          window.RealMoon.ensureDetail()
            .then(() => this.eng?.refreshMoon())
            .catch((e) => {
              this._dataError = e.message;
            })
            .finally(() => {
              this._detailLoading = false;
              this.setState({});
            });
        }
      };
      this._ovEl?.addEventListener("wheel", this._detailHandler, {
        passive: true,
      });
      this._ovEl?.addEventListener("pointerdown", this._detailHandler, {
        passive: true,
      });
      this._detailFrame = requestAnimationFrame(() => {
        this._detailFrame = requestAnimationFrame(() => {
          if ("requestIdleCallback" in window)
            this._detailIdle = requestIdleCallback(this._detailHandler, { timeout: 1500 });
          else this._detailTimer = setTimeout(this._detailHandler, 300);
        });
      });
    }
    syncWorkerYears() {
      if (this._scienceWorker)
        this._scienceWorker.postMessage({
          type: "initYears",
          years: S.ephem.workerYears(),
        });
    }
    loadTask(task) {
      this._dataError = "";
      this._dataLoading = true;
      super.setState({ windowStatus: "Loading measured data…" });
      return task()
        .catch((e) => {
          this._dataError = e.message;
          super.setState({ windowStatus: e.message, routeStatus: e.message });
          throw e;
        })
        .finally(() => {
          this._dataLoading = false;
          super.setState({});
        });
    }
    setState(patch, callback) {
      if (typeof patch === "function") patch = patch(this.state);
      if (!this._scienceWorker) return super.setState(patch, callback);
      const next = { ...this.state, ...patch },
        active = next.sites || [];
      const customMissing = active.some(
        (p) => !S.bySite(p) && !S.custom.has(S.customKey(p, next.obsH || 2)),
      );
      const selected = active.find((p) => p.id === next.sel) || active[0],
        selectedProduct = selected && S.bySite(selected),
        terrainMissing =
          next.view !== "region" && selectedProduct && !selectedProduct.heights;
      const missing =
        terrainMissing ||
        customMissing ||
        !S.ephem.ready(next.start, next.end) ||
        active.some(
          (p) => S.bySite(p) && !S.bySite(p).profiles[next.obsH || 2],
        );
      if (missing) {
        const job = ++this._prepareToken || (this._prepareToken = 1);
        this.loadTask(async () => {
          await Promise.all([
            ...(terrainMissing
              ? [S.loadTerrain(selectedProduct.meta.key)]
              : []),
            ...active
              .filter((p) => !S.bySite(p))
              .map((p) => S.prepareCustom(p, next.obsH || 2)),
            S.ephem.ensureRange(next.start, next.end),
            ...active
              .filter((p) => S.bySite(p))
              .map((p) => S.loadProfile(S.bySite(p).meta.key, next.obsH || 2)),
          ]);
          this.syncWorkerYears();
          if (job === this._prepareToken) super.setState(patch, callback);
        }).catch(() => {});
        return;
      }
      return super.setState(patch, callback);
    }
    goView(view) {
      if (view === "region") return super.goView(view);
      const site = this.selSite(),
        p = S.bySite(site);
      if (p?.heights) return super.goView(view);
      this.loadTask(async () => {
        if (p) await S.loadTerrain(p.meta.key);
        else await Promise.all([window.RealMoon.ensureLocal(), S.loadMask()]);
        super.goView(view);
      }).catch(() => {});
    }
    selectSite(id) {
      const site = this.state.sites.find((p) => p.id === id),
        p = site && S.bySite(site);
      if (this.state.view === "region" || p?.heights)
        return super.selectSite(id);
      this.loadTask(async () => {
        if (p) await S.loadTerrain(p.meta.key);
        else await Promise.all([window.RealMoon.ensureLocal(), S.loadMask()]);
        super.selectSite(id);
      }).catch(() => {});
    }
    presets() {
      return S.catalog.map((p) => ({ ...p, approx: false }));
    }
    eph() {
      if (this._EPH) return this._EPH;
      const e = S.ephem;
      this._EPH = {
        state: (t) => e.state(t),
        topo: (st, lat, lon, hkm) =>
          e.topo(
            st,
            lat,
            lon,
            (S.catalog.find(
              (p) =>
                Math.abs(p.lat - lat) < 1e-7 && Math.abs(p.lon - lon) < 1e-7,
            )
              ? S.bySite(
                  S.catalog.find(
                    (p) =>
                      Math.abs(p.lat - lat) < 1e-7 &&
                      Math.abs(p.lon - lon) < 1e-7,
                  ),
                ).meta.center_height_m
              : window.RealMoon.sample(lat, lon)) /
              1000 +
              (hkm || 0),
          ),
        enu: (lat, lon) => enu(lat, lon),
        RM: R_M / 1000,
        AU: 149597870.7,
      };
      return this._EPH;
    }
    terrainResolution(site) {
      return (
        S.bySite(site)?.meta.terrain_resolution_m ||
        window.RealMoon.resolution(site.lat, site.lon)
      );
    }
    demFor(site) {
      const p = S.bySite(site);
      const prepared =
        !p && S.custom.get(S.customKey(site, this.state.obsH || 2));
      if (prepared) {
        const k = this.siteKey(site),
          d = prepared.dem;
        d.slope ??= this.terrLib().slopes(d);
        d.key = k;
        return d;
      }
      if (p && !p.heights)
        return {
          centerHeightM: p.meta.center_height_m,
          sourceResolutionM: p.meta.terrain_resolution_m,
          N: 0,
        };
      return super.demFor(site);
    }
    profileFor(site) {
      const p = S.bySite(site),
        height = this.state.obsH || 2;
      if (p) return Float32Array.from(p.profiles[height] || []);
      const prepared = S.custom.get(S.customKey(site, height));
      if (prepared) return prepared.profile;
      const d = this.demFor(site);
      return ((d.profs ??= {})[height] ??= S.farProfile(site, height));
    }
    terrLib() {
      const t = super.terrLib();
      t.profAt = horizonValue;
      return t;
    }
    ensureTerrain() {
      const s = this.state;
      if (s.view === "region") return;
      const site = this.selSite(),
        product = S.bySite(site);
      if (product && !product.heights) return;
      const dem = this.demFor(site),
        p = dem.product,
        key = this.siteKey(site) + "|h" + s.obsH;
      if (!p && dem.customAtlas) {
        const a = dem.customAtlas.meta.atlas;
        this._tj = {
          key,
          dem,
          hmap: dem.customAtlas.atlas,
          B: a.azimuth_bins,
          Nc: a.N,
          stride: (dem.N - 1) / (a.N - 1),
          cancel: false,
        };
        if (s.tready !== key) this.setState({ tready: key, tprog: 1 });
        return;
      }
      if (!p) {
        if (!dem.customAtlas?.heightReady?.includes(s.obsH))
          dem.customAtlas = null;
        super.ensureTerrain();
        const j = this._tj;
        if (j?.hmap && !dem.customAtlas?.heightReady?.includes(s.obsH)) {
          const Nc = 31,
            B = j.B,
            stride = (dem.N - 1) / (Nc - 1),
            hmap = new Float32Array(Nc * Nc * B);
          for (let y = 0; y < Nc; y++)
            for (let x = 0; x < Nc; x++) {
              const xx = Math.round((x / (Nc - 1)) * (j.Nc - 1)),
                yy = Math.round((y / (Nc - 1)) * (j.Nc - 1));
              hmap.set(
                j.hmap.subarray((yy * j.Nc + xx) * B, (yy * j.Nc + xx + 1) * B),
                (y * Nc + x) * B,
              );
            }
          dem.customAtlas = {
            heightReady: [s.obsH],
            atlas: hmap,
            meta: {
              atlas: {
                N: Nc,
                azimuth_bins: B,
                heights_m: [s.obsH],
                ray_extent_m: 11314,
              },
            },
          };
          dem.publishedPSR ??= S.maskFor(dem);
          this._tj = { ...j, Nc, B, hmap, stride };
        }
        return;
      }
      if (this._tj?.key === key) return;
      if (this._tj) this._tj.cancel = true;
      const a = p.meta.atlas,
        Nc = a.N,
        B = a.azimuth_bins,
        k = a.heights_m.indexOf(s.obsH || 2),
        hmap = p.atlas.subarray(k * Nc * Nc * B, (k + 1) * Nc * Nc * B);
      this._tj = {
        key,
        dem,
        hmap,
        B,
        stride: (dem.N - 1) / (Nc - 1),
        Nc,
        cancel: false,
      };
      if (s.tready !== key) this.setState({ tready: key, tprog: 1 });
    }
    heatAcc() {
      const jb = this._tj;
      if (!jb?.dem.product && !jb?.dem.customAtlas) return super.heatAcc();
      const ser = this.series(),
        key = jb.key + "|" + ser.key + "|" + this.state.visDef;
      if (this._hacc?.key === key) return this._hacc;
      const Nv = jb.Nc ** 2,
        sun = new Float32Array(Nv),
        earth = new Float32Array(Nv),
        mrun = new Float32Array(Nv),
        height = this.state.obsH || 2,
        step = Math.max(1, Math.ceil(ser.n / 240)),
        threshold = this.visThr();
      let count = 0;
      for (let k = 0; k < ser.n; k += step) count++;
      for (let j = 0; j < jb.Nc; j++)
        for (let i = 0; i < jb.Nc; i++) {
          const index = j * jb.Nc + i,
            ii = i * jb.stride,
            jj = j * jb.stride,
            loc = S.geoFor(jb.dem, ii, jj),
            ground = jb.dem.centerHeightM + jb.dem.h[jj * jb.dem.N + ii] * 1000,
            profile = jb.hmap.subarray(index * jb.B, (index + 1) * jb.B);
          let run = 0;
          for (let k = 0; k < ser.n; k += step) {
            const p = S.ephem.topo(
                ser.st[k],
                loc.lat,
                loc.lon,
                (ground + height) / 1000,
              ),
              sv =
                discFraction(
                  p.sun.el - horizonValue(profile, p.sun.az),
                  p.sun.rad,
                ) >= threshold,
              ev =
                discFraction(
                  p.earth.el - horizonValue(profile, p.earth.az),
                  p.earth.rad,
                ) >= threshold;
            if (sv) {
              sun[index]++;
              run = 0;
            } else {
              run += step * ser.stepH;
              mrun[index] = Math.max(mrun[index], run);
            }
            if (ev) earth[index]++;
          }
          sun[index] /= count;
          earth[index] /= count;
        }
      this._hacc = { key, sun, earth, mrun, per: (ser.n - 1) * ser.stepH };
      return this._hacc;
    }
    heat() {
      const h = super.heat();
      if (!h) return h;
      const dem = this._tj.dem;
      if (dem.publishedPSR) {
        if (h.psr !== dem.publishedPSR) {
          h.psr = dem.publishedPSR;
          h.psrKm2 = h.psr.reduce((a, b) => a + b, 0) * dem.cell ** 2;
        }
      } else if (!h.psrUnavailable) {
        h.psr = new Uint8Array(dem.N ** 2);
        h.psrKm2 = undefined;
        h.psrUnavailable = true;
      }
      return h;
    }
    reach() {
      const jb = this._tj,
        o = this.reachOrigin();
      if (!jb || !o || !(jb.dem.product || jb.dem.customAtlas)) return null;
      const product = jb.dem.product || jb.dem.customAtlas;
      const utc = this._ser.times[Math.min(this.state.ti, this._ser.n - 1)],
        key = [
          jb.key,
          this.state.routeDays||1,
          o.i,
          o.j,
          utc,
          Math.floor((this.state.rover?.batt ?? 80) / 5) * 5,
        ].join("|");
      if (this._routeWanted !== key && performance.now()-(this._routeSentAt||-1000)>=350) {
        this._routeSentAt=performance.now();
        if(this._routePending)this._scienceWorker.postMessage({type:'cancelRoute'});
        this._routeWanted = key;
        this._routePending = true;
        this._routeJob++;
        const a = product.meta.atlas,
          N = a.N,
          stride = (jb.dem.N - 1) / (N - 1),
          slope = conservativeSlopes(jb.dem.slope, jb.dem.N, N),
          points = [];
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++) {
            const ii = Math.round(i * stride),
              jj = Math.round(j * stride);
            const loc = S.geoFor(jb.dem, ii, jj);
            points.push({
              ...loc,
              h: jb.dem.centerHeightM + jb.dem.h[jj * jb.dem.N + ii] * 1000,
            });
          }
        this._scienceWorker.postMessage({
          type: "route",
          job: this._routeJob,
          key,
          N,
          cellKm: jb.dem.L / (N - 1),
          slope,
          points,
          atlas: product.atlas,
          atlasMeta: a,
          originFrom:o.from,
          origin: Math.round(o.j / stride) * N + Math.round(o.i / stride),
          height: this.state.obsH || 2,
          start: utc,
          battery: this.state.rover?.batt ?? 80,
          maxHours:(this.state.routeDays||1)*24,
        });
      }
      const m = this._routeResult;
      if (!m || !m.key.startsWith(jb.key+"|")) return this._reach?.terrainKey===jb.key?this._reach:null;
      const N = jb.dem.N,
        small = m.N,
        stride = (N - 1) / (small - 1);
      if (this._reach?.k === m.key) return this._reach;
      const T = new Float32Array(N * N),
        prev = new Int32Array(N * N).fill(-1);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const x = Math.round(i / stride),
            y = Math.round(j / stride),
            k = y * small + x,
            full = y * stride * N + x * stride;
          T[j * N + i] = m.T[k];
          prev[j * N + i] = j * N + i === full ? -1 : full;
        }
      for (let y = 0; y < small; y++)
        for (let x = 0; x < small; x++) {
          const k = y * small + x,
            p = m.spatialPrev[k];
          if (p >= 0)
            prev[y * stride * N + x * stride] =
              Math.floor(p / small) * stride * N + (p % small) * stride;
        }
      const pathCache = new Map(),
        routePointsFor = (full) => {
          if (pathCache.has(full)) return pathCache.get(full);
          const x = Math.round((full % N) / stride),
            y = Math.round(Math.floor(full / N) / stride),
            points = [];
          let id = m.stateBest[y * small + x],
            guard = 0;
          while (id >= 0 && guard++ < m.stateParent.length) {
            const cell = m.stateCell[id],
              i = (cell % small) * stride,
              j = Math.floor(cell / small) * stride,
              time = m.stateTime[id],
              sky = S.skyAt(
                jb.dem,
                i,
                j,
                m.start + time * 3600000,
                this.state.obsH || 2,
              );
            points.push({
              i,
              j,
              time,
              earth: sky.earth,
              energyWh: m.stateEnergy[id],
            });
            id = m.stateParent[id];
          }
          pathCache.set(full, points);
          return points;
        };
      this._reach = {
        k:m.key,terrainKey:jb.key,start: m.start,smallN:m.N,incomplete:m.incomplete,maxHours:m.maxHours,contours:m.contours,
        T,
        prev,
        o:{i:(m.origin%small)*stride,j:Math.floor(m.origin/small)*stride,from:m.originFrom},
        img: null,
        routePointsFor,
        contacts: m.contacts,
        model:
          "31×31 grid; 1 h time / 5% energy label bins; continuous Wh, 15 min integration; approximate reachability",
      };
      return this._reach;
    }
    sendShade(task) {
      if (this._shadeBusy) {
        this._shadeNext = task;
        return;
      }
      const jb = this._tj;
      if (!jb || jb.key !== task.key) return;
      if (this._shadeInit !== jb.key) {
        this._shadeInit = jb.key;
        const d = jb.dem;
        this._shadeWorker.postMessage({
          type: "init",
          key: jb.key,
          N: d.N,
          Nc: jb.Nc,
          B: jb.B,
          stride: jb.stride,
          h: d.h,
          hmap: jb.hmap,
          lat: d.lat,
          lon: d.lon,
          L: d.L,
          cell: d.cell,
          centerHeightM: d.centerHeightM,
          height: this.state.obsH || 2,
          psr: d.publishedPSR || new Uint8Array(d.N * d.N),
          slope: d.slope,
        });
      }
      this._shadeBusy = true;
      this._shadeWorker.postMessage({
        ...task,
        type: "shade",
        token: ++this._shadeToken,
      });
    }
    sync() {
      if (this._tj)
        this._tj.scienceShade = !!(
          this._tj.dem.product || this._tj.dem.customAtlas
        );
      super.sync();
      if (!this.eng) return;
      const ser = this.series(),
        utc = ser.times[Math.min(this.state.ti, ser.n - 1)];
      this.eng.set({ simUTC: utc });
      if (!(this._tj?.dem.product || this._tj?.dem.customAtlas))
        this.eng.set({ scienceAt: null });
      if (
        this.state.view !== "region" &&
        (this._tj?.dem.product || this._tj?.dem.customAtlas)
      ) {
        const jb = this._tj,
          dem = jb.dem,
          height = this.state.obsH || 2;
        this.eng.set({
          scienceAt: (x, z, time) =>
            S.skyAt(
              dem,
              clamp((x + dem.L / 2) / dem.cell, 0, dem.N - 1),
              clamp((-z + dem.L / 2) / dem.cell, 0, dem.N - 1),
              time ?? utc,
              height,
            ),
        });
        const key = jb.key + "|" + utc + "|" + !!this.state.bigMap;
        if (this._correctShade !== key) {
          this._correctShade = key;
          this.sendShade({
            key: jb.key,
            utc,
            sun: S.ephem.state(utc).sun,
            bigMap: !!this.state.bigMap,
          });
        }
      }
    }
    async findBestWindows() {
      try {
        await S.ephem.ensureRange(
          Date.UTC(this.state.windowYear, 0, 1),
          Date.UTC(this.state.windowYear + 1, 0, 1) +
            this.state.stayHours * 3600000,
        );
        this.syncWorkerYears();
      } catch (e) {
        return this.setState({ windowStatus: e.message });
      }
      const site = this.selSite(),
        product = S.bySite(site),
        dem = product
          ? { centerHeightM: product.meta.center_height_m }
          : this.demFor(site);
      this.setState({
        windowStatus: "Searching one year at 1 h visibility sampling…",
        windowRows: [],
      });
      this._scienceWorker.postMessage({
        type: "windows",
        site: {
          lat: site.lat,
          lon: site.lon,
          centerHeightM: dem.centerHeightM,
        },
        profile: this.profileFor(site),
        year: this.state.windowYear,
        stayHours: this.state.stayHours,
        weights: [this.state.wSun, this.state.wEarth, this.state.wGap],
        height: this.state.obsH || 2,
      });
    }
    renderVals() {
      const v = super.renderVals(),
        site = this.selSite(),
        p = S.bySite(site);
      v.modelNote =
        this.state.model === "G1"
          ? p
            ? "LOLA relief (G1), 300 km terrain rays; map/routing grid 533 m, 5° azimuth; selected-site profile 0.5°."
            : "Custom point: measured LOLA rays to 300 km; selected-pin profile 0.5°, spatial map/routes 5° azimuth on a 533 m grid. Finite ray sampling can miss narrow obstacles."
          : "Ideal horizon (G0); terrain obstruction excluded.";
      return {
        ...v,
        showTip:
          this._dataLoading ||
          this._detailLoading ||
          !!this._dataError ||
          v.showTip,
        tipText:
          this._dataError ||
          (this._dataLoading || this._detailLoading
            ? (this._detailLoading
                ? "Refining measured lunar detail… "
                : "Loading measured data… ") +
              (window.NASALDataProgress
                ? (window.NASALDataProgress.loaded / 1e6).toFixed(1) +
                  " / " +
                  (window.NASALDataProgress.total / 1e6).toFixed(1) +
                  " MB"
                : "")
            : v.tipText),
        siteSource:
          p?.meta.source ||
          site.source ||
          "https://pgda.gsfc.nasa.gov/products/90",
        siteSourceLabel: p
          ? p.meta.coordinate_role
          : "Custom coordinates; NASA LOLA terrain sampled at the chosen point.",
        ephemerisStatus: S.status.horizonsMonthVerified
          ? "verified against Horizons · " +
            (typeof S.status.period === "object"
              ? S.status.period.start + " / " + S.status.period.end
              : S.status.period)
          : "Horizons month validation pending · archived 96-vector regression available",
        scienceStatus:
          "SPICE MOON_ME, DE440 · hourly vectors 2024–2036 · geometric visibility only · Not affiliated with or endorsed by NASA",
        windowYear: this.state.windowYear,
        stayHours: this.state.stayHours,
        onWindowYear: (e) =>
          this.setState({
            windowYear: Math.min(
              2034,
              Math.max(2024, Math.round(+e.target.value) || 2026),
            ),
          }),
        onStayHours: (e) =>
          this.setState({
            stayHours: Math.min(
              720,
              Math.max(1, Math.round(+e.target.value) || 156),
            ),
          }),
        findWindows: () => this.findBestWindows(),
        windowStatus: this.state.windowStatus,
        windowRows: this.state.windowRows.map((w, i) => ({
          title:
            "#" +
            (i + 1) +
            " · " +
            new Date(w.start).toISOString().slice(0, 16).replace("T", " ") +
            " UTC",
          sun: (w.sun * 100).toFixed(1) + "%",
          earth: (w.earth * 100).toFixed(1) + "%",
          dark: this.fmtH(w.darkHours),
          score: Math.round(w.score * 100) + "/100",
          pick: () => {
            this.setRange(w.start, w.end);
            this.setState({ sheet: null, landTi: 0 });
          },
        })),
        routeStatus: this._routePending
          ? "Computing time + energy reachability…"
          : this.state.routeStatus ||
            "Routes use a hypothetical tracking-panel vehicle; details below.",
      };
    }
    componentWillUnmount() {
      cancelAnimationFrame(this._detailFrame);
      if (this._detailIdle !== undefined) cancelIdleCallback(this._detailIdle);
      clearTimeout(this._detailTimer);
      this._ovEl?.removeEventListener("wheel",this._detailHandler);
      this._ovEl?.removeEventListener("pointerdown",this._detailHandler);
      this._shadeWorker.terminate();
      this._scienceWorker.terminate();
      super.componentWillUnmount();
    }
  };
}
