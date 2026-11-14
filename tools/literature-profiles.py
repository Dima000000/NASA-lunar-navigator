from pathlib import Path
import json
import build_science as b
rows=[]
for point in [dict(key='shackleton-S-light',lat=-89.6866,lon=-162.81,paper_mean_percent=85.5,paper_any_percent=89.4),dict(key='shackleton-S-visibility',lat=-89.7815,lon=-155.3,paper_mean_percent=82.1,paper_any_percent=89.8)]:
 point['centerHeightM']=float(b.sample(b.basis(point['lat'],point['lon'])[0]));point['profiles']={str(k):v.tolist() for k,v in b.horizon(point).items()};rows.append(point)
(b.ROOT/'public/research/shackleton-literature-inputs.json').write_text(json.dumps(rows),encoding='utf8')
