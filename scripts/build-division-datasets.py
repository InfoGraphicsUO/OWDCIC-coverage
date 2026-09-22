#!/usr/bin/env python3
"""Build the selectable OR/WA division GeoJSON products.

All geometries come from the listed public ArcGIS services.  The builder keeps
the raw service response hash in each collection so a refresh is auditable.
Area and viewshed metrics are intentionally nullable until the GDAL coverage
step is run against the local EPSG:5070 product.
"""
from __future__ import annotations

import argparse, hashlib, json, math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "divisions"
ORWA = "(STATE IN ('41','53'))"
CENSUS = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"

SOURCES = {
    "state": (f"{CENSUS}/State_County/MapServer/0", ORWA, "GEOID,NAME,STATE,INTPTLAT,INTPTLON", "state", "States"),
    "county": (f"{CENSUS}/State_County/MapServer/1", ORWA, "GEOID,NAME,STATE,INTPTLAT,INTPTLON", "county", "Counties"),
    "house": (f"{CENSUS}/Legislative/MapServer/2", ORWA, "GEOID,NAME,STATE,SLDL,INTPTLAT,INTPTLON", "house", "2026 State Legislative Districts - Lower"),
    "senate": (f"{CENSUS}/Legislative/MapServer/1", ORWA, "GEOID,NAME,STATE,SLDU,INTPTLAT,INTPTLON", "senate", "2026 State Legislative Districts - Upper"),
    "us-house": (f"{CENSUS}/Legislative/MapServer/4", ORWA, "GEOID,NAME,STATE,CD119,INTPTLAT,INTPTLON", "us-house", "119th Congressional Districts"),
    "national-park": (f"{CENSUS}/Special_Land_Use_Areas/MapServer/0", "1=1", "LNDMRKNS,NAME,INTPTLAT,INTPTLON", "national-park", "National Park Service Areas"),
    "tribal-land": (f"{CENSUS}/AIANNHA/MapServer/2", "1=1", "GEOID,NAME,INTPTLAT,INTPTLON", "tribal-land", "Federal American Indian Reservations"),
    "national-forest": ("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0", "1=1", "adminforestid,forestname,region", "national-forest", "Administrative Forest Boundaries - National Extent"),
}

def fetch(url, where, fields):
    params = {"where": where, "outFields": fields, "returnGeometry": "true", "outSR": "4326", "geometryPrecision": "5", "f": "json", "orderByFields": "OBJECTID"}
    full = url.rstrip("/") + "/query?" + urlencode(params)
    with urlopen(full, timeout=120) as response:
        raw = response.read()
    payload = json.loads(raw.decode("utf-8"))
    if "error" in payload: raise RuntimeError(f"{full}: {payload['error']}")
    return payload, full, hashlib.sha256(raw).hexdigest()

def positions(value):
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(v, (int,float)) for v in value[:2]):
        yield value[:2]; return
    for item in value or []: yield from positions(item)

def bbox(geometry):
    pts = list(positions(geometry.get("coordinates")))
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]

def arcgis_geometry(geometry):
    """Convert ArcGIS rings to GeoJSON, retaining holes and disjoint parts."""
    if "type" in geometry: return geometry
    rings = geometry.get("rings") or []
    def area(r): return sum(r[i][0]*r[(i+1)%len(r)][1]-r[(i+1)%len(r)][0]*r[i][1] for i in range(len(r)))/2
    def inside(p, r):
        hit=False
        for i, q in enumerate(r):
            z=r[i-1]
            if (q[1]>p[1]) != (z[1]>p[1]) and p[0] < (z[0]-q[0])*(p[1]-q[1])/(z[1]-q[1])+q[0]: hit=not hit
        return hit
    outer=[r for r in rings if area(r)<0] or rings
    polys=[[r] for r in outer]
    for r in rings:
        if r in outer: continue
        for poly in polys:
            if inside(r[0], poly[0]): poly.append(r); break
    return {"type":"Polygon" if len(polys)==1 else "MultiPolygon", "coordinates":polys[0] if len(polys)==1 else polys}

def number(value):
    try: return float(value)
    except (TypeError, ValueError): return None

def normalize(payload, division_type, service_name, url, source_hash):
    features = []
    for raw in payload.get("features", []):
        prop = raw.get("properties") or raw.get("attributes") or {}
        geom = raw.get("geometry")
        if geom: geom = arcgis_geometry(geom)
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"): continue
        geoid = str(prop.get("GEOID") or prop.get("adminforestid") or raw.get("id") or len(features))
        name = str(prop.get("NAME") or prop.get("forestname") or "Unnamed")
        state = prop.get("STATE")
        # USFS does not carry a state field; clip is applied by bbox against OR/WA.
        b = bbox(geom)
        if division_type in {"national-forest", "national-park", "tribal-land"} and not (b[2] >= -124.8 and b[0] <= -116.4 and b[3] >= 41.9 and b[1] <= 49.1): continue
        did = f"{division_type}:{geoid}"
        lon, lat = number(prop.get("INTPTLON")), number(prop.get("INTPTLAT"))
        if lon is None: lon = (b[0] + b[2]) / 2
        if lat is None: lat = (b[1] + b[3]) / 2
        features.append({"type":"Feature", "id":did, "geometry":geom, "bbox":b, "properties":{
            "divisionId": did, "divisionType": division_type, "name": name,
            "label": name, "labelPoint":[lon,lat],
            "state": state, "sourceFeatureId": geoid,
            "landAreaSqKm": None, "cameraViewshedAreaSqKm": None,
            "cameraViewshedCoveragePct": None, "landMix": []
        }})
    features.sort(key=lambda f: f["id"])
    return {"type":"FeatureCollection", "features":features, "metadata":{
        "schemaVersion": 1, "divisionType": division_type, "source": url,
        "sourceLayer": service_name, "vintage": "2026" if division_type in {"house","senate"} else ("119th Congress" if division_type == "us-house" else "current"),
        "sourceSha256": source_hash, "areaCrs":"EPSG:5070", "metricsStatus":"pending-gdal-coverage-build"
    }}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--only", nargs="*"); ap.add_argument("--output", type=Path, default=OUT)
    args = ap.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    wanted = args.only or list(SOURCES)
    for kind in wanted:
        if kind not in SOURCES: raise SystemExit(f"unknown division type: {kind}")
        url, where, fields, dtype, layer = SOURCES[kind]
        payload, query, digest = fetch(url, where, fields)
        result = normalize(payload, dtype, layer, query, digest)
        (args.output / f"{kind}.geojson").write_text(json.dumps(result, ensure_ascii=False, separators=(",",":"))+"\n", encoding="utf-8")
        print(f"{kind}: {len(result['features'])} features")

if __name__ == "__main__": main()
