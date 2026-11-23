#!/usr/bin/env python3
"""build the selectable utility service area and federal land GeoJSON products

utility areas are the BPA investor-owned utility boundaries, clipped to OR/WA.
Federal land is the PAD-US federal fee layer unioned into one feature per
managing agency plus a combined Interior feature
area and viewshed metrics stay null until scripts/build-selection-metrics.py is run

run with the QGIS bundled Python for the GDAL bindings
"""

from __future__ import annotations

import argparse
import json

from osgeo import ogr

from division_common import OUT, arcgis_query, clip_to_project_boundary, feature_collection, pending_metrics, write_collection

UTILITY_QUERY = (
    "https://services3.arcgis.com/Iz3chmSt4P7oOoZy/arcgis/rest/services/"
    "BPA_CustomerIOU/FeatureServer/0/query"
)
FEDERAL_QUERY = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0/query"
)
# BPA names mapped to the labels the map shows; PacifiCorp and PGE keep their
# earlier labels so existing share links still resolve. Utilities outside
# OR/WA (Northwestern Energy, Rocky Mountain Power, Sierra Pacific) drop out when clipped
UTILITY_LABELS = {
    "Avista Energy": "Avista Utilities",
    "Idaho Power Company": "Idaho Power",
    "PacifiCorp": "Pacific Power (PacifiCorp)",
    "Portland General Electric": "Portland General Electric (PGE)",
    "Puget Sound Energy": "Puget Sound Energy (PSE)",
}
FEDERAL_MANAGERS = {
    "BLM": "Bureau of Land Management",
    "DOD": "U.S. Department of Defense",
    "FWS": "U.S. Fish and Wildlife Service",
    "NPS": "National Park Service",
    "OTHF": "Other federal fee manager",
    "USBR": "U.S. Bureau of Reclamation",
    "USFS": "National Forest",
}
# one combined option for the interior bureaus, whose land the US Wildland Fire
# Service manages for fire; build-wildland-fire-units.py splits it by unit.
# the per-agency features stay in the file because the land mix chart still splits them
INTERIOR_MANAGERS = ("BLM", "FWS", "NPS")
INTERIOR_NAME = "US Wildland Fire Service"


def fetch(url: str, where: str, fields: str) -> tuple[list[dict], str]:
    """returns the service features and a hash of the raw response"""
    params = {
        "where": where,
        "outFields": fields,
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
    }
    payload, _, digest = arcgis_query(url, params, timeout=180)
    return payload["features"], digest


def polygon_geometry(feature: dict):
    """returns a valid OGR geometry, or None for records without a shape"""
    rings = (feature.get("geometry") or {}).get("rings")
    if not rings:
        return None

    geometry = ogr.CreateGeometryFromJson(json.dumps({"type": "Polygon", "coordinates": rings}))

    # every ring goes in as one polygon, so multipart shapes come out invalid until MakeValid splits them
    return geometry if geometry.IsValid() else geometry.MakeValid()


def division_feature(division_type: str, source_id: str, name: str, geometry, extra=None) -> dict:
    west, east, south, north = geometry.GetEnvelope()
    division_id = f"{division_type}:{source_id}"
    return {
        "type": "Feature",
        "id": division_id,
        "geometry": json.loads(geometry.ExportToJson()),
        "bbox": [west, south, east, north],
        "properties": {
            "divisionId": division_id,
            "divisionType": division_type,
            "name": name,
            "label": name,
            "labelPoint": [(west + east) / 2, (south + north) / 2],
            **(extra or {}),
            **pending_metrics(),
        },
    }


def write_division_type(division_type: str, features: list[dict], metadata: dict) -> None:
    write_collection(OUT / f"{division_type}.geojson",
                     feature_collection(division_type, features, **metadata))
    print(f"{division_type}: {len(features)} features")


def build_utilities() -> None:
    rows, digest = fetch(UTILITY_QUERY, "1=1", "OBJECTID,NAME,BES_NUM")
    features = []

    for row in sorted(rows, key=lambda item: item["attributes"]["BES_NUM"]):
        attributes = row["attributes"]
        features.append(division_feature(
            "utility",
            # the BPA customer number, which stays the same across BPA republishes
            attributes["BES_NUM"],
            UTILITY_LABELS.get(attributes["NAME"], attributes["NAME"]),
            polygon_geometry(row),
            {"boundaryQualifier": "Approximate service area"},
        ))

    features, outside = clip_to_project_boundary(features)
    missing = set(UTILITY_LABELS.values()) - {feature["properties"]["name"] for feature in features}
    if missing:
        raise RuntimeError(f"expected utilities missing after clipping: {sorted(missing)}")

    write_division_type("utility", features, {
        "source": UTILITY_QUERY,
        "vintage": "2025",
        "sourceSha256": digest,
        "coverageNote": "BPA investor-owned utility boundaries; accuracy varies by utility",
        "clippedTo": "data/source/or-wa-boundary.geojson",
        "excludedOutsideBoundaryFeatures": outside,
    })


def build_federal_land() -> None:
    rows, digest = fetch(FEDERAL_QUERY, "State_Nm IN ('OR','WA')", "OBJECTID,Mang_Name")
    by_manager: dict[str, object] = {}

    for row in rows:
        code = row["attributes"]["Mang_Name"]
        geometry = polygon_geometry(row)
        # tribal fee parcels are covered by the tribal land selection
        if code == "TRIB" or geometry is None:
            continue
        by_manager[code] = by_manager[code].Union(geometry) if code in by_manager else geometry

    if set(by_manager) != set(FEDERAL_MANAGERS):
        raise RuntimeError(f"unexpected PAD-US manager codes: {sorted(by_manager)}")

    features = [
        division_feature("federal-land", code, FEDERAL_MANAGERS[code], by_manager[code])
        for code in sorted(by_manager)
    ]
    # union, not a sum, so land shared between bureaus is counted once
    interior = None

    for code in INTERIOR_MANAGERS:
        interior = interior.Union(by_manager[code]) if interior else by_manager[code]

    features.append(division_feature("federal-land", "DOI", INTERIOR_NAME, interior))
    write_division_type("federal-land", features, {
        "source": FEDERAL_QUERY,
        "vintage": "PAD-US authoritative",
        "sourceSha256": digest,
        "aggregation": "Union by PAD-US Mang_Name; excluded TRIB; DOI (US Wildland Fire Service) is the union of BLM, FWS, NPS",
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", choices=("utility", "federal-land"))
    wanted = parser.parse_args().only or ("utility", "federal-land")

    ogr.UseExceptions()
    OUT.mkdir(parents=True, exist_ok=True)
    if "utility" in wanted:
        build_utilities()
    if "federal-land" in wanted:
        build_federal_land()


if __name__ == "__main__":
    main()
