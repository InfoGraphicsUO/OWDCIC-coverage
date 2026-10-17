#!/usr/bin/env python3
"""build the Census and Forest Service OR/WA division GeoJSON products

parks and tribal lands, ODF districts, and utility and federal land have their
own builders in this folder. all geometries come from the listed public
ArcGIS services. the raw service response hash is kept in each collection so
a refresh is auditable. area and viewshed metrics stay null until the GDAL
coverage step is run against the local EPSG:5070 product
"""
from __future__ import annotations

import argparse, json
from pathlib import Path

from division_common import OUT, ROOT, arcgis_query, bbox, feature_collection, pending_metrics, write_collection

ORWA = "(STATE IN ('41','53'))"
STATES = {"41": ("OR", "Oregon"), "53": ("WA", "Washington")}
CENSUS = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"

SOURCES = {
    "state": (f"{CENSUS}/State_County/MapServer/0", ORWA, "GEOID,NAME,STATE,INTPTLAT,INTPTLON", "state", "States"),
    "county": (f"{CENSUS}/State_County/MapServer/1", ORWA, "GEOID,NAME,STATE,INTPTLAT,INTPTLON", "county", "Counties"),
    "house": (f"{CENSUS}/Legislative/MapServer/2", ORWA, "GEOID,NAME,STATE,SLDL,INTPTLAT,INTPTLON", "house", "2026 State Legislative Districts - Lower"),
    "senate": (f"{CENSUS}/Legislative/MapServer/1", ORWA, "GEOID,NAME,STATE,SLDU,INTPTLAT,INTPTLON", "senate", "2026 State Legislative Districts - Upper"),
    "us-house": (f"{CENSUS}/Legislative/MapServer/4", ORWA, "GEOID,NAME,STATE,CD119,INTPTLAT,INTPTLON", "us-house", "119th Congressional Districts"),
    "national-forest": ("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0", "1=1", "adminforestid,forestname,region", "national-forest", "Administrative Forest Boundaries - National Extent"),
}

# listed first in the national forest options; the map highlights its members, not its shape
ALL_FORESTS_NAME = "All National Forests"
# listed after it, each covering only the forest land inside that state
STATE_FORESTS = (("OR", "Oregon"), ("WA", "Washington"))

# counties are generalized server-side because the map draws all 75 outlines at once
COUNTY_PARAMS = {"maxAllowableOffset": "0.0005", "f": "geojson", "orderByFields": "GEOID"}


def fetch(url, where, fields, extra=None):
    params = {"where": where, "outFields": fields, "returnGeometry": "true", "outSR": "4326", "geometryPrecision": "5", "f": "json", "orderByFields": "OBJECTID", **(extra or {})}
    return arcgis_query(url.rstrip("/") + "/query", params)


def arcgis_geometry(geometry):
    """converts ArcGIS rings to GeoJSON, keeping holes and disjoint parts"""
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
        state, state_name = STATES.get(prop.get("STATE"), (None, None))
        # USFS does not carry a state field; a bbox check against OR/WA drops far-away units, then clip_to_project_boundary clips the rest
        b = bbox(geom)
        if division_type == "national-forest" and not (b[2] >= -124.8 and b[0] <= -116.4 and b[3] >= 41.9 and b[1] <= 49.1): continue
        did = f"{division_type}:{geoid}"
        lon, lat = number(prop.get("INTPTLON")), number(prop.get("INTPTLAT"))
        if lon is None: lon = (b[0] + b[2]) / 2
        if lat is None: lat = (b[1] + b[3]) / 2
        features.append({"type":"Feature", "id":did, "geometry":geom, "bbox":b, "properties":{
            "divisionId": did, "divisionType": division_type, "name": name,
            "label": name, "labelPoint":[lon,lat],
            "state": state, "sourceFeatureId": geoid, **pending_metrics()
        }})

        if division_type == "county":
            short = name.removesuffix(" County")
            features[-1]["properties"].update({"geoid": geoid, "stateName": state_name, "shortName": short, "label": short})

    features.sort(key=lambda f: f["id"])
    vintage = "2026" if division_type in {"house","senate"} else ("119th Congress" if division_type == "us-house" else "current")

    return feature_collection(division_type, features, source=url, sourceLayer=service_name,
                              vintage=vintage, sourceSha256=source_hash)


def polygons(geometry):
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def combined_feature(features, division_type, name=ALL_FORESTS_NAME, key="all", state=None):
    """every member's polygons in one shape; the coverage step repairs shared edges into a union"""
    geom = {"type": "MultiPolygon", "coordinates": [poly for f in features for poly in polygons(f["geometry"])]}
    b = bbox(geom)
    did = f"{division_type}:{key}"

    return {"type":"Feature", "id":did, "geometry":geom, "bbox":b, "properties":{
        "divisionId": did, "divisionType": division_type, "name": name,
        "label": name, "labelPoint":[(b[0]+b[2])/2, (b[1]+b[3])/2],
        "state": state, "sourceFeatureId": key, **pending_metrics(),
        "memberDivisionIds": [f["id"] for f in features]
    }}


def state_combined_features(features, division_type, states_path):
    """An Oregon and a Washington option made of the forest land inside each state.

    A forest that crosses the state line joins each state as a portion of its own,
    so no land counts toward both. Portions are only report members: they name
    their forest in partOfDivisionId, and the map keeps drawing the whole forest.
    Returns the state options and the portions.
    """
    from pyproj import Transformer
    from shapely import set_precision, to_geojson
    from shapely.ops import transform
    from shapely.geometry import MultiPolygon, Polygon, shape
    from shapely.validation import make_valid

    to_equal_area = Transformer.from_crs(4326, 5070, always_xy=True).transform
    sqkm = lambda geometry: transform(to_equal_area, geometry).area / 1e6
    state_shapes = {f["properties"]["state"]: make_valid(shape(f["geometry"]))
                    for f in json.loads(states_path.read_text())["features"]}
    combined, portions = [], []

    for abbr, state_name in STATE_FORESTS:
        boundary = state_shapes[abbr]
        members = []

        for feature in features:
            forest = make_valid(shape(feature["geometry"]))
            inside = forest.intersection(boundary)

            # a sliver along the state line is boundary disagreement, not forest in that state
            if sqkm(inside) < MIN_CLIPPED_AREA_SQKM:
                continue
            if sqkm(forest.difference(boundary)) < MIN_CLIPPED_AREA_SQKM:
                members.append(feature)
                continue

            parts = [part for part in getattr(inside, "geoms", [inside]) if isinstance(part, (Polygon, MultiPolygon))]
            geometry = set_precision(MultiPolygon([poly for part in parts for poly in getattr(part, "geoms", [part])]), 1e-5)
            point = geometry.representative_point()
            did = f"{feature['id']}:{abbr.lower()}"
            name = f"{feature['properties']['name']} ({state_name} portion)"
            portion = {"type": "Feature", "id": did, "geometry": json.loads(to_geojson(geometry)),
                       "bbox": list(geometry.bounds), "properties": {
                           "divisionId": did, "divisionType": division_type, "name": name, "label": name,
                           "labelPoint": [round(point.x, 5), round(point.y, 5)], "state": abbr,
                           "sourceFeatureId": feature["properties"]["sourceFeatureId"], **pending_metrics(),
                           "partOfDivisionId": feature["id"]}}
            portions.append(portion)
            members.append(portion)

        combined.append(combined_feature(members, division_type, f"{state_name} National Forests", abbr.lower(), abbr))

    return combined, portions


# what is left of a unit after clipping can be a sliver where the two boundaries disagree by a hair
MIN_CLIPPED_AREA_SQKM = 10


def clip_to_project_boundary(features):
    """cuts each feature to the OR/WA project boundary and drops those with next to nothing inside it

    Forest Service units run into CA, ID and NV, so each is clipped to
    data/or-wa-boundary.geojson, which keeps the shown area and the coverage
    metrics to the project region
    """
    from pyproj import Transformer
    from shapely import set_precision, to_geojson
    from shapely.ops import transform
    from shapely.geometry import MultiPolygon, Polygon, shape
    from shapely.validation import make_valid

    # areas are measured in EPSG:5070 (equal area, meters), not in degrees
    to_equal_area = Transformer.from_crs(4326, 5070, always_xy=True).transform
    boundary = shape(json.loads((ROOT / "data" / "or-wa-boundary.geojson").read_text())["features"][0]["geometry"])
    clipped, dropped = [], []

    for feature in features:
        # source rings can self-intersect, so repair before intersecting
        inside = make_valid(shape(feature["geometry"])).intersection(boundary)
        parts = [part for part in getattr(inside, "geoms", [inside]) if isinstance(part, (Polygon, MultiPolygon)) and part.area > 0]
        polygons = [poly for part in parts for poly in getattr(part, "geoms", [part])]

        if not polygons:
            dropped.append({"id": feature["id"], "name": feature["properties"]["name"]})
            continue

        # snap to 5 decimals, matching the precision the service returns
        geometry = set_precision(MultiPolygon(polygons), 1e-5)
        # / 1e6 turns square meters into square km
        if geometry.is_empty or transform(to_equal_area, geometry).area / 1e6 < MIN_CLIPPED_AREA_SQKM:
            dropped.append({"id": feature["id"], "name": feature["properties"]["name"]})
            continue

        feature["geometry"] = json.loads(to_geojson(geometry))
        feature["bbox"] = list(geometry.bounds)
        # the unclipped center can fall outside what is left, so use a point known to be inside
        label = feature["properties"]["labelPoint"]
        if not geometry.contains(shape({"type": "Point", "coordinates": label})):
            point = geometry.representative_point()
            feature["properties"]["labelPoint"] = [round(point.x, 5), round(point.y, 5)]

        clipped.append(feature)

    return clipped, dropped


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--only", nargs="*"); ap.add_argument("--output", type=Path, default=OUT)
    args = ap.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    wanted = args.only or list(SOURCES)

    for kind in wanted:
        if kind not in SOURCES: raise SystemExit(f"unknown division type: {kind}")
        url, where, fields, dtype, layer = SOURCES[kind]
        payload, query, digest = fetch(url, where, fields, COUNTY_PARAMS if kind == "county" else None)
        result = normalize(payload, dtype, layer, query, digest)

        if kind == "national-forest":
            result["features"], outside = clip_to_project_boundary(result["features"])
            result["metadata"]["clippedTo"] = "data/or-wa-boundary.geojson"
            result["metadata"]["excludedOutsideBoundaryFeatures"] = outside
            states, portions = state_combined_features(result["features"], dtype, args.output / "state.geojson")
            result["features"] = [combined_feature(result["features"], dtype), *states, *result["features"], *portions]

        write_collection(args.output / f"{kind}.geojson", result)
        print(f"{kind}: {len(result['features'])} features")


if __name__ == "__main__": main()
