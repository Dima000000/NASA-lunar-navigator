import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Ephemeris,horizonValue,discFraction,batteryAfter,timeAwareReach,findWindows} from '../app/science-core.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('../public/data/ephem.json',import.meta.url))),buffer=fs.readFileSync(new URL('../public/data/ephem.bin',import.meta.url));
const e=new Ephemeris(new Float32Array(buffer.buffer,buffer.byteOffset,buffer.byteLength/4),meta);
test('archived Horizons regression: independent archived elevations and azimuths',()=>{
 const rows=JSON.parse(fs.readFileSync(new URL('../public/data/validation_vectors.json',import.meta.url)));
 assert.equal(rows.length,48);
 for(const r of rows){const p=e.topo(e.state(Date.parse(r.utc)),r.lat,r.lon,r.h_m/1000);for(const b of ['sun','earth']){assert.ok(Math.abs(p[b].el-r[b+'_el'])<.1,`${r.utc} ${b} elevation`);const az=((p[b].az-r[b+'_az']+540)%360)-180;assert.ok(Math.abs(az)<.1)}}
});
test('horizon wraps at north; solar limb integrates a circular disc',()=>{assert.equal(horizonValue([1,2,3,4],360),1);assert.equal(horizonValue([1,2,3,4],-90),4);assert.equal(discFraction(0,.27),.5);assert.equal(discFraction(-1,.27),0);assert.equal(discFraction(1,.27),1)});
test('battery uses watt hours; night costs 10 W idle and 55 W driving',()=>{assert.equal(batteryAfter(100,0,2),80);assert.equal(batteryAfter(100,0,1,true),45);assert.equal(batteryAfter(100,1,10),160)});
test('routes respond to time-dependent light and terrain barriers',()=>{
 const common={N:9,cellKm:.5,slope:new Float32Array(81),origin:40,maxHours:10};
 const sky=(_k,ms)=>({sun:ms<360000000?1:0,earth:1});
 const day=timeAwareReach({...common,sky,startMs:0}),night=timeAwareReach({...common,sky,startMs:720000000});
 const count=r=>[...r.T].filter(Number.isFinite).length;assert.ok(count(day)>count(night));
 const slope=new Float32Array(81);for(let j=0;j<9;j++)slope[j*9+5]=21;
 const blocked=timeAwareReach({...common,slope,sky,startMs:0});assert.equal(blocked.T[4*9+6],Infinity);
});
test('slow charging accumulates below a bucket and later departures survive',()=>{
 const vehicle={capacityWh:160,initialFraction:.3,panelM2:.5,panelEfficiency:.28,idleW:10,driveW:45,maxSlopeDeg:20,flatSpeedKmh:1};
 const slope=new Float32Array([0,0,21,21]),r=timeAwareReach({N:2,cellKm:2,slope,origin:0,sky:k=>({sun:k===0?.1:0,earth:1}),startMs:0,vehicle,maxHours:24});
 assert.ok(Number.isFinite(r.T[1]),'sub-bucket charging eventually permits a night crossing');
 assert.ok(r.T[1]>2,'the rover must wait to accumulate enough charge');
 let id=r.best[1],waited=false;while(r.parent[id]>=0){assert.ok(r.energyWh[id]>0);const p=r.parent[id];if(Math.floor(id/21)%4===Math.floor(p/21)%4)waited=true;id=p}assert.ok(waited);
});
test('top five windows are in year, ordered, non-overlapping, and have bounded metrics',()=>{
 const site=JSON.parse(fs.readFileSync(new URL('../public/data/sites/cr/meta.json',import.meta.url))),h=JSON.parse(fs.readFileSync(new URL('../public/data/sites/cr/horizon_h2.json',import.meta.url)));
 const rows=findWindows(e,{lat:site.lat,lon:site.lon,centerHeightM:site.center_height_m},h.elev_deg,{year:2026});assert.equal(rows.length,5);
 for(let i=0;i<rows.length;i++){assert.equal(new Date(rows[i].start).getUTCFullYear(),2026);assert.ok(rows[i].sun>=0&&rows[i].sun<=1);assert.ok(rows[i].earth>=0&&rows[i].earth<=1);assert.ok(rows[i].darkHours<=156);if(i)assert.ok(rows[i].score<=rows[i-1].score);for(let j=0;j<i;j++)assert.ok(Math.abs(rows[i].start-rows[j].start)>=156*3600000)}
});
test('all sites have traceable coordinates, dense terrain, and complete horizon atlases',()=>{
 const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url)));assert.equal(catalog.length,12);
 for(const s of catalog){assert.ok(s.source.startsWith('https://'));const base=new URL('../public/data/sites/'+s.key+'/',import.meta.url),m=JSON.parse(fs.readFileSync(new URL('meta.json',base)));assert.equal(m.N,481);assert.equal(fs.statSync(new URL('dem.f32',base)).size,481*481*4);assert.equal(fs.statSync(new URL('horizon-atlas.f32',base)).size,3*31*31*72*4)}
});
