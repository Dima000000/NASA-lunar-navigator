"""Rebuild the runtime scientific inputs directly from authoritative archives.
Run in CI where NASA archive HTTPS is reachable. No terrain synthesis or mirror inputs.
"""
from pathlib import Path
import os,json,hashlib,urllib.request,datetime,math
import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import reproject,Resampling
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as window_bounds
from rasterio.crs import CRS
import spiceypy as spice

ROOT=Path(__file__).resolve().parent.parent;OUT=ROOT/'public/data';WORK=ROOT/'work/nasa-originals';WORK.mkdir(parents=True,exist_ok=True)
R=1737400.;D=np.pi/180;record=[]
def download(url):
 target=WORK/url.rsplit('/',1)[-1]
 if not target.exists():
  print('Downloading',url,flush=True)
  with urllib.request.urlopen(url,timeout=180) as response, target.open('wb') as f:
   while block:=response.read(1024*1024):f.write(block)
 record.append({'url':url,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size})
 return target
def encode(h,name,scale=.5,offset=-10000):
 if not np.isfinite(h).all():raise ValueError('Non-finite measured heights: '+name)
 q=np.rint((h-offset)/scale)
 if q.min()<0 or q.max()>65535:raise ValueError('Height encoding would clip: '+name)
 q=q.astype('u2');rgb=np.zeros((*q.shape,3),dtype='u1');rgb[:,:,0]=q>>8;rgb[:,:,1]=q&255;Image.fromarray(rgb).save(OUT/name)
def warp_band(src,bounds,N,crs=None,method=Resampling.bilinear):
 out=np.full((N,N),np.nan,dtype='float32');reproject(rasterio.band(src,1),out,src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,dst_transform=from_bounds(*bounds,N,N),dst_crs=crs or src.crs,dst_nodata=np.nan,resampling=method,num_threads=2);return out

# 80 m source is 181 MB, substantially smaller than the 20 m COG.
url80='https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF'
source80=download(url80)
with rasterio.open(source80) as src:
 print('LOLA source CRS/bounds',src.crs,src.bounds,flush=True)
 encode(warp_band(src,(-304000,-304000,304000,304000),2048,method=Resampling.average),'sp_dem_L0.png')
 encode(warp_band(src,(-163840,-163840,163840,163840),4096),'sp_dem_L1.png')

# Fetch only required windows of the official cloud-optimized 20 m DEM.
url20='https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF'
patches=json.loads((OUT/'patches.json').read_text())
with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.TIF',GDAL_HTTP_TIMEOUT='120',GDAL_HTTP_MAX_RETRY='3',VSI_CACHE=True):
 with rasterio.open('/vsicurl/'+url20) as src:
  for p in patches['patches']:
   if p.get('kind')!='crest20':continue
   lat,lon=p['lat']*D,p['lon']*D;u=np.array([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)]);e=np.array([-np.sin(lon),np.cos(lon),0]);n=np.cross(u,e)
   x,y=np.meshgrid(np.linspace(-5500,5500,9),np.linspace(-5500,5500,9));q=(x*x+y*y)/(4*R*R);v=(u*(1-q)[...,None]+e*(x/R)[...,None]+n*(y/R)[...,None])/(1+q)[...,None];a=np.arcsin(v[...,2]);b=np.arctan2(v[...,1],v[...,0]);rho=2*R*np.tan((np.pi/2+a)/2);px=rho*np.sin(b);py=rho*np.cos(b)
   win=window_bounds(float(px.min()-100),float(py.min()-100),float(px.max()+100),float(py.max()+100),src.transform).round_offsets().round_lengths();a=src.read(1,window=win);dst=np.full((512,512),np.nan,'float32');local=CRS.from_string(f'+proj=stere +lat_0={p["lat"]} +lon_0={p["lon"]} +k=1 +a={R} +b={R} +units=m +no_defs')
   reproject(a,dst,src_transform=src.window_transform(win),src_crs=src.crs,src_nodata=src.nodata,dst_transform=from_bounds(-5120,-5120,5120,5120,512,512),dst_crs=local,dst_nodata=np.nan,resampling=Resampling.bilinear)
   offset=float(np.floor(dst.min())-1);encode(dst,p['file'],.1,offset);p.update(height_scale_m=.1,height_offset_m=offset,min_m=float(dst.min()),max_m=float(dst.max()),source=url20,data_delivery='Direct authoritative NASA COG window reprojection')
   record.append({'url':url20,'window':list(map(float,[win.col_off,win.row_off,win.width,win.height])),'window_array_sha256':hashlib.sha256(a.tobytes()).hexdigest(),'output':p['file']});print('20 m crop',p['id'],flush=True)
(OUT/'patches.json').write_text(json.dumps(patches,indent=2))

psr=download('https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_75S_120M_201608.TIF')
with rasterio.open(psr) as src:
 raw=src.read(1).astype('float32');valid=raw!=src.nodata;mask=np.where(valid,raw*2.5e-5+.5,np.nan).astype('float32');out=np.full((2048,2048),np.nan,'float32')
 reproject(mask,out,src_transform=src.transform,src_crs=src.crs,src_nodata=np.nan,dst_transform=from_bounds(-304000,-304000,304000,304000,2048,2048),dst_crs=src.crs,dst_nodata=np.nan,resampling=Resampling.average)
 if not np.isfinite(out).all():raise ValueError('Incomplete official PSR coverage')
 Image.fromarray(np.uint8(out>=.5)*255).save(OUT/'psr.png')

dem=download('https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif')
h=np.asarray(Image.open(dem),dtype='float32')*1000
h=np.asarray(Image.fromarray(h).resize((4096,2048),Image.Resampling.BILINEAR));encode(h,'moon_dem_4k.png')
color=download('https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif');Image.open(color).convert('RGB').save(OUT/'moon_color_4k.jpg',quality=94)

base='https://naif.jpl.nasa.gov/pub/naif/generic_kernels/'
kernels=['lsk/naif0012.tls','pck/pck00011.tpc','spk/planets/de440s.bsp','pck/moon_pa_de440_200625.bpc','fk/satellites/moon_de440_250416.tf']
for kernel in kernels:spice.furnsh(str(download(base+kernel)))
meta=json.loads((OUT/'ephem.json').read_text());start=datetime.datetime.fromisoformat(meta['t0_utc'].replace('Z','+00:00'));vectors=np.zeros((meta['count'],8),dtype='<f4')
for i in range(meta['count']):
 utc=(start+datetime.timedelta(seconds=i*meta['step_s'])).strftime('%Y-%m-%dT%H:%M:%S');et=spice.str2et(utc)
 for body,k in [('SUN',0),('EARTH',4)]:
  v,_=spice.spkpos(body,et,'MOON_ME','LT+S','MOON');dist=np.linalg.norm(v);vectors[i,k:k+3]=v/dist;vectors[i,k+3]=dist
 if i%20000==0:print('SPICE hourly records',i,flush=True)
vectors.tofile(OUT/'ephem.bin');meta['delivery']='Rebuilt directly from NASA JPL NAIF kernels';(OUT/'ephem.json').write_text(json.dumps(meta,indent=2))
globe=json.loads((OUT/'globe.json').read_text());globe['dem']['quantum_m']=.5;globe['dem']['min_m']=float(h.min());globe['dem']['max_m']=float(h.max());globe['delivery']='Direct NASA SVS archive download and documented resampling';(OUT/'globe.json').write_text(json.dumps(globe,indent=2))
sp=json.loads((OUT/'sp_meta.json').read_text());sp['source']['product']='NASA GSFC PGDA product 90';sp['source']['delivery']='Direct authoritative NASA download';(OUT/'sp_meta.json').write_text(json.dumps(sp,indent=2))
audit={'complete':True,'generated':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':record,'method':'Direct NASA downloads and official LROC service; COG window reprojection, metric heights, visible numeric encodings. No third-party mirror runtime arrays used.'};(OUT/'direct-source-audit.json').write_text(json.dumps(audit,indent=2))
print('Authoritative runtime input rebuild complete.',flush=True)
