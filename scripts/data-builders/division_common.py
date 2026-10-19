"""Helpers shared by the builders that write data/divisions/.

The builders run as standalone scripts, and this folder is on their import
path, so each one imports this module directly. Shapely is imported lazily
because the utility and federal land builder runs on OGR alone.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "divisions"


def arcgis_query(url: str, params: dict[str, str], timeout: int = 120) -> tuple[dict, str, str]:
    """Return an ArcGIS query's payload, its full request URL and a hash of the raw response."""
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
    """Area and coverage fields, null until scripts/build-selection-metrics.py fills them."""
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
    """Return a valid shapely polygonal geometry, dropping non-area artifacts."""
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
    """Yield every position in a GeoJSON geometry."""

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
