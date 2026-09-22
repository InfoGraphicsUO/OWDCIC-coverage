#!/usr/bin/env python3
"""Build utility and PAD-US federal manager selections from official services."""
import json, ssl, subprocess
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'data/divisions'; CTX=ssl._create_unverified_context()
SOURCES={'or':'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Oregon_Natural_Gas_and_Electric_Utility_Incentive_Layer_Update_13Dec2024_v01/FeatureServer/0','wa':'https://gis.ecology.wa.gov/serverext/rest/services/CPR/CPR/MapServer/0','federal':'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0'}
def query(url,where,fields):
 p={'where':where,'outFields':fields,'returnGeometry':'true','outSR':'4326','f':'json','resultRecordCount':2000}
 full=url+'/query?'+urlencode(p)
 try:
  with urlopen(full,context=CTX,timeout=180) as r:return json.loads(r.read())
 except Exception:
  return json.loads(subprocess.check_output(['curl','-sk',full],timeout=180))
def bbox(g):
 pts=[]
 def w(v):
  if isinstance(v,list) and len(v)>=2 and all(isinstance(x,(int,float)) for x in v[:2]):pts.append(v[:2])
  elif isinstance(v,list):
   for x in v:w(x)
 w(g.get('coordinates',[]));return [min(x[0] for x in pts),min(x[1] for x in pts),max(x[0] for x in pts),max(x[1] for x in pts)]
def provider_display_name(name):
 abbreviations={'Eugene Water & Electric Board':'EWEB','Portland General Electric':'PGE'}
 abbreviation=abbreviations.get(name)
 return f'{name} ({abbreviation})' if abbreviation else name
def make(kind,ds,namefn,source,vintage):
 fs=[]
 for d in ds:
  for x in d.get('features',[]):
   a=x.get('attributes',{});g=x.get('geometry',{});g={'type':'Polygon','coordinates':g['rings']} if 'rings' in g else g;b=bbox(g)
   if b[2]<-124.8 or b[0]>-116.4 or b[3]<41.9 or b[1]>49.1:continue
   n=namefn(a);display_name=provider_display_name(n) if kind=='utility' else n;did=f"{kind}:{a.get('OBJECTID',len(fs))}:{n.lower().replace(' ','-')}"
   fs.append({'type':'Feature','id':did,'geometry':g,'bbox':b,'properties':{'divisionId':did,'divisionType':kind,'name':display_name,'label':display_name,'labelPoint':[(b[0]+b[2])/2,(b[1]+b[3])/2],'landAreaSqKm':None,'cameraViewshedAreaSqKm':None,'cameraViewshedCoveragePct':None,'landMix':[]}})
 return {'type':'FeatureCollection','features':fs,'metadata':{'schemaVersion':1,'divisionType':kind,'source':source,'vintage':vintage,'areaCrs':'EPSG:5070','metricsStatus':'pending-gdal-coverage-build'}}
orq=query(SOURCES['or'],"Utility_Name IN ('Portland General Electric','Pacific Power (PacifiCorp)','Eugene Water & Electric Board')",'OBJECTID,Utility_Name')
try: waq=query(SOURCES['wa'],'1=1','OBJECTID,Name')
except Exception: waq={'features':[]}
util=make('utility',[orq,waq],lambda a:a.get('Utility_Name') or a.get('Name') or 'Utility provider',SOURCES['or']+';'+SOURCES['wa'],'2024/2026')
fed=query(SOURCES['federal'],"State_Nm IN ('OR','WA')",'OBJECTID,Mang_Name,Mang_Type,State_Nm')
federal=make('federal-land',[fed],lambda a:a.get('Mang_Name') or a.get('Mang_Type') or 'Federal land',SOURCES['federal'],'PAD-US authoritative')
for n,d in [('utility',util),('federal-land',federal)]:
 (OUT/(n+'.geojson')).write_text(json.dumps(d,separators=(',',':'))+'\n');print(n,len(d['features']))
