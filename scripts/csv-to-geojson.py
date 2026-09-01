#!/usr/bin/env python3
"""Convert a CSV with latitude/longitude columns to GeoJSON points.

    python scripts/csv-to-geojson.py data/or-standing-lookouts.csv
    python scripts/csv-to-geojson.py data/sites.csv data/sites.geojson --sites
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE.parent / "data" / "Site Installation Dates(Site, Coordinates, & Elevation).csv"
DEFAULT_OUTPUT = HERE.parent / "data" / "sites.geojson"

AW_LIVE = re.compile(r"^AW\s*\(Live\)$", re.I)
LAT_ALIASES = ["latitude", "lattitude", "lat"]
LON_ALIASES = ["longitude", "long", "lon", "lng"]
COORD_ALIASES = ["coordinates", "coord", "latlon", "lat/lon", "lat,long"]
NAME_ALIASES = ["site name", "name", "site", "title"]
HEIGHT_ALIASES = ["camera height (ft)", "camera height", "height", "elevation"]


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    input_path = args.input
    output_path = args.output
    if output_path is None:
        output_path = DEFAULT_OUTPUT if input_path == DEFAULT_INPUT else input_path.with_suffix(".geojson")

    text = input_path.read_text(encoding="utf-8-sig")
    if use_sites_mode(text, force_sites=args.sites, force_generic=args.generic):
        geojson = sites_csv_to_geojson(text)
    else:
        geojson = csv_to_geojson(
            text,
            lat_column=args.lat,
            lon_column=args.lon,
            name_column=args.name,
        )

    output_path.write_text(json.dumps(geojson, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(geojson['features'])} features to {output_path}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a CSV with latitude/longitude columns to a GeoJSON FeatureCollection of points."
    )
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=DEFAULT_INPUT,
        help="CSV path (default: camera sites sheet)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=None,
        help="GeoJSON path (default: alongside the CSV, or data/sites.geojson for the camera sheet)",
    )
    parser.add_argument("--lat", metavar="COLUMN", help="Latitude column name")
    parser.add_argument("--lon", metavar="COLUMN", help="Longitude column name")
    parser.add_argument("--name", metavar="COLUMN", help="Name/label column name")
    parser.add_argument(
        "--sites",
        action="store_true",
        help="Merge camera-site rows that share coordinates (height table + AW Live aliases)",
    )
    parser.add_argument(
        "--generic",
        action="store_true",
        help="Do not merge camera-site rows, even if the CSV looks like the sites sheet",
    )
    return parser.parse_args(argv)


def use_sites_mode(text: str, *, force_sites: bool, force_generic: bool) -> bool:
    if force_sites and force_generic:
        raise ValueError("use either --sites or --generic, not both")
    if force_sites:
        return True
    if force_generic:
        return False
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        return False
    try:
        col = sites_column_index(rows[0])
    except ValueError:
        return False
    height_index = col["height"]
    for row in rows[1:]:
        if len(row) <= height_index:
            continue
        if AW_LIVE.match((row[height_index] or "").strip()):
            return True
    return False


def csv_to_geojson(
    text: str,
    *,
    lat_column: str | None = None,
    lon_column: str | None = None,
    name_column: str | None = None,
) -> dict:
    """Turn any lat/lon CSV into Point features; remaining columns become properties."""
    reader = csv.DictReader(text.splitlines())
    fieldnames = list(reader.fieldnames or [])
    if not any(name and name.strip() for name in fieldnames):
        raise ValueError("CSV is empty or has no header")

    lat_field = resolve_field(fieldnames, LAT_ALIASES, lat_column, "latitude", required=False)
    lon_field = resolve_field(fieldnames, LON_ALIASES, lon_column, "longitude", required=False)
    coord_field = resolve_field(fieldnames, COORD_ALIASES, None, "coordinates", required=False)
    if not ((lat_field and lon_field) or coord_field):
        raise ValueError(
            "could not find latitude/longitude columns; pass --lat and --lon"
        )
    name_field = resolve_field(fieldnames, NAME_ALIASES, name_column, "name", required=False)
    skip = {field for field in (lat_field, lon_field, coord_field) if field}

    features = []
    for row in reader:
        latitude, longitude = row_coordinates(row, lat_field, lon_field, coord_field)
        if latitude is None or longitude is None:
            continue

        properties: dict = {}
        if name_field:
            name = (row.get(name_field) or "").strip()
            if name:
                properties["name"] = name

        for key, raw in row.items():
            if key is None or key in skip or key == name_field:
                continue
            header = key.strip()
            if not header:
                continue
            value = (raw or "").strip()
            if value == "":
                continue
            properties[header] = coerce_value(value)

        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [longitude, latitude],
                },
                "properties": properties,
            }
        )

    return {"type": "FeatureCollection", "features": features}


def sites_csv_to_geojson(text: str) -> dict:
    """Camera sites sheet: two tables under one header (heights, then AW Live aliases)."""
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError("CSV is empty")

    col = sites_column_index(rows[0])
    sites: dict[str, dict] = {}

    for row in rows[1:]:
        if len(row) <= max(col.values()):
            continue

        latitude = to_finite_number(row[col["latitude"]])
        longitude = to_finite_number(row[col["longitude"]])
        if latitude is None or longitude is None:
            continue

        name = (row[col["name"]] or "").strip()
        extra = (row[col["height"]] or "").strip()
        # 6 decimals merges the two tables when one lon is off by 1e-7
        key = f"{latitude:.6f},{longitude:.6f}"
        site = sites.get(key) or {
            "name": name or "Site",
            "aliases": [],
            "cameraHeightFt": None,
            "alertWestLive": False,
            "latitude": latitude,
            "longitude": longitude,
        }

        if name and name != site["name"] and name not in site["aliases"]:
            site["aliases"].append(name)

        # same column is numeric height in the first table, status in the second
        if AW_LIVE.match(extra):
            site["alertWestLive"] = True
        else:
            height = to_finite_number(extra)
            if height is not None:
                site["cameraHeightFt"] = height

        sites[key] = site

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [site["longitude"], site["latitude"]],
            },
            "properties": {
                "name": site["name"],
                "aliases": site["aliases"],
                "cameraHeightFt": site["cameraHeightFt"],
                "alertWestLive": site["alertWestLive"],
            },
        }
        for site in sites.values()
    ]

    return {"type": "FeatureCollection", "features": features}


def row_coordinates(
    row: dict[str | None, str | None],
    lat_field: str | None,
    lon_field: str | None,
    coord_field: str | None,
) -> tuple[float | None, float | None]:
    if lat_field and lon_field:
        latitude = to_finite_number(row.get(lat_field))
        longitude = to_finite_number(row.get(lon_field))
        if latitude is not None and longitude is not None:
            return latitude, longitude
    if coord_field:
        return parse_latlon_pair(row.get(coord_field) or "")
    return None, None


def parse_latlon_pair(value: str) -> tuple[float | None, float | None]:
    parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 2:
        return None, None
    first = to_finite_number(parts[0])
    second = to_finite_number(parts[1])
    if first is None or second is None:
        return None, None
    # "lat, lon" unless the first number cannot be a latitude
    if abs(first) > 90 and abs(second) <= 90:
        return second, first
    if abs(first) > 90 or abs(second) > 180:
        return None, None
    return first, second


def resolve_field(
    fieldnames: list[str],
    aliases: list[str],
    explicit: str | None,
    label: str,
    *,
    required: bool = True,
) -> str | None:
    if explicit:
        match = match_field(fieldnames, [explicit.strip().lower()])
        if match is None:
            raise ValueError(f"missing {label} column {explicit!r}")
        return match
    match = match_field(fieldnames, aliases)
    if match is None and required:
        raise ValueError(f"missing {label} column (tried {', '.join(aliases)})")
    return match


def match_field(fieldnames: list[str], aliases: list[str]) -> str | None:
    lowered = [(name, name.strip().lower()) for name in fieldnames if name]
    for alias in aliases:
        for original, lower in lowered:
            if lower == alias:
                return original
    return None


def sites_column_index(header: list[str]) -> dict[str, int]:
    names = [value.strip().lower() for value in header]
    return {
        "name": find_column(names, NAME_ALIASES),
        "latitude": find_column(names, LAT_ALIASES),
        "longitude": find_column(names, LON_ALIASES),
        "height": find_column(names, HEIGHT_ALIASES),
    }


def find_column(names: list[str], aliases: list[str]) -> int:
    for alias in aliases:
        if alias in names:
            return names.index(alias)
    raise ValueError(f"missing column (tried {', '.join(aliases)})")


def coerce_value(value: str):
    numeric = to_finite_number(value)
    if numeric is None:
        return value
    stripped = value.strip()
    if re.search(r"[.eE]", stripped):
        return numeric
    return int(numeric)


def to_finite_number(value) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        numeric = float(str(value).strip())
    except ValueError:
        return None
    return numeric if math.isfinite(numeric) else None


if __name__ == "__main__":
    main()
