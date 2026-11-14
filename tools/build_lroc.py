"""Reproject official LROC 100 m WAC summer browse tiles onto the site grids.
The source is an observation mosaic with baked acquisition shadows, not albedo.
Pixel origin follows the 28786-square south-polar stereographic 100 m product.
"""
from pathlib import Path
import json,math,urllib.request,hashlib,concurrent.futures
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent;OUT=ROOT/'public/data';CACHE=ROOT/'../../work/science/lroc-tiles';CACHE.mkdir(parents=True,exist_ok=True)
R=1737400.;DEG=np.pi/180;W=28786;PX=100.;EXT=W*PX/2
URL='https://data.lroc.im-ldi.com/ptif/zoomify/ser/estore/lroc/web/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/BROWSE/WAC_ROI/WAC_ROI_SOUTH_SUMMER/WAC_ROI_SOUTH_SUMMER_100M.PYR.TIF/'
catalog=json.loads((OUT/'catalog.json').read_text());grids={};needed=set()
for site in catalog:
 a,b=site['lat']*DEG,site['lon']*DEG;u=np.array([np.cos(a)*np.cos(b),np.cos(a)*np.sin(b),np.sin(a)]);e=np.array([-np.sin(b),np.cos(b),0]);n=np.array([-np.sin(a)*np.cos(b),-np.sin(a)*np.sin(b),np.cos(a)])
 # Image row 0 north; pixel centres cover the 16 km surface, GL texture maps edges consistently.
 x,y=np.meshgrid(np.linspace(-8000,8000,512),np.linspace(8000,-8000,512));q=(x*x+y*y)/(4*R*R);v=(u*(1-q)[...,None]+e*(x/R)[...,None]+n*(y/R)[...,None])/(1+q)[...,None];lat=np.arcsin(v[...,2]);lon=np.arctan2(v[...,1],v[...,0]);rho=2*R*np.tan((np.pi/2+lat)/2);c=(rho*np.sin(lon)+EXT)/PX-.5;r=(EXT-rho*np.cos(lon))/PX-.5;grids[site['key']]=(c,r)
 for tx in range(int(np.floor(c.min()/256)),int(np.floor(c.max()/256))+1):
  for ty in range(int(np.floor(r.min()/256)),int(np.floor(r.max()/256))+1):needed.add((tx,ty))
tiers=[math.ceil(W/(2**(7-z))/256) for z in range(7)];offset=sum(t*t for t in tiers)
def get_tile(t):
 x,y=t;p=CACHE/f'7-{x}-{y}.jpg';group=(offset+y*113+x)//256;url=URL+f'TileGroup{group}/7-{x}-{y}.jpg'
 if not p.exists():
  with urllib.request.urlopen(url,timeout=45) as response:p.write_bytes(response.read())
 a=np.asarray(Image.open(p).convert('L'));return t,a,{'url':url,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:tiles=list(pool.map(get_tile,sorted(needed)))
tilemap={t:a for t,a,s in tiles};sources=[s for t,a,s in tiles]
for key,(c,r) in grids.items():
 i=np.floor(c).astype(int);j=np.floor(r).astype(int);wi=c-i;wj=r-j
 def sample(ii,jj):
  z=np.zeros(ii.shape,dtype=float)
  for t,a in tilemap.items():
   hit=(ii//256==t[0])&(jj//256==t[1]);z[hit]=a[jj[hit]%256,ii[hit]%256]
  return z
 z=(sample(i,j)*(1-wi)+sample(i+1,j)*wi)*(1-wj)+(sample(i,j+1)*(1-wi)+sample(i+1,j+1)*wi)*wj
 dest=OUT/'sites'/key;Image.fromarray(np.round(z).astype('u1')).save(dest/'lroc-wac.png')
 m=json.loads((dest/'meta.json').read_text());m['imagery']={'file':'lroc-wac.png','product':'WAC_ROI_SOUTH_SUMMER_100M','source':'https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_ROI_SOUTH_SUMMER','resolution_m':100,'projection':'South polar stereographic, sphere 1737400 m, central longitude 0; image origin upper-left -1439300,+1439300 m; 28786 square pixels','mapping_note':'Product map spacing and symmetric polar bounds; visual geographic control check required for subpixel registration.','meaning':'Actual LROC observation mosaic acquired 2010-09-21 to 2010-10-23; fixed acquisition shadows, not a radiometrically corrected albedo product','citation':'Speyerer et al. (2020), LSSW abstract 5132, https://www.hou.usra.edu/meetings/lunarsurface2020/pdf/5132.pdf'};(dest/'meta.json').write_text(json.dumps(m,indent=2));print(key,'LROC image prepared',flush=True)
(OUT/'lroc-tile-provenance.json').write_text(json.dumps({'product_url':'https://data.lroc.im-ldi.com/lroc/view_rdr_product/WAC_ROI_SOUTH_SUMMER_100M','tiles':sources},indent=2))
