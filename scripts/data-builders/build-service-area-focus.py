#!/usr/bin/env python3
"""builds the hatched outside area and focus outline drawn around the OHAZ service area

The source is the OHAZ network folder's service_area.gpkg (Oregon and Washington
plus a 30-mile buffer into California, Idaho and Nevada), which is not in this
repo. Needs the QGIS Python for its GDAL bindings.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlencode
from urllib.request import urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from qgis_runtime import qgis_runtime

# reprojection needs proj.db, which the bare QGIS Python does not locate itself
os.environ.setdefault("PROJ_DATA", str(qgis_runtime().proj_data))

from osgeo import ogr, osr


DEFAULT_OUTPUT = PROJECT_ROOT / "data/service-area-focus.geojson"
# the same Census release the service area was buffered from, so shared edges line up
STATE_SOURCE = "/vsizip//vsicurl/https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip"
COUNTRY_SOURCE = (
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/"
    "World_Countries_(Generalized)/FeatureServer/0"
)

# states that intersect or sit immediately around the map's constrained bounds
NEIGHBOR_STATE_FIPS = ("04", "06", "08", "16", "30", "32", "49", "56")
# matches MAP_BOUNDS in js/map.js
MAP_BOUNDS = (-135.0, 38.0, -106.0, 53.0)
# meters in the service area's EPSG:5070
SERVICE_AREA_SIMPLIFY = 100
# degrees for the hatched land, which only needs to read at regional zooms
OUTSIDE_SIMPLIFY = 0.002
COORDINATE_PRECISION = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the web map's service area outline and outside hatch."
    )
    parser.add_argument("source", type=Path, help="service_area.gpkg")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def wgs84() -> osr.SpatialReference:
    reference = osr.SpatialReference()
    reference.ImportFromEPSG(4326)
    reference.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return reference


def load_service_area(path: Path) -> ogr.Geometry:
    """dissolves and simplifies the service area before moving it to longitude and latitude"""
    dataset = ogr.Open(str(path))
    layer = dataset.GetLayer(0)
    merged = None
    for feature in layer:
        geometry = feature.GetGeometryRef().Clone()
        merged = geometry if merged is None else merged.Union(geometry)
    if merged is None:
        raise RuntimeError(f"no service area geometry in {path}")

    merged = merged.SimplifyPreserveTopology(SERVICE_AREA_SIMPLIFY)
    merged.AssignSpatialReference(layer.GetSpatialRef())
    merged.TransformTo(wgs84())
    return merged


def load_neighbor_states() -> list[ogr.Geometry]:
    dataset = ogr.Open(STATE_SOURCE)
    layer = dataset.GetLayer(0)
    layer.SetAttributeFilter(
        "STATEFP IN ({})".format(",".join(f"'{fips}'" for fips in NEIGHBOR_STATE_FIPS))
    )
    geometries = []
    for feature in layer:
        geometry = feature.GetGeometryRef().Clone()
        geometry.TransformTo(wgs84())
        geometries.append(geometry)
    if len(geometries) != len(NEIGHBOR_STATE_FIPS):
        raise RuntimeError(f"expected {len(NEIGHBOR_STATE_FIPS)} states; received {len(geometries)}")
    return geometries


def load_canada() -> ogr.Geometry:
    query = urlencode(
        {
            "where": "ISO='CA'",
            "outFields": "ISO",
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "6",
            "f": "geojson",
        }
    )
    with urlopen(f"{COUNTRY_SOURCE}/query?{query}", timeout=60) as response:
        features = json.load(response).get("features", [])
    if len(features) != 1:
        raise RuntimeError(f"expected one Canada feature; received {len(features)}")
    return ogr.CreateGeometryFromJson(json.dumps(features[0]["geometry"]))


def map_envelope() -> ogr.Geometry:
    west, south, east, north = MAP_BOUNDS
    return ogr.CreateGeometryFromWkt(
        f"POLYGON(({west} {south},{east} {south},{east} {north},{west} {north},{west} {south}))"
    )


def build_outside(service_area: ogr.Geometry) -> ogr.Geometry:
    """hatches neighboring land only, so the ocean stays clear like the current map"""
    land = load_canada()
    for state in load_neighbor_states():
        land = land.Union(state)
    land = land.Intersection(map_envelope()).SimplifyPreserveTopology(OUTSIDE_SIMPLIFY)
    # subtracting after simplifying keeps the shared edge identical to the outline
    outside = ogr.ForceToMultiPolygon(land.Difference(service_area))
    if outside is None or outside.IsEmpty():
        raise RuntimeError("outside area is empty")
    return outside


def build_outline(service_area: ogr.Geometry) -> ogr.Geometry:
    outline = ogr.Geometry(ogr.wkbMultiLineString)
    for polygon in ogr.ForceToMultiPolygon(service_area):
        for index in range(polygon.GetGeometryCount()):
            ring = polygon.GetGeometryRef(index)
            line = ogr.Geometry(ogr.wkbLineString)
            for x, y in ring.GetPoints():
                line.AddPoint_2D(x, y)
            outline.AddGeometry(line)
    return outline


def rounded(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [round(value, COORDINATE_PRECISION) for value in coordinates[:2]]
    return [rounded(item) for item in coordinates]


def feature(kind: str, geometry: ogr.Geometry) -> dict:
    document = json.loads(geometry.ExportToJson())
    document["coordinates"] = rounded(document["coordinates"])
    return {"type": "Feature", "properties": {"kind": kind}, "geometry": document}


def main() -> int:
    ogr.UseExceptions()
    osr.UseExceptions()
    args = parse_args()
    service_area = load_service_area(args.source.resolve())
    document = {
        "type": "FeatureCollection",
        "name": "service_area_focus",
        "features": [
            feature("outside", build_outside(service_area)),
            feature("outline", build_outline(service_area)),
        ],
    }
    output = args.output.resolve()
    output.write_text(json.dumps(document, separators=(",", ":")) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
