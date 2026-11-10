#!/usr/bin/env python3
"""build the selectable US Wildland Fire Service unit GeoJSON product

each unit is the Interior (BLM, USFWS, NPS) federal land inside one Northwest
USWFS unit boundary, since a unit is responsible for the DOI land within it,
plus one "All USWFS units" feature holding their union. The full unit
boundaries go to a separate map-only outline file, so a selection can trace the
whole unit while its fill shows the DOI land it measures. Reads the DOI feature
from data/source/divisions/federal-land.geojson, so rerun this after
build-utility-federal-land.py. Area and viewshed metrics stay null until
scripts/build-selection-metrics.py is run with --only wildland-fire-unit
"""

from __future__ import annotations

import json
import re

from shapely import coverage_simplify, set_precision
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from division_common import (
    OUT,
    ROOT,
    arcgis_query,
    feature_collection,
    pending_metrics,
    repaired_geometry,
    write_collection,
)

DIVISION_TYPE = "wildland-fire-unit"
QUERY = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "US_Wildland_Fire_Service_Boundaries_edit_view/FeatureServer/1/query"
)
# the Northwest geographic area holds every OR/WA unit; neighboring areas only
# touch the state lines with a few km² of edge slivers
PARAMS = {
    "where": "GACode = 'NW'",
    "outFields": "UnitName,GAName,GACode,GlobalID",
    "orderByFields": "UnitName",
    "returnGeometry": "true",
    "outSR": "4326",
    "geometryPrecision": "5",
    "f": "geojson",
}
EXPECTED_UNITS = 8
# the whole unit boundaries the map outlines; not a division, so it stays out of
# data/source/divisions/ and the metrics and option builds
OUTLINES = ROOT / "data" / "live" / "wildland-fire-unit-outlines.geojson"
# same detail as the build-map-divisions.py copies: about 10 m, coordinates to about 1 m
OUTLINE_TOLERANCE = 0.0001
OUTLINE_PRECISION = 1e-5
INTERIOR_ID = "federal-land:DOI"
ALL_UNITS_NAME = "All USWFS units"


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def division_feature(division_id: str, name: str, source_id: str, geometry, **extra) -> dict:
    # a point guaranteed to fall inside the unit, unlike a bbox center
    label_point = geometry.representative_point()
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
            "sourceFeatureId": source_id,
            **pending_metrics(),
            **extra,
        },
    }


def unit_state(geometry, states: dict) -> str | None:
    """the state holding the unit's land, or None if it spans both"""
    inside = [code for code, boundary in states.items() if geometry.intersection(boundary).area > 0.0001]
    return inside[0] if len(inside) == 1 else None


def write_outlines(boundaries: list[tuple[str, object]], source: str) -> None:
    """the full unit polygons, keyed by the divisionId of the unit they outline"""
    shapes = coverage_simplify([geometry for _, geometry in boundaries], OUTLINE_TOLERANCE)
    write_collection(OUTLINES, {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": mapping(set_precision(geometry, OUTLINE_PRECISION)),
             "properties": {"divisionId": division_id}}
            for (division_id, _), geometry in zip(boundaries, shapes)
        ],
        "metadata": {"source": source, "simplifyToleranceDegrees": OUTLINE_TOLERANCE},
    })


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    federal = json.loads((OUT / "federal-land.geojson").read_text())["features"]
    interior = repaired_geometry(next(f["geometry"] for f in federal if f["id"] == INTERIOR_ID))
    states = {f["properties"]["state"]: shape(f["geometry"])
              for f in json.loads((OUT / "state.geojson").read_text())["features"]}
    payload, source, digest = arcgis_query(QUERY, PARAMS)

    if len(payload["features"]) != EXPECTED_UNITS:
        raise RuntimeError(f"expected {EXPECTED_UNITS} Northwest units, received {len(payload['features'])}")

    units = []
    boundaries = []

    for row in payload["features"]:
        properties = row["properties"]
        name = properties["UnitName"].strip()
        division_id = f"{DIVISION_TYPE}:{slug(name)}"
        boundary = repaired_geometry(row["geometry"])
        land = repaired_geometry(mapping(boundary.intersection(interior)))
        units.append(division_feature(division_id, name, properties["GlobalID"],
                                      land, state=unit_state(land, states)))
        boundaries.append((division_id, boundary))

    units.sort(key=lambda item: item["id"])

    if len({feature["id"] for feature in units}) != len(units):
        raise ValueError("USWFS unit names must be unique")

    combined = repaired_geometry(mapping(unary_union([shape(item["geometry"]) for item in units])))
    # listed first; the page also pins it to the top of the option list
    features = [
        division_feature(f"{DIVISION_TYPE}:all", ALL_UNITS_NAME, "all", combined,
                         state=None, memberDivisionIds=[item["id"] for item in units]),
        *units,
    ]
    write_collection(OUT / f"{DIVISION_TYPE}.geojson", feature_collection(
        DIVISION_TYPE,
        features,
        source=source,
        sourceLayer="US Wildland Fire Service Boundaries (WFSUnitBoundaries)",
        vintage="Policy Memorandum 2026-014, current as of 2026-09-09",
        sourceSha256=digest,
        aggregation=f"each Northwest unit intersected with {INTERIOR_ID} (BLM, FWS, NPS fee land)",
    ))
    write_outlines(sorted(boundaries, key=lambda item: item[0]), source)
    print(f"{DIVISION_TYPE}: {len(units)} units plus the combined feature, and their outlines")


if __name__ == "__main__":
    main()
