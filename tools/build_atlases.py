"""Precompute real 300 km horizons on a 31x31 local grid, for 2/10/20 m.
The map/routing grid is intentionally distinct from the 481x481 display grid.
"""
import build_science as b
import numpy as np,json,time
N=31;B=72;heights=[2,10,20];dist=np.unique(np.r_[np.arange(20,1000,40),np.geomspace(1000,300000,100)]);ang=dist/b.R
for site in b.catalog:
 path=b.OUT/'sites'/site['key'];meta=json.loads((path/'meta.json').read_text())
 if (path/'horizon-atlas.f32').exists():continue
 t=time.perf_counter();v=b.local_vectors(site,N);h=b.sample(v);x,y,lat,lon=b.projection(v);east=np.stack([-np.sin(lon),np.cos(lon),lon*0],-1);north=np.cross(v,east)
 out=np.zeros((3,N,N,B),dtype='<f4')
 for ai in range(B):
  az=ai/B*2*np.pi;d=east*np.sin(az)+north*np.cos(az);q=v[:,:,None,:]*np.cos(ang)[None,None,:,None]+d[:,:,None,:]*np.sin(ang)[None,None,:,None];hh=b.sample(q)
  hor=(b.R+hh)*np.sin(ang)[None,None,:];vertical=(b.R+hh)*np.cos(ang)[None,None,:]-(b.R+h[:,:,None])
  for k,height in enumerate(heights):out[k,:,:,ai]=np.degrees(np.arctan2(vertical-height,hor)).max(axis=2)
 out.tofile(path/'horizon-atlas.f32');meta['atlas']={'file':'horizon-atlas.f32','N':N,'azimuth_bins':B,'azimuth_step_deg':5,'cell_m':16000/(N-1),'heights_m':heights,'layout':'height index, row south-to-north, column west-to-east, azimuth north-clockwise','ray_extent_m':300000,'limits':'Finite radial/azimuth sampling can miss narrow obstacles; interpolated between atlas cells.'};(path/'meta.json').write_text(json.dumps(meta,indent=2));print('Atlas',site['key'],round(time.perf_counter()-t,1),'s',flush=True)
