import { Ephemeris } from "./science-core.mjs";
import { fetchBytes, fetchJSON } from "./data-loader.mjs";
export class EphemerisStore {
  constructor(manifest) {
    this.manifest = manifest;
    this.years = new Map();
    this.pending = new Map();
    this.first = Date.UTC(2024, 0, 1);
    this.last = Date.UTC(2036, 0, 1);
  }
  static async create(start, end) {
    const s = new EphemerisStore(await fetchJSON("data/ephem/manifest.json"));
    await s.ensureRange(start, end);
    return s;
  }
  async year(year) {
    if (this.years.has(year)) return this.years.get(year);
    if (this.pending.has(year)) return this.pending.get(year);
    const m = this.manifest[year];
    if (!m) throw Error("Ephemeris coverage is 2024–2036 UTC.");
    const job = fetchBytes("data/" + m.file, { gzip: true })
      .then((buffer) => {
        const e = new Ephemeris(new Float32Array(buffer), m);
        this.years.set(year, e);
        return e;
      })
      .finally(() => this.pending.delete(year));
    this.pending.set(year, job);
    return job;
  }
  async ensureRange(start, end) {
    if (start < this.first || end > this.last)
      throw Error("Choose dates between 2024-01-01 and 2036-01-01 UTC.");
    const tasks = [];
    for (
      let y = new Date(start).getUTCFullYear();
      y <= Math.min(2035, new Date(end).getUTCFullYear());
      y++
    )
      tasks.push(this.year(y));
    await Promise.all(tasks);
  }
  ready(start, end) {
    if (start < this.first || end > this.last) return false;
    for (
      let y = new Date(start).getUTCFullYear();
      y <= Math.min(2035, new Date(end).getUTCFullYear());
      y++
    )
      if (!this.years.has(y)) return false;
    return true;
  }
  state(ms) {
    const y = Math.min(2035, new Date(ms).getUTCFullYear()),
      e = this.years.get(y);
    if (!e) throw Error("Ephemeris year " + y + " is loading.");
    return e.state(ms);
  }
  topo(...args) {
    return Ephemeris.prototype.topo(...args);
  }
  workerYears() {
    return [...this.years].map(([year, e]) => ({
      year,
      records: e.records,
      meta: e.meta,
    }));
  }
}
