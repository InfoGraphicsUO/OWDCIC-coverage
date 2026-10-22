#!/usr/bin/env python3
"""builds the simplified division copies the web map loads, plus a names-only search index

data/divisions/ keeps full detail for the metrics and data release builds;
this writes lighter copies to data/map-divisions/ with the same properties,
and data/map-divisions/options.json so the filter search can list names
without downloading any geometry. rerun it after any division or metrics
build. needs shapely 2.1 or newer, which the QGIS Python ships
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely import coverage_is_valid, coverage_simplify, set_precision, simplify, to_geojson
from shapely.geometry import MultiPolygon, Polygon, shape

from division_common import OUT as SOURCE, ROOT, write_collection

DEFAULT_OUTPUT = ROOT / "data" / "map-divisions"

# degrees, about 10 m in Oregon and Washington, finer than a pixel at the map's zoom-10 fit
TOLERANCE = 0.0001
# 5 decimals is about 1 m
PRECISION = 1e-5

# the only properties the filter list and search read
OPTION_FIELDS = ("divisionId", "name", "label", "shortName", "state", "memberDivisionIds", "partOfDivisionId")


def is_shared(feature: dict) -> bool:
    """a combined option or a state portion overlaps the base areas, so it is simplified on its own"""
    properties = feature["properties"]
    return "memberDivisionIds" in properties or "partOfDivisionId" in properties


def polygonal(geometry):
    """drops the points and lines simplification can leave behind"""
    parts = [part for part in getattr(geometry, "geoms", [geometry])
             if isinstance(part, (Polygon, MultiPolygon)) and not part.is_empty]
    polygons = [poly for part in parts for poly in getattr(part, "geoms", [part])]
    return MultiPolygon(polygons) if len(polygons) != 1 else polygons[0]


def simplified(features: list[dict]) -> list:
    base = [index for index, feature in enumerate(features) if not is_shared(feature)]
    shapes = [shape(feature["geometry"]) for feature in features]
    out = list(shapes)

    # neighbors that share edges keep sharing them, so no gaps open between districts
    if base and coverage_is_valid([shapes[index] for index in base]):
        for index, geometry in zip(base, coverage_simplify([shapes[index] for index in base], TOLERANCE)):
            out[index] = geometry
    else:
        for index in base:
            out[index] = simplify(shapes[index], TOLERANCE, preserve_topology=True)

    for index, feature in enumerate(features):
        if is_shared(feature):
            out[index] = simplify(shapes[index], TOLERANCE, preserve_topology=True)

    return [polygonal(set_precision(geometry, PRECISION)) for geometry in out]


def build(kind: str, output: Path) -> list[dict]:
    collection = json.loads((SOURCE / f"{kind}.geojson").read_text())
    features = collection["features"]

    for feature, geometry in zip(features, simplified(features)):
        feature["geometry"] = json.loads(to_geojson(geometry))

    collection.setdefault("metadata", {})["mapCopy"] = {
        "source": f"data/divisions/{kind}.geojson",
        "simplifyToleranceDegrees": TOLERANCE,
    }
    write_collection(output / f"{kind}.geojson", collection)

    return [{field: feature["properties"][field] for field in OPTION_FIELDS if field in feature["properties"]}
            for feature in features]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = ap.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    options = {}

    for path in sorted(SOURCE.glob("*.geojson")):
        kind = path.stem
        options[kind] = build(kind, args.output)
        before, after = path.stat().st_size, (args.output / path.name).stat().st_size
        print(f"{kind}: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")

    (args.output / "options.json").write_text(
        json.dumps(options, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__": main()
