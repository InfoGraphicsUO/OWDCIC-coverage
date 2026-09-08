#!/usr/bin/env python3
"""build the committed county division slice"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data" / "divisions" / "counties.geojson"
COUNTIES_URL = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/"
    "TIGERweb/State_County/MapServer/1/query"
)
EXPECTED_COUNTIES = 75
STATE_INFO = {
    "41": ("OR", "Oregon"),
    "53": ("WA", "Washington"),
}
OUT_FIELDS = "GEOID,NAME,STATE,INTPTLAT,INTPTLON"
COVERAGE_FIELDS = (
    "countyAreaSqKm",
    "cameraViewshedAreaSqKm",
    "cameraViewshedCoveragePct",
)


def query_url() -> str:
    """build the fixed TIGERweb query"""
    params = [
        ("where", "STATE IN ('41','53')"),
        ("outFields", OUT_FIELDS),
        ("returnGeometry", "true"),
        ("outSR", "4326"),
        ("geometryPrecision", "5"),
        ("maxAllowableOffset", "0.0005"),
        ("orderByFields", "GEOID"),
        ("f", "geojson"),
    ]
    return f"{COUNTIES_URL}?{urlencode(params)}"


def fetch_counties(
    opener: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """fetch the two-state county response"""
    if opener is None:
        opener = urlopen
    with opener(query_url(), timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if "error" in payload:
        raise ValueError(f"TIGERweb returned an error: {payload['error']}")
    if not isinstance(payload, dict):
        raise ValueError("TIGERweb response is not an object")
    return payload


def normalize_counties(
    response: dict[str, Any], *, expected_count: int = EXPECTED_COUNTIES
) -> dict[str, Any]:
    """normalize tigerweb features into the county slice"""
    raw_features = response.get("features")
    if not isinstance(raw_features, list):
        raise ValueError("TIGERweb response has no feature list")

    features = [_normalize_feature(raw_feature) for raw_feature in raw_features]
    features.sort(
        key=lambda feature: (
            feature["properties"]["state"],
            feature["properties"]["name"].casefold(),
            feature["properties"]["geoid"],
        )
    )
    result = {"type": "FeatureCollection", "features": features}
    validate_counties(result, expected_count=expected_count)
    return result


def _normalize_feature(raw_feature: Any) -> dict[str, Any]:
    if not isinstance(raw_feature, dict):
        raise ValueError("county feature is not an object")
    attributes = raw_feature.get("attributes", raw_feature.get("properties"))
    if not isinstance(attributes, dict):
        raise ValueError("county feature has no attributes")

    geoid = _text(attributes.get("GEOID"), "GEOID")
    state_code = _text(attributes.get("STATE"), "STATE")
    if state_code not in STATE_INFO:
        raise ValueError(f"unsupported county state: {state_code}")
    state, state_name = STATE_INFO[state_code]
    name = _text(attributes.get("NAME"), "NAME")
    short_name = name.removesuffix(" County")
    longitude = _finite_number(attributes.get("INTPTLON"), "INTPTLON")
    latitude = _finite_number(attributes.get("INTPTLAT"), "INTPTLAT")
    geometry = normalize_geometry(raw_feature.get("geometry"))
    bbox = geometry_bbox(geometry)
    feature_id = f"county:{geoid}"

    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": geometry,
        "bbox": bbox,
        "properties": {
            "divisionId": feature_id,
            "divisionType": "county",
            "geoid": geoid,
            "state": state,
            "stateName": state_name,
            "name": name,
            "shortName": short_name,
            "label": f"{state} • {short_name}",
            "labelPoint": [longitude, latitude],
        },
    }


def normalize_geometry(raw_geometry: Any) -> dict[str, Any]:
    """convert an arcgis polygon into geojson geometry"""
    if not isinstance(raw_geometry, dict):
        raise ValueError("county geometry is not an object")
    if "rings" in raw_geometry:
        return _rings_to_geometry(raw_geometry["rings"])
    if raw_geometry.get("type") in {"Polygon", "MultiPolygon"}:
        return {
            "type": raw_geometry["type"],
            "coordinates": _normalize_coordinates(raw_geometry.get("coordinates")),
        }
    raise ValueError("county geometry must be Polygon or MultiPolygon")


def _rings_to_geometry(rings: Any) -> dict[str, Any]:
    if not isinstance(rings, list) or not rings:
        raise ValueError("ArcGIS polygon has no rings")
    normalized = [_normalize_ring(ring) for ring in rings]
    areas = [_ring_area(ring) for ring in normalized]
    if any(area == 0 for area in areas):
        raise ValueError("ArcGIS polygon has a zero-area ring")

    outer_indexes = [index for index, area in enumerate(areas) if area < 0]
    if not outer_indexes:
        outer_indexes = list(range(len(normalized)))
    holes = [index for index in range(len(normalized)) if index not in outer_indexes]
    polygons = [[normalized[index]] for index in outer_indexes]

    for hole_index in holes:
        hole = normalized[hole_index]
        point = hole[0]
        containing = [
            polygon_index
            for polygon_index, polygon in enumerate(polygons)
            if _point_in_ring(point, polygon[0])
        ]
        if not containing:
            raise ValueError("ArcGIS hole is outside every outer ring")
        polygons[min(containing)].append(hole)

    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def _normalize_coordinates(coordinates: Any) -> list[Any]:
    if not isinstance(coordinates, list):
        raise ValueError("polygon coordinates are not a list")
    return [_normalize_nested_coordinates(item) for item in coordinates]


def _normalize_nested_coordinates(value: Any) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ValueError("polygon coordinates contain an empty part")
    if _is_position(value):
        return [_finite_number(value[0], "longitude"), _finite_number(value[1], "latitude")]
    return [_normalize_nested_coordinates(item) for item in value]


def _normalize_ring(ring: Any) -> list[list[float]]:
    if not isinstance(ring, list) or len(ring) < 4:
        raise ValueError("polygon ring must have at least four positions")
    normalized = [
        [_finite_number(position[0], "longitude"), _finite_number(position[1], "latitude")]
        for position in ring
        if _is_position(position)
    ]
    if len(normalized) != len(ring) or normalized[0] != normalized[-1]:
        raise ValueError("polygon ring must be closed and contain finite positions")
    return normalized


def _is_position(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value[:2])
    )


def _ring_area(ring: list[list[float]]) -> float:
    return sum(
        ring[index][0] * ring[(index + 1) % len(ring)][1]
        - ring[(index + 1) % len(ring)][0] * ring[index][1]
        for index in range(len(ring))
    ) / 2


def _point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    inside = False
    x, y = point
    for index, current in enumerate(ring):
        previous = ring[index - 1]
        if (current[1] > y) != (previous[1] > y):
            at_x = (previous[0] - current[0]) * (y - current[1]) / (previous[1] - current[1]) + current[0]
            if x < at_x:
                inside = not inside
    return inside


def geometry_bbox(geometry: dict[str, Any]) -> list[float]:
    """compute a polygon bbox from every coordinate"""
    coordinates = geometry.get("coordinates")
    if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise ValueError("county geometry must be Polygon or MultiPolygon")
    points = list(_positions(coordinates))
    if not points:
        raise ValueError("county geometry has no coordinates")
    longitudes = [point[0] for point in points]
    latitudes = [point[1] for point in points]
    return [min(longitudes), min(latitudes), max(longitudes), max(latitudes)]


def _positions(value: Any):
    if _is_position(value):
        longitude = float(value[0])
        latitude = float(value[1])
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise ValueError("geometry contains a non-finite coordinate")
        yield [longitude, latitude]
        return
    if not isinstance(value, list):
        raise ValueError("geometry coordinates are malformed")
    for item in value:
        yield from _positions(item)


def validate_counties(geojson: dict[str, Any], *, expected_count: int = EXPECTED_COUNTIES) -> None:
    """validate the normalized county collection"""
    if geojson.get("type") != "FeatureCollection" or not isinstance(geojson.get("features"), list):
        raise ValueError("county output must be a FeatureCollection")
    features = geojson["features"]
    if len(features) != expected_count:
        raise ValueError(f"expected {expected_count} counties, got {len(features)}")

    ids: set[str] = set()
    geoids: set[str] = set()
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("county output contains a non-Feature")
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise ValueError("county feature has no properties")
        geoid = properties.get("geoid")
        state = properties.get("state")
        state_name = properties.get("stateName")
        expected_state = {value[0]: (code, value[1]) for code, value in STATE_INFO.items()}.get(state)
        if not isinstance(geoid, str) or len(geoid) != 5 or not geoid.isdigit():
            raise ValueError("county GEOID must be a five-digit string")
        if geoid[:2] not in STATE_INFO or expected_state is None or geoid[:2] != expected_state[0]:
            raise ValueError("county has an unsupported state")
        if state_name != expected_state[1]:
            raise ValueError("county stateName does not match state")
        feature_id = f"county:{geoid}"
        if feature.get("id") != feature_id or properties.get("divisionId") != feature_id:
            raise ValueError("county feature IDs are malformed")
        if feature_id in ids or geoid in geoids:
            raise ValueError("county IDs are not unique")
        ids.add(feature_id)
        geoids.add(geoid)
        if properties.get("divisionType") != "county":
            raise ValueError("county divisionType is malformed")
        if not isinstance(properties.get("name"), str) or not properties["name"]:
            raise ValueError("county name is malformed")
        expected_short_name = properties["name"].removesuffix(" County")
        if properties.get("shortName") != expected_short_name:
            raise ValueError("county shortName is malformed")
        if properties.get("label") != f"{state} • {expected_short_name}":
            raise ValueError("county label is malformed")

        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            raise ValueError("county geometry must be Polygon or MultiPolygon")
        _validate_geometry(geometry)
        computed_bbox = geometry_bbox(geometry)
        bbox = feature.get("bbox")
        if not _finite_sequence(bbox, 4) or bbox != computed_bbox:
            raise ValueError("county bbox is malformed")
        label_point = properties.get("labelPoint")
        if not _finite_sequence(label_point, 2):
            raise ValueError("county labelPoint is malformed")
        if not (bbox[0] <= label_point[0] <= bbox[2] and bbox[1] <= label_point[1] <= bbox[3]):
            raise ValueError("county labelPoint is outside bbox")


def _finite_sequence(value: Any, length: int) -> bool:
    return (
        isinstance(value, list)
        and len(value) == length
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item) for item in value)
    )


def _validate_geometry(geometry: dict[str, Any]) -> None:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("polygon has no rings")
        for ring in coordinates:
            _normalize_ring(ring)
    elif geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("multipolygon has no polygons")
        for polygon in coordinates:
            if not isinstance(polygon, list) or not polygon:
                raise ValueError("multipolygon has no rings")
            for ring in polygon:
                _normalize_ring(ring)
    else:
        raise ValueError("county geometry must be Polygon or MultiPolygon")


def _finite_number(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} is not numeric") from error
    if not math.isfinite(number):
        raise ValueError(f"{field} is not finite")
    return number


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is missing")
    return value.strip()


def render(geojson: dict[str, Any]) -> str:
    """render deterministic geojson text"""
    return json.dumps(
        geojson,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ) + "\n"


def without_coverage(geojson: dict[str, Any]) -> dict[str, Any]:
    """removes fields owned by the county coverage build step"""
    geojson.pop("coverageMetadata", None)
    for feature in geojson.get("features", []):
        properties = feature.get("properties", {})
        for field in COVERAGE_FIELDS:
            properties.pop(field, None)
    return geojson


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="build the Oregon and Washington county division data")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="GeoJSON output path")
    parser.add_argument("--check", action="store_true", help="compare the generated data without writing")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    generated = normalize_counties(fetch_counties())
    rendered = render(generated)
    if args.check:
        try:
            existing = json.loads(args.output.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            print(f"missing committed output: {args.output}", file=sys.stderr)
            return 1
        if render(without_coverage(existing)) != rendered:
            print(f"committed output is out of date: {args.output}", file=sys.stderr)
            return 1
        print(f"county output is current: {args.output}")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(f"wrote {len(generated['features'])} counties to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
