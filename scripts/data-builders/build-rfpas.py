#!/usr/bin/env python3
"""build the selectable Oregon rangeland fire protection association GeoJSON product

geometries come from the 2023 Oregon Rangeland Protection Associations layer ODF
publishes through Oregon Explorer, plus one "All RFPAs" feature holding their
union so the combined result is measured on the merged land, not summed per
association. Area and viewshed metrics stay null until
scripts/build-selection-metrics.py is run with --only rfpa
"""

from __future__ import annotations

import re

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from division_common import (
    OUT,
    arcgis_query,
    feature_collection,
    pending_metrics,
    repaired_geometry,
    write_collection,
)

DIVISION_TYPE = "rfpa"
QUERY = (
    "https://services1.arcgis.com/CD5mKowwN6nIaqd8/arcgis/rest/services/"
    "library_bnd_or_rangeland_protection_associations_2023/FeatureServer/55/query"
)
PARAMS = {
    "where": "1=1",
    "outFields": "OBJECTID,RPA_Name",
    "orderByFields": "RPA_Name",
    "returnGeometry": "true",
    "outSR": "4326",
    "geometryPrecision": "5",
    "f": "geojson",
}
ALL_NAME = "All RFPAs"
# the source mixes RPA and RFPA; the associations go by RFPA
RPA_SUFFIX = re.compile(r"\bR(?:F)?PA$")


def display_name(source_name: str) -> str:
    """returns the name people use, e.g. Burnt River RFPA"""
    return RPA_SUFFIX.sub("RFPA", " ".join(source_name.split()))


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", RPA_SUFFIX.sub("", name).lower()).strip("-")


def division_feature(division_id: str, name: str, source_name: str, geometry, **extra) -> dict:
    # a point guaranteed to fall inside the association, unlike a bbox center
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
            "state": "OR",
            "sourceFeatureId": source_name,
            **pending_metrics(),
            **extra,
        },
    }


def associations(features: list[dict]) -> list[dict]:
    """one feature per association; High Desert RFPA comes as two polygons from separate years"""
    parts: dict[str, list] = {}
    for feature in features:
        name = display_name(feature["properties"]["RPA_Name"])
        parts.setdefault(name, []).append(repaired_geometry(feature["geometry"]))

    return sorted((division_feature(f"{DIVISION_TYPE}:{slug(name)}", name, name,
                                    repaired_geometry(mapping(unary_union(shapes))))
                   for name, shapes in parts.items()),
                  key=lambda item: item["id"])


def combined_feature(members: list[dict]) -> dict:
    """the union of every association; the map highlights the members, not this shape"""
    geometry = repaired_geometry(mapping(unary_union([shape(item["geometry"]) for item in members])))
    return division_feature(f"{DIVISION_TYPE}:all", ALL_NAME, "all",
                            geometry, memberDivisionIds=[item["id"] for item in members])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    payload, source, digest = arcgis_query(QUERY, PARAMS)
    members = associations(payload["features"])

    if len({feature["id"] for feature in members}) != len(members):
        raise ValueError("RFPA names must be unique")

    # listed first; the page also pins it to the top of the option list
    features = [combined_feature(members), *members]
    write_collection(OUT / f"{DIVISION_TYPE}.geojson", feature_collection(
        DIVISION_TYPE,
        features,
        source=source,
        sourceLayer="Oregon Rangeland Protection Associations (2023)",
        vintage="2023",
        sourceSha256=digest,
    ))
    print(f"{DIVISION_TYPE}: {len(members)} associations plus the combined feature")


if __name__ == "__main__":
    main()
