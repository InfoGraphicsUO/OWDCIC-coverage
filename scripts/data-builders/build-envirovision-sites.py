#!/usr/bin/env python3
"""convert ODF's EnviroVision (ForestWatch) camera geodatabase to site GeoJSON and a camera CSV

    python scripts/data-builders/build-envirovision-sites.py EVS_DetectionCameraLocations.gdb.zip

runs under the QGIS Python for its bundled GDAL. ODF keeps one record per camera,
so cameras sharing a point are merged into one site; the viewshed is modeled once
per site from its tallest camera
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from osgeo import ogr, osr

ogr.UseExceptions()

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
SITE_DATA_BUILDER = ROOT / "scripts/csv-to-geojson.py"
PROVIDER = "envirovision"
# ODF's planning default; the source says many were never updated after installation
ASSUMED_HEIGHT_FT = 60.0
# an ALERTWest site this close is the same tower, so the map sets the markers side by side
SHARED_SITE_RADIUS_M = 150.0
# coded value domains in the geodatabase that the map reports by name
DOMAIN_FIELDS = {
    "ProtectionDistrict": "protectionDistrict",
    "ProtectionUnit": "protectionUnit",
    "DetectionCenter": "detectionCenter",
}
CSV_FIELDS = [
    "site", "camera", "latitude", "longitude", "ground_elevation_ft", "camera_height_ft",
    "protection_district", "protection_unit", "detection_center", "site_id",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="EVS_DetectionCameraLocations.gdb or its .zip")
    parser.add_argument("--sites", type=Path, default=DATA / "envirovision-sites.geojson")
    parser.add_argument("--cameras", type=Path, default=DATA / "envirovision-cameras.csv")

    return parser.parse_args()


def load_converter():
    """csv-to-geojson.py holds the shared county, slug, and distance helpers"""
    spec = importlib.util.spec_from_file_location("csv_to_geojson", SITE_DATA_BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def read_cameras(source: Path) -> list[dict]:
    path = f"/vsizip/{source}" if source.suffix == ".zip" else str(source)
    dataset = ogr.Open(path)
    layer = dataset.GetLayer(0)
    domains = {
        field: dataset.GetFieldDomain(layer.GetLayerDefn().GetFieldDefn(
            layer.GetLayerDefn().GetFieldIndex(field)).GetDomainName()).GetEnumeration()
        for field in DOMAIN_FIELDS
    }
    wgs84 = osr.SpatialReference()
    wgs84.ImportFromEPSG(4326)
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source_srs = layer.GetSpatialRef()
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to_wgs84 = osr.CoordinateTransformation(source_srs, wgs84)

    cameras = []

    for feature in layer:
        geometry = feature.GetGeometryRef()
        # the point is authoritative; a few Latitude/Longitude attributes are stale or missing a sign
        # rounded in the source CRS so cameras on the same point share a key
        key = (round(geometry.GetX(), 1), round(geometry.GetY(), 1))
        point = geometry.Clone()
        point.Transform(to_wgs84)
        camera = {
            "key": key,
            "camera": feature.GetField("Site").strip(),
            "longitude": round(point.GetX(), 6),
            "latitude": round(point.GetY(), 6),
            "groundElevationFt": feature.GetField("GroundElevation"),
            "cameraHeightFt": feature.GetField("Offset"),
            "siteId": feature.GetField("Site_ID"),
        }

        for field, name in DOMAIN_FIELDS.items():
            code = feature.GetField(field)
            camera[name] = None if code is None else domains[field].get(str(code), str(code))

        cameras.append(camera)

    return cameras


def site_name(names: list[str]) -> str:
    """the words every camera at the site shares, e.g. Tallowbox East + Tallowbox West"""
    words = [name.split() for name in names]
    shared = []

    for parts in zip(*words):
        if len(set(parts)) > 1:
            break
        shared.append(parts[0])

    return " ".join(shared) or names[0]


def build_sites(cameras: list[dict], converter) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}

    for camera in cameras:
        groups.setdefault(camera["key"], []).append(camera)

    sites = []

    for members in groups.values():
        heights = sorted({camera["cameraHeightFt"] for camera in members if camera["cameraHeightFt"] is not None})
        sites.append({
            "name": site_name([camera["camera"] for camera in members]),
            "members": members,
            "heights": heights,
        })

    # two unrelated sites can share a name, e.g. Elk Mountain; their protection unit tells them apart
    counts: dict[str, int] = {}

    for site in sites:
        counts[site["name"]] = counts.get(site["name"], 0) + 1

    for site in sites:
        if counts[site["name"]] > 1:
            site["name"] = f"{site['name']} ({site['members'][0]['protectionUnit']})"

    counties = converter.load_counties(converter.DEFAULT_COUNTIES)
    alertwest = json.loads((DATA / "alertwest-sites.geojson").read_text(encoding="utf-8"))["features"]
    features = []

    for site in sorted(sites, key=lambda site: site["name"]):
        first = site["members"][0]
        point = [first["longitude"], first["latitude"]]
        height = site["heights"][-1] if site["heights"] else None
        properties = {
            "name": site["name"],
            "aliases": sorted({camera["camera"] for camera in site["members"]} - {site["name"]}),
            "cameraHeightFt": height,
            "cameraCount": len(site["members"]),
            "groundElevationFt": first["groundElevationFt"],
            "viewshedId": f"{PROVIDER}-{converter.slugify(site['name'])}",
            "provider": PROVIDER,
        }

        if len(site["heights"]) > 1:
            properties["cameraHeightsFt"] = site["heights"]

        if height == ASSUMED_HEIGHT_FT:
            properties["cameraHeightEstimated"] = True

        for name in DOMAIN_FIELDS.values():
            properties[name] = first[name]

        if any(
            converter.distance_m(*point, *other["geometry"]["coordinates"]) <= SHARED_SITE_RADIUS_M
            for other in alertwest
        ):
            properties["sharesAlertWestSite"] = True

        county = converter.county_at(point, counties)
        if county:
            properties["county"] = county["name"]
            properties["state"] = county["state"]

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": point},
            "properties": properties,
        })

        for camera in site["members"]:
            camera["site"] = site["name"]

    return features


def write_cameras(path: Path, cameras: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(CSV_FIELDS)
        for camera in sorted(cameras, key=lambda camera: (camera["site"], camera["camera"])):
            writer.writerow([
                camera["site"], camera["camera"], camera["latitude"], camera["longitude"],
                camera["groundElevationFt"], camera["cameraHeightFt"], camera["protectionDistrict"],
                camera["protectionUnit"], camera["detectionCenter"], camera["siteId"],
            ])


def main() -> None:
    args = parse_args()
    converter = load_converter()
    cameras = read_cameras(args.source)
    features = build_sites(cameras, converter)
    converter.write_geojson(args.sites, {"type": "FeatureCollection", "features": features})
    write_cameras(args.cameras, cameras)
    print(f"wrote {len(cameras)} cameras to {args.cameras}")
    # the site builder marks which sites still need a viewshed and refreshes the queues
    subprocess.run([sys.executable, str(SITE_DATA_BUILDER)], check=True)


if __name__ == "__main__":
    main()
