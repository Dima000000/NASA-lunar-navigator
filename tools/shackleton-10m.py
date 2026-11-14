"""Two independently published 10 m benchmark coordinates, Saha et al. 2023 Table 1.
No publication images or article text are redistributed.
"""
import json
import build_science as b
rows=[]
for point in [dict(key='Saha-2023-site4',lat=-89.7797,lon=-156.351,paper_percent=86.90),dict(key='Saha-2023-site8',lat=-89.6866,lon=-162.8618,paper_percent=86.18)]:
 point['centerHeightM']=float(b.sample(b.basis(point['lat'],point['lon'])[0]));point['profiles']={str(k):v.tolist() for k,v in b.horizon(point).items()};rows.append(point)
(b.ROOT/'public/research/shackleton-10m-inputs.json').write_text(json.dumps(rows),encoding='utf8')
