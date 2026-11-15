import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Ephemeris,findWindows,VEHICLE,batteryAfter} from '../app/science-core.mjs';
import {paretoReach,reachSteps} from '../app/route-search.mjs';
import {interpolateVisualState} from '../app/visual-time.mjs';
import {rankSpots,buildTripPlan,tripCSV,travelContours} from '../app/planning-analysis.mjs';
test('visual slerp: exact hourly nodes and 100 reproducible fractional-time samples',()=>{
 const meta=JSON.parse(fs.readFileSync(new URL('../public/data/ephem.json',import.meta.url))),b=fs.readFileSync(new URL('../public/data/ephem.bin',import.meta.url)),e=new Ephemeris(new Float32Array(b.buffer,b.byteOffset,b.byteLength/4),meta);let seed=20261115,max=0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let i=0;i<100;i++){const hour=Math.floor(random()*(meta.count-2)),node=e.first+hour*3600000;assert.deepEqual(interpolateVisualState(e,node),e.state(node));const t=node+random()*3600000,visual=interpolateVisualState(e,t),linear=e.state(t);for(const body of ['sun','earth']){const a=visual[body],b=linear[body],cos=a.reduce((s,x,k)=>s+x*b[k],0)/Math.hypot(...a)/Math.hypot(...b),angle=Math.acos(Math.max(-1,Math.min(1,cos)))*180/Math.PI;max=Math.max(max,angle);assert(angle<.01);assert(Math.abs(Math.hypot(...a)-Math.hypot(...b))<1e-5*Math.hypot(...b));}}
 console.log('slerp vs unchanged hourly-table interpolation, max angular difference:',max,'deg; this is not independent fractional-time Horizons validation');
});
test('best spots match the landing-window score and reject steep cells',async()=>{
 const start=Date.UTC(2026,0,1),sky=(cell,t)=>({sun:(Math.floor((t-start)/3600000)%24)<18?1:0,earth:(Math.floor((t-start)/3600000)%24)<12?1:0});
 const q={N:2,start,end:start+24*3600000,weights:[50,30,20],threshold:.0005,slope:[0,16,8,20],points:Array.from({length:4},()=>({lat:-89,lon:0,h:0}))};
 const rows=await rankSpots(q,sky);assert.equal(rows.length,2);assert(rows.every(r=>r.slope<=15));
 const fake={state:t=>t,topo:t=>{const s=sky(0,t);return {sun:{el:s.sun?10:-10,az:0,rad:.25},earth:{el:s.earth?10:-10,az:0,rad:1}};}};
 const expected=findWindows(fake,{lat:-89,lon:0,centerHeightM:0},[0],{year:2026,stayHours:24,weights:q.weights})[0];assert.equal(rows[0].score,expected.score);assert.equal(rows[0].darkHours,expected.darkHours);
 assert.equal(await rankSpots(q,sky,()=>{},()=>true),null);
});
test('cooperative route search preserves route labels and energy/contact trip accounting',()=>{
 const sky=(k,t)=>({sun:1,earth:k%2?0:1,sunDistanceKm:149597870.7}),q={N:3,cellKm:.5,slope:new Float32Array(9),origin:0,start:0,battery:80,maxHours:168,points:Array.from({length:9},(_,k)=>({lat:-89+k*.01,lon:0}))};
 const options={...q,startMs:q.start,sky},r=paretoReach(options),steps=reachSteps(options);let next,yields=0;do{next=steps.next();if(!next.done)yields++;}while(!next.done);assert.deepEqual(next.value.T,r.T);assert.deepEqual(next.value.parent,r.parent);assert(yields>0);
 const p=buildTripPlan(q,r,sky,8);assert(p.reachable);assert.equal(p.rows[0].cell,0);assert.equal(p.rows.at(-1).cell,8);assert.equal(p.steps[0].start,0);assert(p.samples.every(s=>s.battery>=0&&s.battery<=100));assert(p.earthFraction>=0&&p.earthFraction<=1);assert.equal(p.earthBands.at(-1).end,p.hours);assert.equal(p.steps.at(-1).end,p.hours);assert(tripCSV(p).startsWith('utc,action,'));
 const blocked=paretoReach({...options,slope:new Float32Array(9).fill(30)});assert.equal(buildTripPlan({...q,slope:new Float32Array(9).fill(30)},blocked,sky,8).reachable,false);
});
test('trip charging stops include their first integration sample',()=>{
 const q={N:1,start:0,slope:[0],points:[{lat:-89,lon:0}]},r={best:[1],parent:[-1,0],stateCell:[0,0],dist:[0,.25],energyWh:[40,batteryAfter(40,1,.25)],incomplete:false},p=buildTripPlan(q,r,()=>({sun:1,earth:1}),0);assert.equal(p.chargeStops,1);assert.equal(p.chargeHours,.25);assert.equal(p.steps[0].energyStart,40);assert.equal(p.earthFraction,1);
});
test('travel contours interpolate only finite traversable cells',()=>{const c=travelContours(new Float32Array([0,48,0,48]),2,48);assert(c.length>0);assert(c.every(l=>l.hours===24||l.hours===48));assert.deepEqual(travelContours(new Float32Array([0,Infinity,0,48]),2,48),[]);});
