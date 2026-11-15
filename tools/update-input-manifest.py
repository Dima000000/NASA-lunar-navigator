"""After a direct NASA rebuild, pin the new source-array hashes to its release tag."""
from pathlib import Path
import argparse,hashlib,json
ROOT=Path(__file__).resolve().parents[1];p=ROOT/'tools/science-inputs.json';m=json.loads(p.read_text(encoding='utf-8'));parser=argparse.ArgumentParser();parser.add_argument('--tag',required=True);args=parser.parse_args();m['release_tag']=args.tag
for e in m['files']:
    source=ROOT/'public/data'/e['path'];e['bytes']=source.stat().st_size;e['sha256']=hashlib.sha256(source.read_bytes()).hexdigest()
p.write_text(json.dumps(m,indent=2)+'\n',encoding='utf-8')
