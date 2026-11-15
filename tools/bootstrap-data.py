"""Restore immutable scientific inputs from a release, with a checksum-verified baseline fallback."""
from pathlib import Path
import argparse, hashlib, json, tarfile, urllib.request, urllib.error, zipfile

ROOT=Path(__file__).resolve().parents[1]
def valid(path,entry):return path.is_file() and path.stat().st_size==entry['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256']
def restore(archive,target,manifest):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            names=z.namelist();prefix=names[0].split('/')[0]+'/public/data/'
            for e in manifest['files']:
                p=target/e['path'];p.parent.mkdir(parents=True,exist_ok=True);data=z.read(prefix+e['path'])
                if hashlib.sha256(data).hexdigest()!=e['sha256']:raise ValueError('Checksum mismatch: '+e['path'])
                p.write_bytes(data)
    else:
        with tarfile.open(archive,'r:gz') as z:
            for e in manifest['files']:
                data=z.extractfile('data/'+e['path']).read()
                if hashlib.sha256(data).hexdigest()!=e['sha256']:raise ValueError('Checksum mismatch: '+e['path'])
                p=target/e['path'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    assert all(valid(target/e['path'],e) for e in manifest['files'])
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--archive',type=Path);parser.add_argument('--target',type=Path,default=ROOT/'public/data');args=parser.parse_args()
    manifest=json.loads((ROOT/'tools/science-inputs.json').read_text(encoding='utf-8'))
    if all(valid(args.target/e['path'],e) for e in manifest['files']):print('Scientific input checksums verified.');return
    if args.archive:restore(args.archive,args.target,manifest);return
    cache=ROOT/'.data-cache';cache.mkdir(exist_ok=True)
    urls=[('https://github.com/Dima000000/NASA-lunar-navigator/releases/download/'+manifest['release_tag']+'/authoritative-data.tar.gz',cache/'authoritative-data.tar.gz'),('https://codeload.github.com/Dima000000/NASA-lunar-navigator/zip/'+manifest['baseline_commit'],cache/'baseline.zip')]
    failures=[]
    for url,path in urls:
        try:
            if not path.exists():
                req=urllib.request.Request(url,headers={'User-Agent':'Lunar-Navigator-data-bootstrap'})
                with urllib.request.urlopen(req,timeout=60) as response,path.open('wb') as out:
                    while block:=response.read(1024*1024):out.write(block)
            restore(path,args.target,manifest);print('Restored and verified scientific inputs.');return
        except Exception as e:
            failures.append(str(e))
            if path.exists():path.unlink()
    raise SystemExit('Could not restore verified scientific inputs. '+ '; '.join(failures))
if __name__=='__main__':main()
