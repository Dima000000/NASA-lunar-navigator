import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  Ephemeris,
  horizonValue,
  discFraction,
  batteryAfter,
  timeAwareReach,
  findWindows,
} from "../app/science-core.mjs";
import { conservativeSlopes } from "../app/route-search.mjs";
const meta = JSON.parse(
    fs.readFileSync(new URL("../public/data/ephem.json", import.meta.url)),
  ),
  buffer = fs.readFileSync(
    new URL("../public/data/ephem.bin", import.meta.url),
  );
const e = new Ephemeris(
  new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4),
  meta,
);
test("archived Horizons regression: independent archived elevations and azimuths", () => {
  const rows = JSON.parse(
    fs.readFileSync(
      new URL("../public/data/validation_vectors.json", import.meta.url),
    ),
  );
  assert.equal(rows.length, 48);
  for (const r of rows) {
    const p = e.topo(e.state(Date.parse(r.utc)), r.lat, r.lon, r.h_m / 1000);
    for (const b of ["sun", "earth"]) {
      assert.ok(
        Math.abs(p[b].el - r[b + "_el"]) < 0.1,
        `${r.utc} ${b} elevation`,
      );
      const az = ((p[b].az - r[b + "_az"] + 540) % 360) - 180;
      assert.ok(Math.abs(az) < 0.1);
    }
  }
});
test("horizon wraps at north; solar limb integrates a circular disc", () => {
  assert.equal(horizonValue([1, 2, 3, 4], 360), 1);
  assert.equal(horizonValue([1, 2, 3, 4], -90), 4);
  assert.equal(discFraction(0, 0.27), 0.5);
  assert.equal(discFraction(-1, 0.27), 0);
  assert.equal(discFraction(1, 0.27), 1);
});
test("battery uses watt hours; night costs 10 W idle and 55 W driving", () => {
  assert.equal(batteryAfter(100, 0, 2), 80);
  assert.equal(batteryAfter(100, 0, 1, true), 45);
  assert.equal(batteryAfter(100, 1, 10), 160);
});
test("routes respond to time-dependent light and terrain barriers", () => {
  const common = {
    N: 9,
    cellKm: 0.5,
    slope: new Float32Array(81),
    origin: 40,
    maxHours: 10,
  };
  const sky = (_k, ms) => ({ sun: ms < 360000000 ? 1 : 0, earth: 1 });
  const day = timeAwareReach({ ...common, sky, startMs: 0 }),
    night = timeAwareReach({ ...common, sky, startMs: 720000000 });
  const count = (r) => [...r.T].filter(Number.isFinite).length;
  assert.ok(count(day) > count(night));
  const slope = new Float32Array(81);
  for (let j = 0; j < 9; j++) slope[j * 9 + 5] = 21;
  const blocked = timeAwareReach({ ...common, slope, sky, startMs: 0 });
  assert.equal(blocked.T[4 * 9 + 6], Infinity);
});
test("slow charging accumulates below a bucket and later departures survive", () => {
  const vehicle = {
    capacityWh: 160,
    initialFraction: 0.3,
    panelM2: 0.5,
    panelEfficiency: 0.28,
    idleW: 10,
    driveW: 45,
    maxSlopeDeg: 20,
    flatSpeedKmh: 1,
  };
  const slope = new Float32Array([0, 0, 21, 21]),
    r = timeAwareReach({
      N: 2,
      cellKm: 2,
      slope,
      origin: 0,
      sky: (k) => ({ sun: k === 0 ? 0.1 : 0, earth: 1 }),
      startMs: 0,
      vehicle,
      maxHours: 24,
    });
  assert.ok(
    Number.isFinite(r.T[1]),
    "sub-bucket charging eventually permits a night crossing",
  );
  assert.ok(r.T[1] > 2, "the rover must wait to accumulate enough charge");
  let id = r.best[1],
    waited = false;
  while (r.parent[id] >= 0) {
    assert.ok(r.energyWh[id] > 0);
    const p = r.parent[id];
    if (r.stateCell[id] === r.stateCell[p]) waited = true;
    assert.ok(r.dist[p] < r.dist[id]);
    id = p;
  }
  assert.ok(waited);
});
test("route cell slopes retain subcell scarps and diagonals cannot cut corners", () => {
  const fine = new Float32Array(81);
  fine[3 * 9 + 3] = 31;
  const coarse = conservativeSlopes(fine, 9, 3);
  assert.equal(coarse[4], 31);
  const r = timeAwareReach({
    N: 2,
    cellKm: 1,
    slope: new Float32Array([0, 25, 25, 0]),
    origin: 0,
    sky: () => ({ sun: 1, earth: 1 }),
    startMs: 0,
    maxHours: 5,
  });
  assert.equal(r.T[3], Infinity);
});
test("Pareto labels preserve a feasible charged departure and consistent state chains", () => {
  const r = timeAwareReach({
    N: 3,
    cellKm: 0.7,
    slope: new Float32Array(9),
    origin: 4,
    sky: (k, t) => ({ sun: k === 4 || t > 4 * 3600000 ? 1 : 0, earth: k % 2 }),
    startMs: 0,
    maxHours: 8,
  });
  assert.equal(r.incomplete, false);
  assert.ok(r.frontLimit >= 4);
  for (const id of r.best) {
    if (id < 0) continue;
    let p = id,
      guard = 0;
    while (p >= 0) {
      assert.ok(r.energyWh[p] > 0 && r.energyWh[p] <= 160);
      const parent = r.parent[p];
      if (parent >= 0) assert.ok(r.dist[parent] < r.dist[p]);
      p = parent;
      assert.ok(++guard < r.parent.length + 1);
    }
  }
});
test("top five windows are in year, ordered, non-overlapping, and have bounded metrics", () => {
  const site = JSON.parse(
      fs.readFileSync(
        new URL("../public/data/sites/cr/meta.json", import.meta.url),
      ),
    ),
    h = JSON.parse(
      fs.readFileSync(
        new URL("../public/data/sites/cr/horizon_h2.json", import.meta.url),
      ),
    );
  const rows = findWindows(
    e,
    { lat: site.lat, lon: site.lon, centerHeightM: site.center_height_m },
    h.elev_deg,
    { year: 2026 },
  );
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(new Date(rows[i].start).getUTCFullYear(), 2026);
    assert.ok(rows[i].sun >= 0 && rows[i].sun <= 1);
    assert.ok(rows[i].earth >= 0 && rows[i].earth <= 1);
    assert.ok(rows[i].darkHours <= 156);
    if (i) assert.ok(rows[i].score <= rows[i - 1].score);
    for (let j = 0; j < i; j++)
      assert.ok(Math.abs(rows[i].start - rows[j].start) >= 156 * 3600000);
  }
});
test("all sites have traceable coordinates, dense terrain, and complete horizon atlases", () => {
  const catalog = JSON.parse(
    fs.readFileSync(new URL("../public/data/catalog.json", import.meta.url)),
  );
  assert.equal(catalog.length, 12);
  for (const s of catalog) {
    assert.ok(s.source.startsWith("https://"));
    const base = new URL(
        "../public/data/sites/" + s.key + "/",
        import.meta.url,
      ),
      m = JSON.parse(fs.readFileSync(new URL("meta.json", base)));
    assert.equal(m.N, 481);
    assert.equal(fs.statSync(new URL("dem.f32", base)).size, 481 * 481 * 4);
    assert.equal(
      fs.statSync(new URL("horizon-atlas.f32", base)).size,
      3 * 31 * 31 * 72 * 4,
    );
  }
});
test("compressed scientific grids and yearly ephemerides preserve every original byte", () => {
  const data = new URL("../public/data/", import.meta.url),
    years = JSON.parse(fs.readFileSync(new URL("ephem/manifest.json", data))),
    catalog = JSON.parse(fs.readFileSync(new URL("catalog.json", data)));
  for (const [year, m] of Object.entries(years)) {
    const a = (Date.parse(m.t0_utc) - e.first) / 3600000,
      decoded = gunzipSync(fs.readFileSync(new URL(m.file, data)));
    assert.deepEqual(
      decoded,
      buffer.subarray(a * 32, (a + m.count) * 32),
      year,
    );
    const split = new Ephemeris(
      new Float32Array(decoded.buffer, decoded.byteOffset, decoded.length / 4),
      m,
    );
    for (const t of [
      Date.parse(m.t0_utc),
      Date.parse(m.t0_utc) + (m.count - 1) * 3600000,
    ])
      assert.deepEqual(split.state(t), e.state(t));
  }
  for (const site of catalog)
    for (const name of ["dem.f32", "horizon-atlas.f32", "psr.u8"])
      assert.deepEqual(
        gunzipSync(
          fs.readFileSync(
            new URL("sites/" + site.key + "/" + name + ".gz", data),
          ),
        ),
        fs.readFileSync(new URL("sites/" + site.key + "/" + name, data)),
      );
});
test("optional display-only quantization stays within half its documented height step", () => {
  const catalog = JSON.parse(
    fs.readFileSync(new URL("../public/data/catalog.json", import.meta.url)),
  );
  for (const site of catalog) {
    const base = new URL(
        "../public/data/sites/" + site.key + "/",
        import.meta.url,
      ),
      m = JSON.parse(fs.readFileSync(new URL("height.json", base)));
    assert.ok(m.max_error_m <= m.step / 2 + 0.0001);
    assert.equal(m.step, 0.1);
  }
});

test("delivery URLs and hashes are portable across Windows and Linux", () => {
  const data = new URL("../public/data/", import.meta.url);
  const manifest = JSON.parse(
    fs.readFileSync(new URL("delivery-manifest.json", data)),
  );
  for (const [name, m] of Object.entries(manifest.files)) {
    assert.ok(!name.includes("\\"), name);
    const bytes = fs.readFileSync(new URL(name, data));
    assert.equal(bytes.length, m.bytes, name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      m.sha256,
      name,
    );
  }
  assert.ok(manifest.files["sites/cr/dem.f32.gz"].decodedSha256);
  const provenance = JSON.parse(
    fs.readFileSync(new URL("checksums.json", data)),
  );
  for (const [name, expected] of Object.entries(provenance.files)) {
    const bytes = fs.readFileSync(new URL(name, data));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      name,
    );
  }
});

import "./ui-analysis.test.mjs";
import "./drive-navigation.test.mjs";
