#!/usr/bin/env python3
# run with
# python scripts/csv-to-geojson.py data/{filename}.csv data/{filename}.geojson

from __future__ import annotations

import csv
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE.parent / "data" / "Site Installation Dates(Site, Coordinates, & Elevation).csv"
DEFAULT_OUTPUT = HERE.parent / "data" / "sites.geojson"

AW_LIVE = re.compile(r"^AW\s*\(Live\)$", re.I)


def main() -> None:
    input_path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT)
    output_path = Path(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT)
    geojson = csv_to_geojson(input_path.read_text(encoding="utf-8-sig"))
    output_path.write_text(json.dumps(geojson, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(geojson['features'])} features to {output_path}")


def csv_to_geojson(text: str) -> dict:
    """turns the site CSV into Point features

    sheet has two tables under one header: heights then AW (Live) aliases
    """
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError("CSV is empty")

    col = column_index(rows[0])
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
                # GeoJSON is lon, lat
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


def column_index(header: list[str]) -> dict[str, int]:
    names = [value.strip().lower() for value in header]
    return {
        "name": find_column(names, ["site name", "name", "site"]),
        "latitude": find_column(names, ["lattitude", "latitude", "lat"]),
        "longitude": find_column(names, ["longitude", "long", "lon", "lng"]),
        "height": find_column(
            names,
            ["camera height (ft)", "camera height", "height", "elevation"],
        ),
    }


def find_column(names: list[str], aliases: list[str]) -> int:
    for alias in aliases:
        if alias in names:
            return names.index(alias)
    raise ValueError(f"missing column (tried {', '.join(aliases)})")


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
