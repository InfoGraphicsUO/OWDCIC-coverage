"""helpers shared by the builders that write data/source/divisions/

the builders run as standalone scripts, and this folder is on their import
path, so each one imports this module directly. Shapely is imported lazily
so builders that only need OGR do not load it
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "source" / "divisions"


def arcgis_query(url: str, params: dict[str, str], timeout: int = 120) -> tuple[dict, str, str]:
    """returns an ArcGIS query's payload, its full request URL and a hash of the raw response"""
    source = f"{url}?{urlencode(params)}"

    with urlopen(source, timeout=timeout) as response:
        raw = response.read()

    payload = json.loads(raw.decode("utf-8"))
    if "error" in payload:
        raise RuntimeError(f"{source}: {payload['error']}")

    # f=json flags truncation at the top level, f=geojson under properties
    if payload.get("exceededTransferLimit") or payload.get("properties", {}).get("exceededTransferLimit"):
        raise RuntimeError(f"{url}: query was truncated by the service")

    return payload, source, hashlib.sha256(raw).hexdigest()


def pending_metrics() -> dict:
    """area and coverage fields, null until scripts/build-selection-metrics.py fills them"""
    return {
        "landAreaSqKm": None,
        "cameraViewshedAreaSqKm": None,
        "cameraViewshedCoveragePct": None,
        "landMix": [],
        "providerCoverage": [],
    }


def feature_collection(division_type: str, features: list[dict], **metadata) -> dict:
    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "schemaVersion": 1,
            "divisionType": division_type,
            **metadata,
            "areaCrs": "EPSG:5070",
            "metricsStatus": "pending-gdal-coverage-build",
        },
    }


def write_collection(path: Path, collection: dict) -> None:
    path.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n",
                    encoding="utf-8")


def repaired_geometry(geometry: dict):
    """returns a valid shapely polygonal geometry, dropping non-area artifacts"""
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, shape
    from shapely.validation import make_valid

    polygons = []

    def collect(value):
        if isinstance(value, Polygon):
            if value.area > 0:
                polygons.append(value)
        elif isinstance(value, (MultiPolygon, GeometryCollection)):
            for child in value.geoms:
                collect(child)

    collect(make_valid(shape(geometry)))

    if not polygons:
        raise ValueError("Source feature has no positive-area polygon after make_valid")

    return polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)


def coordinates(geometry: dict):
    """yields every position in a GeoJSON geometry"""

    def walk(value):
        if isinstance(value, (list, tuple)) and value and isinstance(value[0], (int, float)):
            yield value
        elif isinstance(value, (list, tuple)):
            for child in value:
                yield from walk(child)

    yield from walk(geometry.get("coordinates", []))


def bbox(geometry: dict) -> list[float]:
    points = list(coordinates(geometry))
    return [
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    ]


# what is left of a unit after clipping can be a sliver where the two boundaries disagree by a hair
MIN_CLIPPED_AREA_SQKM = 10


def clip_to_project_boundary(features):
    """cuts each feature to the OR/WA project boundary and drops those with next to nothing inside it

    Forest Service units and utility service areas run into CA, ID and NV, so each is clipped to
    data/source/or-wa-boundary.geojson, which keeps the shown area and the coverage
    metrics to the project region
    """
    from pyproj import Transformer
    from shapely import set_precision, to_geojson
    from shapely.ops import transform
    from shapely.geometry import MultiPolygon, Polygon, shape
    from shapely.validation import make_valid

    # areas are measured in EPSG:5070 (equal area, meters), not in degrees
    to_equal_area = Transformer.from_crs(4326, 5070, always_xy=True).transform
    boundary = shape(json.loads((ROOT / "data" / "source" / "or-wa-boundary.geojson").read_text())["features"][0]["geometry"])
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
