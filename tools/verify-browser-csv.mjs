import fs from 'node:fs';
const root=new URL('../public/research/',import.meta.url);
const parse=text=>text.trim().split(/\r?\n/).map(line=>{const fields=[];let field='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){fields.push(field);field=''}else field+=c;}fields.push(field);return fields;});
const records=name=>{const [head,...rows]=parse(fs.readFileSync(new URL(name,root),'utf8'));return rows.map(r=>Object.fromEntries(head.map((k,i)=>[k,r[i]])))};
const browser=records('browser-export.csv'),reference=records('horizons-month-comparison.csv'),catalog=JSON.parse(fs.readFileSync(new URL('../data/catalog.json',root),'utf8'));
const byName=new Map(catalog.map(s=>[s.name,s.key])),index=new Map(browser.map(r=>[byName.get(r.site)+'|'+new Date(r.time_utc).toISOString(),r]));
let maxEl=0,maxAz=0,count=0;const output=['site,time_utc,body,browser_csv_el_deg,horizons_el_deg,delta_el_deg,browser_csv_az_deg,horizons_az_deg,delta_az_deg'];
for(const r of reference){const v=index.get(r.site+'|'+new Date(r.utc).toISOString());if(!v)throw Error('Missing actual browser export row: '+r.site+' '+r.utc);const el=+v[r.body+'_el_deg'],az=+v[r.body+'_az_deg'],de=el-r.horizons_el,da=((az-r.horizons_az+540)%360)-180;maxEl=Math.max(maxEl,Math.abs(de));maxAz=Math.max(maxAz,Math.abs(da));output.push([r.site,r.utc,r.body,el,r.horizons_el,de,az,r.horizons_az,da].join(','));count++;}
if(count!==4326||maxEl>.1||maxAz>.1)throw Error('Browser CSV comparison failed');
fs.writeFileSync(new URL('browser-vs-horizons.csv',root),output.join('\n'));
const summary={samples:count,maxElevationErrorDeg:maxEl,maxAzimuthErrorDeg:maxAz,precision:'Website CSV exports 0.001 degree, so rounding dominates the difference',passed:true};fs.writeFileSync(new URL('browser-vs-horizons.json',root),JSON.stringify(summary,null,2));console.log(summary);
