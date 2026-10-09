#!/usr/bin/env python3
"""builds the transmission line GeoJSON drawn by the web map's Transmission lines layer

The source is the OHAZ network folder's archive of the public U.S. Electric
Power Transmission Lines service (transmission_lines_2024_archive.gpkg), which
is not in this repo. Needs the QGIS Python for its GDAL bindings.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from qgis_runtime import qgis_runtime

# reprojection needs proj.db, which the bare QGIS Python does not locate itself
os.environ.setdefault("PROJ_DATA", str(qgis_runtime().proj_data))

from osgeo import gdal


DEFAULT_OUTPUT = PROJECT_ROOT / "data/transmission-lines.geojson"

# matches REGION_DATA_BOUNDS in js/config.js
REGION_BOUNDS = (-124.85, 41.99, -116.4, 49.01)
# meters in the archive's EPSG:5070; keeps the web file near 2 MB
SIMPLIFY_TOLERANCE = 20


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert the archived transmission line GeoPackage to web GeoJSON."
    )
    parser.add_argument("source", type=Path, help="transmission_lines_2024_archive.gpkg")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    gdal.UseExceptions()
    args.output.unlink(missing_ok=True)
    gdal.VectorTranslate(
        str(args.output),
        str(args.source),
        format="GeoJSON",
        dstSRS="EPSG:4326",
        # the only attributes worth carrying to the browser
        selectFields=["OWNER", "VOLTAGE"],
        simplifyTolerance=SIMPLIFY_TOLERANCE,
        options=["-clipdst", *map(str, REGION_BOUNDS)],
        layerName="transmission-lines",
        layerCreationOptions=["COORDINATE_PRECISION=5", "RFC7946=YES"],
    )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
