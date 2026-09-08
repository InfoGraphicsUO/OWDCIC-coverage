#!/usr/bin/env python3
"""adds precomputed camera viewshed coverage to the county map data"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

try:
    from osgeo import ogr, osr
except ImportError:
    ogr = osr = None
else:
    ogr.UseExceptions()
    osr.UseExceptions()


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COUNTIES = ROOT / "data" / "divisions" / "counties.geojson"
DEFAULT_COVERAGE = (
    ROOT
    / "outputs"
    / "gdal_viewsheds"
    / "mapbox"
    / "camera_viewsheds_web_epsg5070.gpkg"
)
DEFAULT_LAYER = "camera_viewshed_coverage"
AREA_CRS = 5070
COVERAGE_FIELDS = (
    "countyAreaSqKm",
    "cameraViewshedAreaSqKm",
    "cameraViewshedCoveragePct",
)


def require_ogr() -> None:
    """fails with the runtime needed for area calculations"""
    if ogr is None or osr is None:
        raise RuntimeError(
            "GDAL Python bindings are unavailable; run with the QGIS-bundled Python"
        )


def load_geojson(path: Path) -> dict[str, Any]:
    """loads a GeoJSON object from disk"""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("type") != "FeatureCollection" or not isinstance(
        payload.get("features"), list
    ):
        raise ValueError("county input must be a FeatureCollection")
    return payload


def load_coverage(path: Path, layer_name: str):
    """loads one dissolved coverage geometry and its projected CRS"""
    require_ogr()
    dataset = ogr.Open(str(path))
    if dataset is None:
        raise FileNotFoundError(f"could not open camera coverage: {path}")

    layer = dataset.GetLayerByName(layer_name)
    if layer is None:
        raise ValueError(f"camera coverage layer not found: {layer_name}")
    if layer.GetFeatureCount() != 1:
        raise ValueError("camera coverage layer must contain one dissolved feature")

    spatial_reference = layer.GetSpatialRef()
    feature = layer.GetNextFeature()
    geometry = feature.GetGeometryRef() if feature is not None else None
    if spatial_reference is None or geometry is None or geometry.IsEmpty():
        raise ValueError("camera coverage layer has no usable geometry or CRS")
    spatial_reference.AutoIdentifyEPSG()
    if spatial_reference.GetAuthorityCode(None) != str(AREA_CRS):
        raise ValueError(f"camera coverage layer must use EPSG:{AREA_CRS}")

    # clone before releasing the feature and dataset handles
    return geometry.Clone(), spatial_reference.Clone()


def enrich_counties(
    geojson: dict[str, Any], coverage_geometry, coverage_crs, coverage_source: str
) -> dict[str, Any]:
    """calculates non-overlapping covered area for every county"""
    require_ogr()
    source_crs = osr.SpatialReference()
    source_crs.ImportFromEPSG(4326)
    source_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    coverage_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transformation = osr.CoordinateTransformation(source_crs, coverage_crs)

    for feature in geojson["features"]:
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise ValueError("county feature has no properties")

        county = ogr.CreateGeometryFromJson(json.dumps(feature.get("geometry")))
        if county is None or county.IsEmpty():
            raise ValueError(f"county {properties.get('geoid')} has no usable geometry")
        county.AssignSpatialReference(source_crs)
        county.Transform(transformation)
        if not county.IsValid():
            county = county.MakeValid()

        county_area_sq_m = county.GetArea()
        if not math.isfinite(county_area_sq_m) or county_area_sq_m <= 0:
            raise ValueError(f"county {properties.get('geoid')} has invalid area")

        covered = county.Intersection(coverage_geometry)
        covered_area_sq_m = 0.0 if covered is None or covered.IsEmpty() else covered.GetArea()
        properties.update(coverage_metrics(county_area_sq_m, covered_area_sq_m))

    geojson["coverageMetadata"] = {
        "source": coverage_source,
        "areaCrs": f"EPSG:{AREA_CRS}",
        "overlapHandling": "dissolved before county intersection",
    }
    validate_coverage(geojson)
    return geojson


def coverage_metrics(county_area_sq_m: float, covered_area_sq_m: float) -> dict[str, float]:
    """returns stable square-kilometer and percentage values"""
    if not all(math.isfinite(value) for value in (county_area_sq_m, covered_area_sq_m)):
        raise ValueError("coverage areas must be finite")
    if county_area_sq_m <= 0 or covered_area_sq_m < 0:
        raise ValueError("coverage areas are outside the valid range")

    # geometry rounding can leave a tiny overshoot at a shared edge
    covered_area_sq_m = min(covered_area_sq_m, county_area_sq_m)
    return {
        "countyAreaSqKm": round(county_area_sq_m / 1_000_000, 3),
        "cameraViewshedAreaSqKm": round(covered_area_sq_m / 1_000_000, 3),
        "cameraViewshedCoveragePct": round(
            covered_area_sq_m / county_area_sq_m * 100, 2
        ),
    }


def validate_coverage(geojson: dict[str, Any]) -> None:
    """checks every county has a complete and plausible metric set"""
    for feature in geojson.get("features", []):
        properties = feature.get("properties", {})
        if not all(field in properties for field in COVERAGE_FIELDS):
            raise ValueError("county coverage fields are incomplete")

        county_area = properties["countyAreaSqKm"]
        covered_area = properties["cameraViewshedAreaSqKm"]
        percentage = properties["cameraViewshedCoveragePct"]
        if not all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            for value in (county_area, covered_area, percentage)
        ):
            raise ValueError("county coverage fields must be finite numbers")
        if county_area <= 0 or not 0 <= covered_area <= county_area:
            raise ValueError("county coverage areas are outside the valid range")
        if not 0 <= percentage <= 100:
            raise ValueError("county coverage percentage is outside the valid range")


def render(geojson: dict[str, Any]) -> str:
    """renders deterministic compact GeoJSON"""
    return json.dumps(
        geojson,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ) + "\n"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Precompute county area covered by the dissolved camera viewshed"
    )
    parser.add_argument("--counties", type=Path, default=DEFAULT_COUNTIES)
    parser.add_argument("--coverage", type=Path, default=DEFAULT_COVERAGE)
    parser.add_argument("--coverage-layer", default=DEFAULT_LAYER)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--check", action="store_true", help="compare calculated data without writing"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output = args.output or args.counties
    counties = load_geojson(args.counties)
    coverage_geometry, coverage_crs = load_coverage(
        args.coverage, args.coverage_layer
    )
    rendered = render(
        enrich_counties(
            counties,
            coverage_geometry,
            coverage_crs,
            f"{args.coverage.name}:{args.coverage_layer}",
        )
    )

    if args.check:
        try:
            existing = output.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"missing county coverage output: {output}", file=sys.stderr)
            return 1
        if existing != rendered:
            print(f"county coverage output is out of date: {output}", file=sys.stderr)
            return 1
        print(f"county coverage is current: {output}")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"wrote camera coverage for {len(counties['features'])} counties to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
