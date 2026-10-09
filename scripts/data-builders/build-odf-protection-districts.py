#!/usr/bin/env python3
"""Build the selectable ODF forest protection district GeoJSON product.

Geometries come from the Oregon Department of Forestry district boundary
service. Area and viewshed metrics stay null until
scripts/build-selection-metrics.py is run with --only odf-protection-district.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "divisions"
DIVISION_TYPE = "odf-protection-district"
QUERY = (
    "https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/"
    "District_Boundaries/FeatureServer/1/query"
)
PARAMS = {
    "where": "1=1",
    "outFields": "OBJECTID,ODF_FPD",
    "orderByFields": "ODF_FPD",
    "returnGeometry": "true",
    "outSR": "4326",
    "geometryPrecision": "5",
    "f": "geojson",
}
# forest protective associations already carry their own suffix in the source
ASSOCIATION_SUFFIX = re.compile(r"\bFPA$")


def display_name(source_name: str) -> str:
    """Return the ODF unit name people use, e.g. Central Oregon District."""
    name = source_name.strip()
    return name if ASSOCIATION_SUFFIX.search(name) else f"{name} District"


def slug(source_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", source_name.lower()).strip("-")


def repaired_geometry(geometry: dict):
    """Return a valid polygonal geometry, dropping non-area artifacts."""
    valid = make_valid(shape(geometry))
    polygons = []

    def collect(value):
        if isinstance(value, Polygon):
            if value.area > 0:
                polygons.append(value)
        elif isinstance(value, (MultiPolygon, GeometryCollection)):
            for child in value.geoms:
                collect(child)

    collect(valid)
    if not polygons:
        raise ValueError("Source feature has no positive-area polygon after make_valid")
    return polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)


def normalized_feature(feature: dict) -> dict:
    source_name = feature["properties"]["ODF_FPD"]
    geometry = repaired_geometry(feature["geometry"])
    # a point guaranteed to fall inside the district, unlike a bbox center
    label_point = geometry.representative_point()
    division_id = f"{DIVISION_TYPE}:{slug(source_name)}"
    name = display_name(source_name)
    return {
        "type": "Feature",
        "id": division_id,
        "geometry": mapping(geometry),
        "bbox": list(geometry.bounds),
        "properties": {
            "divisionId": division_id,
            "divisionType": DIVISION_TYPE,
            "name": name,
            "label": name,
            "labelPoint": [round(label_point.x, 5), round(label_point.y, 5)],
            "state": "OR",
            "sourceFeatureId": source_name,
            "landAreaSqKm": None,
            "cameraViewshedAreaSqKm": None,
            "cameraViewshedCoveragePct": None,
            "landMix": [],
        },
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = f"{QUERY}?{urlencode(PARAMS)}"
    with urlopen(source, timeout=120) as response:
        raw = response.read()
    payload = json.loads(raw.decode("utf-8"))
    if "error" in payload:
        raise RuntimeError(f"{source}: {payload['error']}")
    if payload.get("exceededTransferLimit") or payload.get("properties", {}).get("exceededTransferLimit"):
        raise RuntimeError("ODF district query was truncated by the service")
    features = sorted((normalized_feature(feature) for feature in payload["features"]),
                      key=lambda item: item["id"])
    if len({feature["id"] for feature in features}) != len(features):
        raise ValueError("ODF district names must be unique")
    collection = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "schemaVersion": 1,
            "divisionType": DIVISION_TYPE,
            "source": source,
            "sourceLayer": "ODF Forest Protection Districts",
            "vintage": "current",
            "sourceSha256": hashlib.sha256(raw).hexdigest(),
            "areaCrs": "EPSG:5070",
            "metricsStatus": "pending-gdal-coverage-build",
        },
    }
    path = OUT / f"{DIVISION_TYPE}.geojson"
    path.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n",
                    encoding="utf-8")
    print(f"{DIVISION_TYPE}: {len(features)} features")


if __name__ == "__main__":
    main()
