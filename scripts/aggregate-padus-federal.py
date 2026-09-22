#!/usr/bin/env python3
"""Aggregate PAD-US federal fee polygons into one selectable feature per manager."""
import json, hashlib
from pathlib import Path
from osgeo import ogr

ROOT=Path(__file__).resolve().parents[1]; PATH=ROOT/'data/divisions/federal-land.geojson'
EXP={'FWS':'U.S. Fish and Wildlife Service','USFS':'U.S. Forest Service','BLM':'Bureau of Land Management','DOD':'U.S. Department of Defense','USBR':'U.S. Bureau of Reclamation','NPS':'National Park Service','OTHF':'Other federal fee manager'}
d=json.loads(PATH.read_text());
# Keep a digest of the normalized PAD-US query result separate from the digest
# of the aggregated display product.  Calling the latter ``sourceSha256`` made
# provenance checks appear to validate the upstream response when they only
# validated our own rewrite.
input_features=d.get('features', [])
input_sha256=hashlib.sha256(json.dumps(input_features, sort_keys=True, separators=(',',':')).encode()).hexdigest()
groups={}
for f in d['features']:
 n=f['properties']['name']
 if n == 'TRIB': continue
 g=ogr.CreateGeometryFromJson(json.dumps(f['geometry']))
 if g and not g.IsValid(): g=g.MakeValid()
 groups.setdefault(n,[]).append(g)
features=[]
for code, geometries in sorted(groups.items()):
 union=geometries[0].Clone()
 for g in geometries[1:]:
  merged=union.Union(g)
  if merged is not None: union=merged
 geometry=json.loads(union.ExportToJson()); points=[]
 def walk(v):
  if isinstance(v,list) and len(v)>=2 and all(isinstance(x,(int,float)) for x in v[:2]): points.append(v[:2])
  elif isinstance(v,list):
   for item in v: walk(item)
 walk(geometry['coordinates']); b=[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
 name=EXP.get(code,code); did='federal-land:'+code
 features.append({'type':'Feature','id':did,'geometry':geometry,'bbox':b,'properties':{'divisionId':did,'divisionType':'federal-land','name':name,'label':name,'labelPoint':[(b[0]+b[2])/2,(b[1]+b[3])/2],'landAreaSqKm':None,'cameraViewshedAreaSqKm':None,'cameraViewshedCoveragePct':None,'landMix':[]}})
d['features']=features
d['metadata']['aggregation']='union by PAD-US manager code; TRIB excluded'
d['metadata']['sourceSha256']=input_sha256
d['metadata']['sourceHashBasis']='normalized pre-aggregation PAD-US feature set'
d['metadata']['aggregationSha256']=hashlib.sha256(json.dumps(features, sort_keys=True, separators=(',',':')).encode()).hexdigest()
PATH.write_text(json.dumps(d,separators=(',',':'))+'\n')
print(f'wrote {len(features)} manager features')
