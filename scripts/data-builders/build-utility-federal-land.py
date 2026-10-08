#!/usr/bin/env python3
"""Build the selectable utility service area and federal land GeoJSON products.

Utility areas come from the Oregon utility incentive layer; Washington has no
accessible service-area layer. Federal land is the PAD-US federal fee layer
unioned into one feature per managing agency. Area and viewshed metrics stay
null until scripts/build-selection-metrics.py is run.

Run with the QGIS bundled Python for the GDAL bindings.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from osgeo import ogr

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "divisions"
UTILITY_QUERY = (
    "https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/"
    "Oregon_Natural_Gas_and_Electric_Utility_Incentive_Layer_Update_13Dec2024_v01/"
    "FeatureServer/0/query"
)
FEDERAL_QUERY = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0/query"
)
UTILITY_ABBREVIATIONS = {
    "Eugene Water & Electric Board": "EWEB",
    "Portland General Electric": "PGE",
    "Pacific Power (PacifiCorp)": None,
}
FEDERAL_MANAGERS = {
    "BLM": "Bureau of Land Management",
    "DOD": "U.S. Department of Defense",
    "FWS": "U.S. Fish and Wildlife Service",
    "NPS": "National Park Service",
    "OTHF": "Other federal fee manager",
    "USBR": "U.S. Bureau of Reclamation",
    "USFS": "U.S. Forest Service",
}


def fetch(url: str, where: str, fields: str) -> tuple[list[dict], str]:
    """Return the service features and a hash of the raw response."""
    params = {
        "where": where,
        "outFields": fields,
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
    }
    with urlopen(f"{url}?{urlencode(params)}", timeout=180) as response:
        raw = response.read()
    payload = json.loads(raw.decode("utf-8"))
    if "error" in payload:
        raise RuntimeError(f"{url}: {payload['error']}")
    if payload.get("exceededTransferLimit"):
        raise RuntimeError(f"{url}: query was truncated by the service")
    return payload["features"], hashlib.sha256(raw).hexdigest()


def polygon_geometry(feature: dict):
    """Return a valid OGR geometry, or None for records without a shape."""
    rings = (feature.get("geometry") or {}).get("rings")
    if not rings:
        return None
    geometry = ogr.CreateGeometryFromJson(json.dumps({"type": "Polygon", "coordinates": rings}))
    # multipart source shapes arrive as one ring list and need splitting
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
            "landAreaSqKm": None,
            "cameraViewshedAreaSqKm": None,
            "cameraViewshedCoveragePct": None,
            "landMix": [],
        },
    }


def write_collection(division_type: str, features: list[dict], metadata: dict) -> None:
    collection = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "schemaVersion": 1,
            "divisionType": division_type,
            **metadata,
            "areaCrs": "EPSG:5070",
            "metricsStatus": "pending-gdal-coverage-build",
        },
    }
    path = OUT / f"{division_type}.geojson"
    path.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n",
                    encoding="utf-8")
    print(f"{division_type}: {len(features)} features")


def build_utilities() -> None:
    names = ",".join(f"'{name}'" for name in UTILITY_ABBREVIATIONS)
    rows, digest = fetch(UTILITY_QUERY, f"Utility_Name IN ({names})", "OBJECTID,Utility_Name")
    features = []
    for row in sorted(rows, key=lambda item: item["attributes"]["OBJECTID"]):
        attributes = row["attributes"]
        name = attributes["Utility_Name"]
        abbreviation = UTILITY_ABBREVIATIONS[name]
        features.append(division_feature(
            "utility",
            attributes["OBJECTID"],
            f"{name} ({abbreviation})" if abbreviation else name,
            polygon_geometry(row),
            {"boundaryQualifier": "Approximate service area"},
        ))
    if len(features) != len(UTILITY_ABBREVIATIONS):
        raise RuntimeError(f"expected {len(UTILITY_ABBREVIATIONS)} utilities, received {len(features)}")
    write_collection("utility", features, {
        "source": UTILITY_QUERY,
        "vintage": "2024",
        "sourceSha256": digest,
        "coverageNote": "Oregon official service areas; Washington layer unavailable",
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
    write_collection("federal-land", features, {
        "source": FEDERAL_QUERY,
        "vintage": "PAD-US authoritative",
        "sourceSha256": digest,
        "aggregation": "Union by PAD-US Mang_Name; excluded TRIB",
    })


def main():
    ogr.UseExceptions()
    OUT.mkdir(parents=True, exist_ok=True)
    build_utilities()
    build_federal_land()


if __name__ == "__main__":
    main()
