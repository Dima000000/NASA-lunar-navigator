"""Prepare traceable, static per-site products from bundled NASA-derived rasters.
No synthetic terrain. NumPy + Pillow. CPU metres/radians; engine receives kilometres.
"""
from pathlib import Path
import json,math,csv,hashlib,shutil,time
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent; OUT=ROOT/'public/data'; SRC=OUT if (OUT/'moon_dem_4k.png').exists() else ROOT/'data'; OUT.mkdir(parents=True,exist_ok=True)
R=1737400.; DEG=np.pi/180
def decode(name,scale=.5,offset=-10000):
 a=np.asarray(Image.open(SRC/name)).astype(np.float64);return(a[:,:,0]*256+a[:,:,1])*scale+offset
global_dem=decode('moon_dem_4k.png');lo=decode('sp_dem_L0.png');hi=decode('sp_dem_L1.png');psr=np.asarray(Image.open(SRC/'psr.png'))
if psr.ndim==3:psr=psr[:,:,0]
pm=json.loads((SRC/'patches.json').read_text(encoding='utf-8-sig'));patches=[]
def basis(lat,lon):
 p,l=lat*DEG,lon*DEG;return np.array([np.cos(p)*np.cos(l),np.cos(p)*np.sin(l),np.sin(p)]),np.array([-np.sin(l),np.cos(l),0]),np.array([-np.sin(p)*np.cos(l),-np.sin(p)*np.sin(l),np.cos(p)])
for p in pm['patches']:
 if p.get('kind')=='crest20':patches.append((p,decode(p['file'],p['height_scale_m'],p['height_offset_m']),basis(p['lat'],p['lon'])))
def bil(a,c,r,wrap=False):
 r=np.clip(r,0,a.shape[0]-1);c=c%a.shape[1] if wrap else np.clip(c,0,a.shape[1]-1);i=np.floor(c).astype(int);j=np.floor(r).astype(int);u=c-i;v=r-j;i1=(i+1)%a.shape[1] if wrap else np.minimum(i+1,a.shape[1]-1);j1=np.minimum(j+1,a.shape[0]-1)
 return(a[j,i]*(1-u)+a[j,i1]*u)*(1-v)+(a[j1,i]*(1-u)+a[j1,i1]*u)*v
def projection(v):
 lat=np.arcsin(np.clip(v[...,2],-1,1));lon=np.arctan2(v[...,1],v[...,0]);rho=2*R*np.tan((np.pi/2+lat)/2);return rho*np.sin(lon),rho*np.cos(lon),lat,lon
def sample(v):
 x,y,lat,lon=projection(v);h=bil(global_dem,(lon+np.pi)/(2*np.pi)*global_dem.shape[1]-.5,(np.pi/2-lat)/np.pi*global_dem.shape[0]-.5,True)
 for a,ext,cell in [(lo,304000,296.875),(hi,163840,80)]:
  z=bil(a,(x+ext)/cell-.5,(ext-y)/cell-.5);h=np.where((abs(x)<ext-cell)&(abs(y)<ext-cell),z,h)
 for p,a,(u,e,n) in patches:
  den=np.maximum(1+v@u,1e-12);xx=2*R*(v@e)/den;yy=2*R*(v@n)/den;ext=p['size']*p['pixel_m']/2
  z=bil(a,(xx+ext)/p['pixel_m']-.5,(ext-yy)/p['pixel_m']-.5);h=np.where((abs(xx)<ext-p['pixel_m'])&(abs(yy)<ext-p['pixel_m']),z,h)
 return h
def local_vectors(site,N):
 u,e,n=basis(site['lat'],site['lon']);xs=np.linspace(-8000,8000,N);x,y=np.meshgrid(xs,xs);q=(x*x+y*y)/(4*R*R);k=1/(1+q);v=u*(1-q)[...,None]*k[...,None]+e*(x/R)[...,None]*k[...,None]+n*(y/R)[...,None]*k[...,None];return v
def mask_for(v):
 x,y,_,_=projection(v);i=np.floor((x+304000)/296.875).astype(int);j=np.floor((304000-y)/296.875).astype(int);ok=(i>=0)&(i<2048)&(j>=0)&(j<2048);return np.where(ok,psr[np.clip(j,0,2047),np.clip(i,0,2047)]>=128,False).astype('u1')
def horizon(site,heights=(2,10,20),step=.5,min_dist=20):
 u,e,n=basis(site['lat'],site['lon']);ground=float(sample(u));az=np.arange(0,360,step)*DEG;dirs=e*np.sin(az)[:,None]+n*np.cos(az)[:,None];s=np.unique(np.r_[np.arange(min_dist,1000,20),np.geomspace(1000,300000,180)]);ang=s/R
 v=u*np.cos(ang)[None,:,None]+dirs[:,None,:]*np.sin(ang)[None,:,None];hh=sample(v);horizontal=(R+hh)*np.sin(ang)[None,:]
 return {h:np.degrees(np.arctan2((R+hh)*np.cos(ang)[None,:]-(R+ground+h),horizontal)).max(axis=1) for h in heights}
DLR='https://elib.dlr.de/94242/1/EPSC2014-136-1.pdf';ARTICLE='https://doi.org/10.1029/2025JE009434';NASA='https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/'
# The Shackleton point below is the measured maximum within the supplied 20 m crop, not an official NASA landing coordinate.
sp,sa,sb=next(t for t in patches if t[0]['id']=='shackleton-rim');j,i=np.unravel_index(np.argmax(sa),sa.shape);xx=(i+.5-sp['size']/2)*20;yy=(sp['size']/2-j-.5)*20;q=(xx*xx+yy*yy)/(4*R*R);sv=(sb[0]*(1-q)+sb[1]*xx/R+sb[2]*yy/R)/(1+q);slat=np.degrees(np.arcsin(sv[2]));slon=np.degrees(np.arctan2(sv[1],sv[0]))
catalog=[
 {'key':'cr','name':'Connecting Ridge · Gläser spot 2','lat':-89.4399,'lon':-137.1476,'source':DLR,'coordinate_role':'Published study point, not NASA-selected landing point'},
 {'key':'shackleton','name':'Shackleton rim · DEM crest','lat':float(slat),'lon':float(slon),'source':'https://pgda.gsfc.nasa.gov/products/90','coordinate_role':'Maximum-height pixel inside the supplied Shackleton rim 20 m crop; DEM-derived, not an official landing point'},
 {'key':'sdg','name':'de Gerlache rim 2 · dGR201','lat':-88.389,'lon':-68.865,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1; historical NASA 2024 candidate region'},
 {'key':'mal','name':'Mons Malapert · MMA_K2023','lat':-85.992,'lon':2.056,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1; historical NASA 2024 candidate region'},
 {'key':'lbp','name':'Mons Mouton · MMO01','lat':-85.416,'lon':31.851,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1; replaces approximate Leibnitz-beta-area navigation point, not a claim that the names are identical'},
 {'key':'mmp','name':'Mons Mouton Plateau · MMP01','lat':-85.111,'lon':26.710,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'haw','name':'Haworth · HW06','lat':-87.05,'lon':-24.24,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'nob1','name':'Nobile Rim 1 · NR101','lat':-85.295,'lon':36.917,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'nob2','name':'Nobile Rim 2 · NR201','lat':-84.054,'lon':56.481,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'cabeus','name':'Peak near Cabeus B · PCB01','lat':-83.763,'lon':-69.983,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'slater','name':'Slater Plain · SP01','lat':-87.478,'lon':124.521,'source':ARTICLE,'coordinate_role':'Published representative CLS, Table A1'},
 {'key':'cr10','name':'Connecting Ridge · Gläser spot 4','lat':-89.4544,'lon':-137.1555,'source':DLR,'coordinate_role':'Published 10 m study point, not NASA-selected landing point'}]
for site in catalog:
 site.update(approx=False,region_catalog_source=NASA,region_catalog_date='2024-10-28',status='Research comparison point; not an approved or current Artemis III landing site')
dest=OUT/'sites';dest.mkdir(exist_ok=True)
for site in catalog:
 path=dest/site['key'];path.mkdir(exist_ok=True)
 if (path/'meta.json').exists():continue
 t=time.perf_counter();v=local_vectors(site,481);z=sample(v);center=float(sample(basis(site['lat'],site['lon'])[0]));rel=(z-center).astype('<f4');rel.tofile(path/'dem.f32');mask=mask_for(v);mask.tofile(path/'psr.u8')
 hz=horizon(site)
 for height,data in hz.items():(path/f'horizon_h{height}.json').write_text(json.dumps({'step_deg':.5,'observer_height_m':height,'ray_extent_m':300000,'elev_deg':data.tolist(),'source':'Measured LOLA-derived terrain; 20/80/297 m chain then coarse global terrain; finite radial sampling'},separators=(',',':')))
 meta={**site,'N':481,'L_km':16,'cell_m':16000/480,'height_units':'m relative to centre pixel','center_height_m':center,'grid':'row 0 south, column 0 west; local stereographic x east, y north','projection':'site-centred stereographic on R=1737400 m sphere','radius_m':R,'source_dem':'NASA LOLA LDEM_80S_80MPP_ADJ.TIF + four 20 m crops','data_provenance':'Measured NASA-derived products; see PROVENANCE.md and direct-source-audit.json for the current delivery audit','source_resolution_m':'20 m within four crest crops, 80 m central polar square, 297 m outer polar overview; the 33.33 m display spacing does not add measured detail','psr_source':'LRO/LOLA LPSR_75S_120M_201608.TIF; derivative majority mask at 296.875 m. Not an ice detection.','horizon':{'azimuth_step_deg':.5,'ray_extent_m':300000,'minimum_distance_m':20,'heights_m':[2,10,20]},'dem_sha256':hashlib.sha256(rel.tobytes()).hexdigest()}
 (path/'meta.json').write_text(json.dumps(meta,indent=2));print(site['key'],'prepared',round(time.perf_counter()-t,2),'s',flush=True)
(OUT/'catalog.json').write_text(json.dumps(catalog,indent=2))
for file in SRC.iterdir():
 if file.is_file() and file.suffix in ['.png','.jpg','.bin','.json','.md'] and file.resolve()!=(OUT/file.name).resolve():shutil.copyfile(file,OUT/file.name)
print('Site products prepared.',flush=True)
