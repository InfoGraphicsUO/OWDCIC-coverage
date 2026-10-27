#!/usr/bin/env python3
"""builds data/live/region-focus.geojson, the shapes behind the map's region outline and outside hatching

the western states come from Census TIGERweb and Canada from Esri's generalized
world countries, simplified on the service as the map used to request them on
every visit. js/states-highlight.js turns them into the hatch and outline.
rerun only if a source boundary changes
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from division_common import ROOT, arcgis_query

DEFAULT_OUTPUT = ROOT / "data" / "live" / "region-focus.geojson"

STATES_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/10/query"
COUNTRIES_URL = ("https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/"
                 "World_Countries_(Generalized)/FeatureServer/0/query")

# states that intersect or sit immediately around the map's constrained bounds
WESTERN_STATE_FIPS = ("04", "06", "08", "16", "30", "32", "41", "49", "53", "56")

# 5 decimal places plus a 0.002 degree offset keep the file small
SIMPLIFY = {"geometryPrecision": "5", "maxAllowableOffset": "0.002"}


def query(url: str, **params) -> tuple[list[dict], str]:
    payload, source, _ = arcgis_query(url, {
        "f": "geojson", "returnGeometry": "true", "outSR": "4326", **SIMPLIFY, **params,
    })
    return payload["features"], source


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = ap.parse_args()

    states, states_source = query(
        STATES_URL,
        where=f"STATE IN ({','.join(repr(fips) for fips in WESTERN_STATE_FIPS)})",
        outFields="STATE,GEOID", orderByFields="OID")
    countries, countries_source = query(COUNTRIES_URL, where="ISO='CA'", outFields="ISO", orderByFields="FID")

    if len(states) != len(WESTERN_STATE_FIPS) or len(countries) != 1:
        raise SystemExit(f"expected {len(WESTERN_STATE_FIPS)} states and Canada, got {len(states)} and {len(countries)}")

    collection = {
        "type": "FeatureCollection",
        "features": [*states, *countries],
        "metadata": {"sources": [states_source, countries_source]},
    }
    args.output.write_text(json.dumps(collection, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{args.output.relative_to(ROOT)}: {len(states)} states and Canada, {args.output.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__": main()
