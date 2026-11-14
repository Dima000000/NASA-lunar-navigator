from pathlib import Path
root=Path(__file__).resolve().parent.parent/'public/data/sites'
for site in root.iterdir():
 if not site.is_dir():continue
 for name in ['meta.json','dem.f32','psr.u8','horizon-atlas.f32','horizon_h2.json','horizon_h10.json','horizon_h20.json']:
  target=site/name
  if target.exists():target.unlink()
