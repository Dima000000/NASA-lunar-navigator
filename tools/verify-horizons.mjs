// Fresh independent topocentric comparison, using the same Ephemeris.topo as the website's CSV.
import fs from 'node:fs';
import {Ephemeris} from '../app/science-core.mjs';
const root=new URL('../',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,root))),buf=fs.readFileSync(new URL('public/data/ephem.bin',root)),ephem=new Ephemeris(new Float32Array(buf.buffer,buf.byteOffset,buf.byteLength/4),read('public/data/ephem.json'));
const period={start:'2026-11-14',end:'2026-12-14',step:'1 h'},start=Date.parse(period.start),end=Date.parse(period.end),rows=[],raw=new URL('public/research/horizons-raw/',root);fs.mkdirSync(raw,{recursive:true});
for(const key of ['cr','shackleton','sdg']){
 const site=read(`public/data/sites/${key}/meta.json`),h=(site.center_height_m+2)/1000;
 for(const [body,cmd] of [['sun','10'],['earth','399']]){
  const params={format:'json',COMMAND:cmd,OBJ_DATA:'NO',MAKE_EPHEM:'YES',EPHEM_TYPE:'OBSERVER',CENTER:'coord@301',COORD_TYPE:'GEODETIC',SITE_COORD:`${site.lon},${site.lat},${h}`,START_TIME:period.start,STOP_TIME:period.end,STEP_SIZE:'1 h',QUANTITIES:'4',ANG_FORMAT:'DEG',APPARENT:'AIRLESS',EXTRA_PREC:'YES',CSV_FORMAT:'YES'};
  const url='https://ssd.jpl.nasa.gov/api/horizons.api?'+new URLSearchParams(Object.entries(params).map(([k,v])=>[k,k==='format'?v:`'${v}'`]));
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`JPL HTTP ${response.status}`);const result=await response.json();if(result.error)throw Error(result.error);fs.writeFileSync(new URL(`${key}-${body}.json`,raw),JSON.stringify({url,retrieved:new Date().toISOString(),...result},null,2));
  const data=result.result.split('$$SOE')[1]?.split('$$EOE')[0];if(!data)throw Error('JPL response has no ephemeris');const lines=data.trim().split('\n');if(lines.length!==(end-start)/3600000+1)throw Error('JPL sample count mismatch');
  for(let i=0;i<lines.length;i++){const fields=lines[i].split(',').map(s=>s.trim()),az=Number(fields[3]),el=Number(fields[4]);if(!Number.isFinite(az)||!Number.isFinite(el))throw Error('Unexpected JPL CSV schema: '+lines[i]);const ms=start+i*3600000,p=ephem.topo(ephem.state(ms),site.lat,site.lon,h)[body];rows.push({site:key,utc:new Date(ms).toISOString(),body,lat:site.lat,lon:site.lon,absolute_height_km:h,model_az:p.az,horizons_az:az,delta_az:((p.az-az+540)%360)-180,model_el:p.el,horizons_el:el,delta_el:p.el-el})}
 }
}
const maxEl=Math.max(...rows.map(r=>Math.abs(r.delta_el))),maxAz=Math.max(...rows.map(r=>Math.abs(r.delta_az))),passed=maxEl<=.1&&maxAz<=.1;
const columns=Object.keys(rows[0]);fs.writeFileSync(new URL('public/research/horizons-month-comparison.csv',root),columns.join(',')+'\n'+rows.map(r=>columns.map(c=>JSON.stringify(r[c])).join(',')).join('\n'));
const result={horizonsMonthVerified:passed,period,sites:3,samples:rows.length,maxElevationErrorDeg:maxEl,maxAzimuthErrorDeg:maxAz,retrieved:new Date().toISOString(),reference:'Fresh NASA JPL Horizons observer tables, quantity 4; geometric terrain horizon is not part of this sky-direction check.'};fs.writeFileSync(new URL('public/research/verification-status.json',root),JSON.stringify(result,null,2));console.log(result);if(!passed)process.exitCode=1;
