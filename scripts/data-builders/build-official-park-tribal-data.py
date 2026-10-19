#!/usr/bin/env python3
"""Refresh the local park and tribal boundary indexes from official services.

The generated files intentionally keep source geometries intact and add the
stable division fields consumed by the map. Tribal records are selected by
their representative point inside the existing OR/WA mask so neighboring
state records from the Census service are excluded.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode

from shapely.geometry import mapping

from division_common import (
    OUT,
    ROOT,
    arcgis_query,
    bbox,
    coordinates,
    feature_collection,
    pending_metrics,
    repaired_geometry,
    write_collection,
)
PARK_QUERY = (
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/"
    "NPS_Regional_and_Park_Boundary/FeatureServer/1/query"
)
TRIBAL_QUERY = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/"
    "MapServer/{layer}/query"
)


def fetch_json(url: str, params: dict[str, str]) -> dict:
    payload, _, _ = arcgis_query(url, params, timeout=90)
    return payload


def sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for index, current in enumerate(ring):
        previous = ring[index - 1]
        x1, y1 = current
        x2, y2 = previous
        crosses = (y1 > y) != (y2 > y)

        if crosses and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def representative_point(geometry: dict) -> tuple[float, float]:
    points = list(coordinates(geometry))
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def in_or_wa(point: tuple[float, float], mask: dict) -> bool:
    geometry = mask["features"][0]["geometry"]
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    else:
        polygons = geometry["coordinates"]
    return any(point_in_ring(point, polygon[0]) for polygon in polygons)


def normalized_feature(feature: dict, division_type: str, source_id: str, name: str, label_point):
    geometry = mapping(repaired_geometry(feature["geometry"]))
    division_id = f"{division_type}:{source_id}"
    properties = {
        "divisionId": division_id,
        "divisionType": division_type,
        "name": name,
        "label": name,
        "labelPoint": [float(label_point[0]), float(label_point[1])],
        "state": None,
        "sourceFeatureId": source_id,
        **pending_metrics(),
    }
    return {
        "type": "Feature",
        "id": division_id,
        "geometry": geometry,
        "bbox": bbox(geometry),
        "properties": properties,
    }


def write_division_type(path: Path, division_type: str, source: str, source_payload, source_layer: str, features):
    write_collection(path, feature_collection(
        division_type,
        sorted(features, key=lambda item: item["id"]),
        source=source,
        sourceLayer=source_layer,
        vintage="current",
        sourceSha256=sha256(source_payload),
    ))
    return len(features)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    mask = json.loads((ROOT / "data" / "or-wa-boundary.geojson").read_text())

    park_params = {
        "where": "STATE IN ('OR','WA')",
        "outFields": "UNIT_CODE,UNIT_NAME,STATE,GNIS_ID,FID",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    parks = fetch_json(PARK_QUERY, park_params)
    park_features = []

    for feature in parks["features"]:
        props = feature["properties"]
        label_point = [
            props.get("INTPTLON") or representative_point(feature["geometry"])[0],
            props.get("INTPTLAT") or representative_point(feature["geometry"])[1],
        ]
        park_features.append(
            normalized_feature(
                feature, "national-park", props["UNIT_CODE"], props["UNIT_NAME"], label_point
            )
        )

    park_source = f"{PARK_QUERY}?{urlencode(park_params)}"
    print("national parks:", write_division_type(
        OUT / "national-park.geojson",
        "national-park",
        park_source,
        parks,
        "NPS Land Resources Division boundary and tract data",
        park_features,
    ))

    tribal_features = []
    tribal_payloads = []

    # layer 2 is Federal American Indian Reservations, layer 3 is Off-Reservation Trust Lands
    for layer in (2, 3):
        params = {
            "where": "1=1",
            "outFields": "GEOID,NAME,INTPTLAT,INTPTLON,AIANNHNS,AREALAND",
            "geometry": json.dumps({"xmin": -125, "ymin": 41.9, "xmax": -116, "ymax": 49.1, "spatialReference": {"wkid": 4326}}, separators=(",", ":")),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        }
        response = fetch_json(TRIBAL_QUERY.format(layer=layer), params)
        tribal_payloads.append(response)
        for feature in response["features"]:
            props = feature["properties"]

            if not in_or_wa(representative_point(feature["geometry"]), mask):
                continue

            source_id = props["GEOID"]
            point = [
                props.get("INTPTLON") or representative_point(feature["geometry"])[0],
                props.get("INTPTLAT") or representative_point(feature["geometry"])[1],
            ]
            tribal_features.append(
                normalized_feature(feature, "tribal-land", source_id, props["NAME"], point)
            )

    tribal_source = f"{TRIBAL_QUERY.format(layer='2')} and layer 3; {urlencode({'where': '1=1', 'geometryType': 'esriGeometryEnvelope', 'outSR': '4326'})}"
    print("tribal lands:", write_division_type(
        OUT / "tribal-land.geojson",
        "tribal-land",
        tribal_source,
        tribal_payloads,
        "Federal American Indian Reservations; Off-Reservation Trust Lands",
        tribal_features,
    ))


if __name__ == "__main__":
    main()
