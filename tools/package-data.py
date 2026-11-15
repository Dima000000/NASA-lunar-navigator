"""Create a data release asset without adding scientific binaries to Git history."""
from pathlib import Path
import hashlib,json,tarfile
ROOT=Path(__file__).resolve().parents[1];manifest=json.loads((ROOT/'tools/science-inputs.json').read_text(encoding='utf-8'));out=ROOT/'.data-cache/authoritative-data.tar.gz';out.parent.mkdir(exist_ok=True)
with tarfile.open(out,'w:gz') as z:
    for e in manifest['files']:
        p=ROOT/'public/data'/e['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==e['sha256'];z.add(p,arcname='data/'+e['path'])
(out.parent/'authoritative-data.sha256').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'  authoritative-data.tar.gz\n',encoding='utf-8')
print(str(out))
