import {VEHICLE,batteryAfter} from './science-core.mjs';
export function buildTripPlan(q,r,sky,goal){
 const ids=[];let id=r.best[goal],guard=0;
 if(id<0)return {reachable:false,reason:q.slope[goal]>15&&q.slope[goal]>VEHICLE.maxSlopeDeg?'Too steep for this rover scenario.':r.incomplete?'Search budget reached; feasibility is unknown.':'No energy-feasible route found within this planning horizon. Try more days or another start.',incomplete:r.incomplete};
 while(id>=0&&guard++<r.parent.length){ids.push(id);id=r.parent[id];}ids.reverse();
 const rows=ids.map(id=>{const cell=r.stateCell[id],p=q.points[cell];return {cell,i:cell%q.N,j:Math.floor(cell/q.N),time:r.dist[id],energyWh:r.energyWh[id],lat:p.lat,lon:p.lon};});
 const steps=[],samples=[{time:0,battery:rows[0].energyWh/VEHICLE.capacityWh*100,earth:sky(rows[0].cell,q.start).earth>.0005}],earthBands=[];
 let earthHours=0;
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i],duration=b.time-a.time,drive=a.cell!==b.cell;if(duration<=0)continue;
  const count=Math.max(1,Math.ceil(duration/.25)),dt=duration/count;let energy=a.energyWh;
  for(let j=0;j<count;j++){
   const f=(j+.5)/count,cell=f<.5?a.cell:b.cell,light=sky(cell,q.start+(a.time+duration*f)*3600000),earth=light.earth>.0005;
   const energyStart=energy;energy=batteryAfter(energy,light.sun,dt,drive,VEHICLE,light.sunDistanceKm);
   const t0=a.time+j*dt,t1=t0+dt,kind=drive?'drive':light.sun>.0005?'charge':'dark';
   const last=steps.at(-1);if(last&&last.kind===kind){last.end=t1;last.energyEnd=energy;}else steps.push({kind,start:t0,end:t1,energyStart,energyEnd:energy});
   const band=earthBands.at(-1);if(band&&band.visible===earth)band.end=t1;else earthBands.push({start:t0,end:t1,visible:earth});
   if(earth)earthHours+=dt;
   samples.push({time:t1,battery:energy/VEHICLE.capacityWh*100,earth});
  }
 }
 const hours=rows.at(-1).time,stops=steps.filter(s=>s.kind!=='drive'&&s.energyEnd>s.energyStart+.01),total=hours||1;
 const batteryPath=samples.map((s,i)=>(i?'L':'M')+(8+s.time/total*584).toFixed(2)+' '+(110-s.battery).toFixed(2)).join('');
 return {reachable:true,rows,steps,samples,earthBands,hours,chargeStops:stops.length,chargeHours:stops.reduce((s,v)=>s+v.end-v.start,0),earthFraction:hours?earthHours/hours:sky(rows[0].cell,q.start).earth,batteryPath,incomplete:r.incomplete,start:q.start};
}
export async function rankSpots(q,sky,progress=()=>{},cancelled=()=>false){
 const count=Math.ceil((q.end-q.start)/3600000),rows=[],sum=Math.max(1,q.weights.reduce((a,b)=>a+b,0));
 for(let cell=0;cell<q.N*q.N;cell++){
  if(q.slope[cell]<=15){let sun=0,earth=0,night=0,longest=0;
   for(let i=0;i<count;i++){const p=sky(cell,q.start+i*3600000);if(p.sun>q.threshold){sun++;night=0;}else longest=Math.max(longest,++night);if(p.earth>q.threshold)earth++;}
   const sf=sun/count,ef=earth/count,score=(q.weights[0]*sf+q.weights[1]*ef+q.weights[2]*(1-longest/count))/sum;
   rows.push({cell,i:cell%q.N,j:Math.floor(cell/q.N),...q.points[cell],sun:sf,earth:ef,darkHours:longest,score,slope:q.slope[cell]});
  }
  if(cell%16===0){progress((cell+1)/(q.N*q.N));await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())return null;}
 }
 return rows.sort((a,b)=>b.score-a.score||a.darkHours-b.darkHours||a.slope-b.slope||a.cell-b.cell).slice(0,5);
}
export function travelContours(T,N,maxHours){
 const lines=[];for(const level of [24,48,120,240,480]){if(level>maxHours)continue;
 for(let y=0;y<N-1;y++)for(let x=0;x<N-1;x++){
  const corners=[[x,y],[x+1,y],[x+1,y+1],[x,y+1]],values=corners.map(([i,j])=>T[j*N+i]);if(values.some(v=>!Number.isFinite(v)))continue;
  const hits=[];for(let e=0;e<4;e++){const a=values[e],b=values[(e+1)%4];if((a<level)!==(b<level)){const f=(level-a)/(b-a),p=corners[e],q=corners[(e+1)%4];hits.push([p[0]+(q[0]-p[0])*f,p[1]+(q[1]-p[1])*f]);}}
  for(let h=1;h<hits.length;h+=2)lines.push({hours:level,a:hits[h-1],b:hits[h]});
 }}return lines;
}
export function tripCSV(plan){const fields=['utc','action','east_km_from_grid_center','north_km_from_grid_center','latitude_deg','longitude_deg','battery_pct'];return fields.join(',')+'\n'+plan.rows.map((r,i)=>[new Date(plan.start+r.time*3600000).toISOString(),i&&r.cell!==plan.rows[i-1].cell?'Drive':'Wait',(r.i-15)*16/30,(r.j-15)*16/30,r.lat,r.lon,r.energyWh/VEHICLE.capacityWh*100].map(x=>JSON.stringify(x)).join(',')).join('\n');}
