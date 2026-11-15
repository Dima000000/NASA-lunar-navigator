"""Build compact, reproducible delivery files from the authoritative prepared arrays.

Research originals are retained separately. Compression of floats is lossless;
Uint16 DEM quantization is audited and not used in the scientific computations.
"""
from pathlib import Path
import gzip, hashlib, json
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
files = {e['path']:{'bytes':e['bytes'],'sha256':e['sha256']} for e in json.loads((ROOT/'tools/science-inputs.json').read_text(encoding='utf-8'))['files']}
def save(name, data):
    name=Path(name).as_posix()
    p=DATA/name; p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    files[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def packed(name, data):
    name=Path(name).as_posix()
    save(name,gzip.compress(data,compresslevel=9,mtime=0));files[name]['decodedBytes']=len(data);files[name]['decodedSha256']=hashlib.sha256(data).hexdigest()
def encoded_resize(source, target, size):
    # Decode heights before resampling; interpolating encoded RGB corrupts carries.
    a=np.asarray(Image.open(DATA/source).convert('RGB'),dtype=np.uint16)
    h=(a[:,:,0]*256+a[:,:,1]).astype(np.float32)*.5-10000
    h=np.asarray(Image.fromarray(h).resize(size,Image.Resampling.BILINEAR))
    q=np.clip(np.rint((h+10000)*2),0,65535).astype(np.uint16)
    rgb=np.zeros((*q.shape,3),dtype=np.uint8);rgb[:,:,0]=q>>8;rgb[:,:,1]=q&255
    p=DATA/target;p.parent.mkdir(parents=True,exist_ok=True);Image.fromarray(rgb).save(p,optimize=True)
    files[target]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}

encoded_resize('moon_dem_4k.png','overview/global.png',(512,256))
encoded_resize('sp_dem_L0.png','overview/polar.png',(512,512))
p=DATA/'overview/color.jpg';Image.open(DATA/'moon_color_4k.jpg').convert('RGB').resize((1024,512),Image.Resampling.LANCZOS).save(p,quality=85,optimize=True)
files['overview/color.jpg']={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
meta=json.loads((DATA/'ephem.json').read_text()); ephem=np.fromfile(DATA/'ephem.bin',dtype='<f4').reshape(-1,8)
from datetime import datetime,timezone
first=datetime.fromisoformat(meta['t0_utc'].replace('Z','+00:00'))
years={}
for year in range(2024,2036):
    start=datetime(year,1,1,tzinfo=timezone.utc);end=datetime(year+1,1,1,tzinfo=timezone.utc)
    a=int((start-first).total_seconds()/3600);b=int((end-first).total_seconds()/3600)+1
    name=f'ephem/{year}.bin.gz';packed(name,ephem[a:b].astype('<f4').tobytes())
    years[str(year)]={**meta,'t0_utc':start.isoformat().replace('+00:00','Z'),'count':b-a,'file':name}
save('ephem/manifest.json',json.dumps(years,separators=(',',':')).encode())
for site in json.loads((DATA/'catalog.json').read_text()):
    base=Path('sites')/site['key']; h=np.fromfile(DATA/base/'dem.f32',dtype='<f4')
    # Exact prepared floats remain the science source, preserving CSV byte-for-byte.
    packed(str(base/'dem.f32.gz'),h.astype('<f4').tobytes())
    packed(str(base/'horizon-atlas.f32.gz'),(DATA/base/'horizon-atlas.f32').read_bytes())
    packed(str(base/'psr.u8.gz'),(DATA/base/'psr.u8').read_bytes())
    offset=float(np.floor(h.min()));step=max(.1,float(np.ceil((float(h.max())-offset)/65535*10)/10))
    source=h.astype(np.float64);q=np.rint((source-offset)/step); assert q.min()>=0 and q.max()<=65535
    packed(str(base/'height.u16.gz'),q.astype('<u2').tobytes())
    save(str(base/'height.json'),json.dumps({'base':offset,'step':step,'N':481,'max_error_m':float(np.max(np.abs(offset+q*step-source))),'role':'Optional display-only quantization; science uses losslessly packed float32.'}).encode())
    p=DATA/base/'lroc-wac.jpg';Image.open(DATA/base/'lroc-wac.png').convert('L').save(p,quality=90,optimize=True)
    files[(base/'lroc-wac.jpg').as_posix()]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
# Verification badge is a small runtime status, not a downloaded research report.
save('verification-status.json',json.dumps(json.loads((ROOT/'public/research/verification-status.json').read_text(encoding='utf-8')),separators=(',',':')).encode())
for p in DATA.rglob('*.json'):
    name=p.relative_to(DATA).as_posix()
    if name not in ('delivery-manifest.json','checksums.json'):files[name]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
save('delivery-manifest.json',json.dumps({'format':1,'files':files},indent=2).encode())
print(json.dumps({'delivery_files':len(files),'overview_bytes':sum(v['bytes'] for k,v in files.items() if k.startswith('overview/')),'year_2026_bytes':files['ephem/2026.bin.gz']['bytes']}))
