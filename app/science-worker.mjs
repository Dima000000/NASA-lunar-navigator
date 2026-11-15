import {
  Ephemeris,
  findWindows,
  timeAwareReach,
  horizonValue,
  discFraction,
  VEHICLE,
} from "./science-core.mjs";
import {reachSteps} from "./route-search.mjs";
import {buildTripPlan,rankSpots,travelContours} from "./planning-analysis.mjs";
let ephem, routeGeneration=0,lastRoute,bestGeneration=0;
function makeSky(q){
      const a = q.atlasMeta,
        N = q.N,
        B = a.azimuth_bins,
        hi = a.heights_m.indexOf(q.height),
        cache = new Map();
      const sky = (k, ms) => {
        const hour = q.cache===false?ms/900000:Math.round(ms / 900000),
          key = k + N * N * hour;
        if(q.cache!==false&&cache.has(key)) return cache.get(key);
        const p = q.points[k],
          t = ephem.topo(
            ephem.state(hour * 900000),
            p.lat,
            p.lon,
            (p.h + q.height) / 1000,
          ),
          profile = q.atlas.subarray(
            (hi * N * N + k) * B,
            (hi * N * N + k + 1) * B,
          );
        const v = {
          sunDistanceKm: t.sun.dist,
          sun: discFraction(
            t.sun.el - horizonValue(profile, t.sun.az),
            t.sun.rad,
          ),
          earth: discFraction(
            t.earth.el - horizonValue(profile, t.earth.az),
            t.earth.rad,
          ),
        };
        if(q.cache!==false){if(cache.size>120000)cache.clear();cache.set(key,v);}
        return v;
      };
      return sky;
}
onmessage = async ({ data: q }) => {
  try {
    if (q.type === "cancelRoute") { routeGeneration++; return; }
    if (q.type === "initYears") {
      const years = new Map(
        q.years.map((y) => [y.year, new Ephemeris(y.records, y.meta)]),
      );
      ephem = {
        state: (ms) => {
          const e = years.get(Math.min(2035, new Date(ms).getUTCFullYear()));
          if (!e) throw Error("Requested ephemeris year is not loaded");
          return e.state(ms);
        },
        topo: (...args) => Ephemeris.prototype.topo(...args),
      };
      return;
    }
    if (q.type === "init") {
      ephem = new Ephemeris(q.records, q.meta);
      return;
    }
    if (q.type === "windows") {
      postMessage({
        type: "windows",
        rows: findWindows(ephem, q.site, q.profile, q),
      });
      return;
    }
    if(q.type==='cancelBestSpots'){bestGeneration++;return;}
    if(q.type==='bestSpots'){const generation=++bestGeneration,sky=makeSky({...q,cache:false});const rows=await rankSpots(q,sky,progress=>postMessage({type:'bestProgress',job:q.job,progress}),()=>generation!==bestGeneration);if(rows)postMessage({type:'bestSpots',job:q.job,rows});return;}
    if(q.type==='trip'){
      if(!lastRoute||lastRoute.q.key!==q.key){postMessage({type:'trip',key:q.key,goal:q.goal,pending:true});return;}
      postMessage({type:'trip',key:q.key,goal:q.goal,plan:buildTripPlan(lastRoute.q,lastRoute.r,lastRoute.sky,q.goal)});return;
    }
    if (q.type === "route") {
      const N=q.N,sky=makeSky(q);
      const generation=++routeGeneration;
      const steps = reachSteps({
        N,
        cellKm: q.cellKm,
        slope: q.slope,
        origin: q.origin,
        sky,
        startMs: q.start,
        vehicle: { ...VEHICLE, initialFraction: q.battery / 100 },
        maxHours: q.maxHours || 24,
        timeBinHours: (q.maxHours || 24)>72 ? 3 : 1,
      });
      let next;
      do {next=steps.next();if(!next.done){postMessage({type:'routeProgress',job:q.job,...next.value});await new Promise(resolve=>setTimeout(resolve,0));if(generation!==routeGeneration)return;}}while(!next.done);
      const r=next.value;
      const spatialPrev = new Int32Array(N * N).fill(-1);
      for (let i = 0; i < r.best.length; i++) {
        const id = r.best[i];
        if (id >= 0 && r.parent[id] >= 0) {
          let p = r.parent[id];
          while (p >= 0 && r.stateCell[p] === i) p = r.parent[p];
          if (p >= 0) spatialPrev[i] = r.stateCell[p];
        }
      }
      lastRoute={q,r,sky};
      postMessage(
        {
          type: "route",
          job: q.job,
          key: q.key,
          N, origin:q.origin,originFrom:q.originFrom,start:q.start,maxHours:q.maxHours||24,contours:travelContours(r.T,N,q.maxHours||24),
          T: r.T,
          contacts: r.contacts,
          stateBest: r.best,
          stateParent: r.parent,
          stateTime: r.dist,
          stateEnergy: r.energyWh,
          stateCell: r.stateCell,
          incomplete: r.incomplete,
          prunedLabels: r.prunedLabels,
          buckets: r.buckets,
          spatialPrev,
          expanded: r.expanded,
        },

      );
    }
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
