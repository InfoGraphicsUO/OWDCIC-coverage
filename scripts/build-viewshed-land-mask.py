#!/usr/bin/env python3
"""builds the regional land mask used to trim web viewsheds at the coast"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from osgeo import ogr


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "data/pacific-northwest-land-mask.geojson"
SOURCE_LAYER = (
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/"
    "World_Countries_(Generalized)/FeatureServer/0"
)

# more than 100 miles beyond every inland OR-WA border
REGIONAL_BOUNDS = (-127.5, 40.0, -114.0, 51.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the regional land mask used to clip camera viewsheds at coastlines."
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def fetch_country_features() -> list[dict]:
    """downloads matching US and Canadian land geometries"""
    query = urlencode(
        {
            "where": "ISO IN ('US','CA')",
            "outFields": "ISO,COUNTRY",
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "6",
            "f": "geojson",
        }
    )
    with urlopen(f"{SOURCE_LAYER}/query?{query}", timeout=60) as response:
        payload = json.load(response)
    features = payload.get("features", [])
    if len(features) != 2:
        raise RuntimeError(f"expected US and Canada features; received {len(features)}")
    return features


def regional_envelope() -> object:
    """returns the outer processing extent as an OGR polygon"""
    west, south, east, north = REGIONAL_BOUNDS
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for longitude, latitude in (
        (west, south),
        (east, south),
        (east, north),
        (west, north),
        (west, south),
    ):
        ring.AddPoint_2D(longitude, latitude)
    polygon = ogr.Geometry(ogr.wkbPolygon)
    polygon.AddGeometry(ring)
    return polygon


def build_geometry(features: list[dict]) -> object:
    """unions both countries before cropping to the regional extent"""
    geometries = [
        ogr.CreateGeometryFromJson(json.dumps(feature["geometry"]))
        for feature in features
    ]
    if any(geometry is None or not geometry.IsValid() for geometry in geometries):
        raise RuntimeError("source contains an invalid country geometry")

    # union removes the international border but keeps coastlines and islands
    merged = geometries[0].Union(geometries[1])
    regional = merged.Intersection(regional_envelope())
    regional = ogr.ForceToMultiPolygon(regional)
    if regional is None or regional.IsEmpty() or not regional.IsValid():
        raise RuntimeError("regional land mask is empty or invalid")
    return regional


def write_mask(path: Path, geometry: object) -> None:
    """writes one RFC 7946 feature for the viewshed runner"""
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "type": "FeatureCollection",
        "name": "pacific_northwest_land_mask",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "region": "PNW-LAND",
                    "clip": "coastline",
                    "source": SOURCE_LAYER,
                    "bounds": list(REGIONAL_BOUNDS),
                },
                "geometry": json.loads(geometry.ExportToJson()),
            }
        ],
    }
    path.write_text(
        json.dumps(document, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    ogr.UseExceptions()
    args = parse_args()
    write_mask(args.output.resolve(), build_geometry(fetch_country_features()))
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
