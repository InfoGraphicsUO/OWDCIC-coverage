#!/usr/bin/env python3
"""dissolves every provider's viewshed coverage into one Mapbox tileset

Separate provider fills drawn in the same color stack their opacity where they
overlap; this one dissolved layer lets the map draw shared-color coverage as a
single continuous fill. Rebuild and re-upload it whenever any provider's
viewsheds change.

Run under the QGIS Python like gdal-camera-viewsheds.py:

    python scripts/build-combined-viewshed-coverage.py
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS.parent
# provider web packages written by gdal-camera-viewsheds.py
DEFAULT_PROVIDERS = (
    PROJECT_ROOT / "outputs/gdal_viewsheds_alertwest/mapbox/camera_viewsheds_web_epsg5070.gpkg",
    PROJECT_ROOT / "outputs/gdal_viewsheds_pano/mapbox/camera_viewsheds_web_epsg5070.gpkg",
)
DEFAULT_OUTPUT = PROJECT_ROOT / "outputs/gdal_viewsheds_combined/mapbox"
PRODUCT_NAME = "combined-camera-viewshed-coverage"

# share the viewshed engine's geometry repair and Mapbox settings
sys.path.insert(0, str(SCRIPTS))
_spec = importlib.util.spec_from_file_location("gdal_camera_viewsheds", SCRIPTS / "gdal-camera-viewsheds.py")
viewsheds = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = viewsheds
_spec.loader.exec_module(viewsheds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--providers", type=Path, nargs="+", default=list(DEFAULT_PROVIDERS))
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--qgis-app", type=Path, default=viewsheds.DEFAULT_QGIS_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    viewsheds.apply_qgis_environment(args.qgis_app)
    viewsheds.require_gdal()

    canonical = viewsheds.spatial_reference(viewsheds.CANONICAL_CRS)
    web_srs = viewsheds.spatial_reference(viewsheds.WEB_CRS)
    coverages = []
    for path in args.providers:
        srs, rows = viewsheds.read_features(path, viewsheds.COVERAGE_LAYER)
        if len(rows) != 1 or rows[0][0] is None:
            raise RuntimeError(f"{path} must hold one dissolved coverage feature")
        if not srs or viewsheds.epsg_code(srs) != viewsheds.CANONICAL_CRS:
            raise RuntimeError(f"{path} coverage must use EPSG:5070")
        coverages.append(rows[0][0])
        print(f"loaded coverage from {path}", flush=True)

    # union in the projected CRS, then reproject and repair like the provider products
    coverage = viewsheds.union_polygons(coverages)
    if coverage.IsEmpty():
        raise RuntimeError("combined coverage is empty")
    coverage.Transform(viewsheds.transformation(canonical, web_srs))
    coverage = viewsheds.repair_polygon_parts(coverage)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    geojson = args.output_dir / f"{PRODUCT_NAME}.geojson"
    mbtiles = args.output_dir / f"{PRODUCT_NAME}-z5.mbtiles"
    viewsheds.write_features(
        geojson,
        "GeoJSON",
        viewsheds.COVERAGE_LAYER,
        web_srs,
        viewsheds.COVERAGE_FIELDS,
        [(coverage, {"coverage_id": "all"})],
        ["RFC7946=YES", "COORDINATE_PRECISION=9"],
    )
    viewsheds.validate_vector(geojson, None, 1)

    tippecanoe = viewsheds.find_tippecanoe()
    if not tippecanoe:
        raise RuntimeError("tippecanoe is required to build the MBTiles")
    viewsheds.safe_unlink(mbtiles)
    result = subprocess.run(
        [
            str(tippecanoe),
            "--force",
            f"--minimum-zoom={viewsheds.MAPBOX_MIN_ZOOM}",
            f"--maximum-zoom={viewsheds.MAPBOX_MAX_ZOOM}",
            "--drop-densest-as-needed",
            f"--output={mbtiles}",
            # same layer name as the provider tilesets so the map styles it identically
            "-L",
            f"{viewsheds.COVERAGE_LAYER}:{geojson}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-20:])
        raise RuntimeError(f"tippecanoe failed ({result.returncode})\n{tail}")
    print(f"wrote {mbtiles}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
