#!/usr/bin/env python3
"""Convert a CSV with latitude/longitude columns to GeoJSON points.

    python scripts/csv-to-geojson.py data/standing-lookouts.csv
    python scripts/csv-to-geojson.py data/sites.csv data/alertwest-sites.geojson --sites

Sites mode writes ALERTWest sites to the main output and each provider section
(e.g. PANO.AI) to its own file, moving sites onto matching digitized camera
locations, which are more accurate than the sheet's coordinates.
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
DEFAULT_OUTPUT = HERE.parent / "data" / "alertwest-sites.geojson"
DEFAULT_DIGITIZED = HERE.parent / "data" / "digitized-camera-sources.geojson"
DEFAULT_COUNTIES = HERE.parent / "data" / "divisions" / "county.geojson"

AW_LIVE = re.compile(r"^AW\s*\(Live\)$", re.I)
LAT_ALIASES = ["latitude", "lattitude", "lat"]
LON_ALIASES = ["longitude", "long", "lon", "lng"]
COORD_ALIASES = ["coordinates", "coord", "latlon", "lat/lon", "lat,long"]
NAME_ALIASES = ["site name", "name", "site", "title"]
HEIGHT_ALIASES = ["camera height (ft)", "camera height (feet)", "camera height", "height", "elevation"]

ALERTWEST = "alertwest"
# a title row containing the marker starts that provider's table; a blank row ends it
SECTION_PROVIDERS = {"PANO.AI": "pano"}
PROVIDER_OUTPUTS = {"pano": HERE.parent / "data" / "pano-sites.geojson"}
# prefixed so viewshed ids stay unique across provider tilesets
PROVIDER_VIEWSHED_PREFIXES = {"pano": "pano-"}
# digitized operators that count as the same camera for each provider
DIGITIZED_OPERATORS = {
    ALERTWEST: {"ALERTWest", "Joint Site"},
    "pano": {"Pano AI", "Joint Site"},
}
# provider coordinates can be rounded to 0.01 degrees, roughly 1 km
DIGITIZED_MATCH_RADIUS_M = 2000.0
# rounded provider rows can borrow a same-named ALERTWest site's precise point
SITE_SHEET_MATCH_RADIUS_M = 1000.0


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    input_path = args.input
    output_path = args.output
    if output_path is None:
        output_path = DEFAULT_OUTPUT if input_path == DEFAULT_INPUT else input_path.with_suffix(".geojson")

    text = input_path.read_text(encoding="utf-8-sig")
    if use_sites_mode(text, force_sites=args.sites, force_generic=args.generic):
        digitized = load_digitized(Path(args.digitized)) if args.digitized else []
        counties = load_counties(Path(args.counties)) if args.counties else []
        by_provider = sites_csv_to_geojson(text, digitized, counties)
        if input_path.resolve() == DEFAULT_INPUT.resolve():
            # project-only additions keep generic CSV conversion independent
            import sys
            from camera_site_supplements import supplement_sites
            supplement_sites(by_provider, text, sys.modules[__name__])
        geojson = by_provider.pop(ALERTWEST)
        for provider, provider_geojson in by_provider.items():
            provider_output = PROVIDER_OUTPUTS.get(provider) or output_path.with_name(f"{provider}-sites.geojson")
            write_geojson(provider_output, provider_geojson)
    else:
        geojson = csv_to_geojson(
            text,
            lat_column=args.lat,
            lon_column=args.lon,
            name_column=args.name,
        )

    write_geojson(output_path, geojson)


def write_geojson(path: Path, geojson: dict) -> None:
    path.write_text(json.dumps(geojson, indent=2) + "\n", encoding="utf-8")
    moved = sum(
        feature["properties"].get("locationSource", "sheet") != "sheet"
        for feature in geojson["features"]
    )
    print(f"wrote {len(geojson['features'])} features to {path} ({moved} relocated)")


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
        help="GeoJSON path (default: alongside the CSV, or data/alertwest-sites.geojson for the camera sheet)",
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
        "--digitized",
        default=str(DEFAULT_DIGITIZED),
        help="digitized camera GeoJSON used to correct site locations (sites mode; '' disables)",
    )
    parser.add_argument(
        "--counties",
        default=str(DEFAULT_COUNTIES),
        help="county polygons used to label provider camera locations (sites mode; '' disables)",
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


def sites_csv_to_geojson(
    text: str,
    digitized: list[dict] | None = None,
    counties: list[dict] | None = None,
) -> dict[str, dict]:
    """Camera sites sheet: ALERTWest heights, provider tables, then AW Live aliases.

    Returns one FeatureCollection per provider, keyed by provider id.
    """
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError("CSV is empty")

    col = sites_column_index(rows[0])
    sites: dict[str, dict[str, dict]] = {ALERTWEST: {}}
    provider = ALERTWEST

    for row in rows[1:]:
        if not any(value.strip() for value in row):
            provider = ALERTWEST
            continue
        if len(row) <= max(col.values()):
            continue

        name = (row[col["name"]] or "").strip()
        latitude = to_finite_number(row[col["latitude"]])
        longitude = to_finite_number(row[col["longitude"]])
        if latitude is None or longitude is None:
            provider = section_provider(name) or provider
            continue

        extra = (row[col["height"]] or "").strip()
        # 6 decimals merges the two tables when one lon is off by 1e-7
        key = f"{latitude:.6f},{longitude:.6f}"
        provider_sites = sites.setdefault(provider, {})
        site = provider_sites.get(key) or {
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

        provider_sites[key] = site

    alertwest_sites = list(sites[ALERTWEST].values())
    return {
        provider: {
            "type": "FeatureCollection",
            "features": [
                site_feature(site, provider, digitized or [], alertwest_sites, counties or [])
                for site in provider_sites.values()
            ],
        }
        for provider, provider_sites in sites.items()
    }


def section_provider(title: str) -> str | None:
    upper = title.upper()
    return next((provider for marker, provider in SECTION_PROVIDERS.items() if marker in upper), None)


def site_feature(
    site: dict,
    provider: str,
    digitized: list[dict],
    alertwest_sites: list[dict],
    counties: list[dict],
) -> dict:
    reported = [site["longitude"], site["latitude"]]
    properties: dict = {
        "name": site["name"],
        "aliases": site["aliases"],
        "cameraHeightFt": site["cameraHeightFt"],
    }
    if provider == ALERTWEST:
        properties["alertWestLive"] = site["alertWestLive"]
    else:
        properties["viewshedId"] = PROVIDER_VIEWSHED_PREFIXES.get(provider, f"{provider}-") + slugify(site["name"])
    properties["provider"] = provider

    coordinates = reported
    match = match_digitized(site, provider, digitized)
    if match:
        coordinates = match["coordinates"]
        properties["locationSource"] = "digitized"
        properties["digitizedId"] = match["id"]
    elif provider != ALERTWEST:
        sheet_site = match_site_sheet(site, alertwest_sites)
        if sheet_site:
            coordinates = [sheet_site["longitude"], sheet_site["latitude"]]
            properties["locationSource"] = "alertwest-site"
    if coordinates is not reported:
        properties["reportedCoordinates"] = reported
    # provider sites become map markers, so they carry the locality ALERTWest's API provides
    if provider != ALERTWEST:
        county = county_at(coordinates, counties)
        if county:
            properties["county"] = county["name"]
            properties["state"] = county["state"]

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coordinates},
        "properties": properties,
    }


def load_counties(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    counties = []
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        polygons = {
            "Polygon": [geometry.get("coordinates")],
            "MultiPolygon": geometry.get("coordinates"),
        }.get(geometry.get("type"))
        if not polygons:
            continue
        counties.append(
            {
                # short names match the ALERTWest API's county field, e.g. "Chelan"
                "name": properties.get("shortName") or properties.get("name"),
                "state": properties.get("state"),
                "polygons": polygons,
            }
        )
    return counties


def county_at(point: list[float], counties: list[dict]) -> dict | None:
    longitude, latitude = point
    for county in counties:
        for rings in county["polygons"]:
            # inside the outer ring and outside every hole
            if ring_contains(rings[0], longitude, latitude) and not any(
                ring_contains(hole, longitude, latitude) for hole in rings[1:]
            ):
                return county
    return None


def ring_contains(ring: list[list[float]], x: float, y: float) -> bool:
    """even-odd ray casting test"""
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def load_digitized(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cameras = []
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coordinates) < 2:
            continue
        names = {
            normalize_site_name(properties.get(field))
            for field in ("name", "pointSourceName", "altPointSourceName")
        } - {""}
        cameras.append(
            {
                "id": properties.get("id"),
                "operator": properties.get("operator"),
                "names": names,
                "coordinates": [float(coordinates[0]), float(coordinates[1])],
            }
        )
    return cameras


def match_digitized(site: dict, provider: str, digitized: list[dict]) -> dict | None:
    """nearest same-named digitized camera from a compatible operator"""
    operators = DIGITIZED_OPERATORS.get(provider, set())
    names = site_names(site)
    best = None
    best_distance = DIGITIZED_MATCH_RADIUS_M
    for camera in digitized:
        if camera["operator"] not in operators or not names & camera["names"]:
            continue
        distance = distance_m(site["longitude"], site["latitude"], *camera["coordinates"])
        if distance <= best_distance:
            best, best_distance = camera, distance
    return best


def match_site_sheet(site: dict, alertwest_sites: list[dict]) -> dict | None:
    names = site_names(site)
    for other in alertwest_sites:
        if not names & site_names(other):
            continue
        if distance_m(site["longitude"], site["latitude"], other["longitude"], other["latitude"]) <= SITE_SHEET_MATCH_RADIUS_M:
            return other
    return None


def site_names(site: dict) -> set[str]:
    return {normalize_site_name(name) for name in [site["name"], *site["aliases"]]} - {""}


def normalize_site_name(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def slugify(value: str) -> str:
    slug = "".join(character.lower() if character.isalnum() else "-" for character in value)
    return "-".join(part for part in slug.split("-") if part)


def distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    # equirectangular is accurate to well under a meter at these distances
    meters_per_degree = 111_320.0
    dx = (lon1 - lon2) * meters_per_degree * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat1 - lat2) * meters_per_degree
    return math.hypot(dx, dy)


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
