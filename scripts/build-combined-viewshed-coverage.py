#!/usr/bin/env python3
"""dissolves every provider's viewshed coverage into one Mapbox tileset

Separate provider fills drawn in the same color stack their opacity where they
overlap; this one dissolved layer lets the map draw shared-color coverage as a
single continuous fill. Rebuild and re-upload it whenever any provider's
viewsheds change.

Run under the QGIS Python like gdal-camera-viewsheds.py:

    python scripts/build-combined-viewshed-coverage.py

A viewshed run with --combined-coverage does the same thing when it finishes.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent

# share the viewshed engine, which can also build this at the end of a run
sys.path.insert(0, str(SCRIPTS))
_spec = importlib.util.spec_from_file_location("gdal_camera_viewsheds", SCRIPTS / "gdal-camera-viewsheds.py")
viewsheds = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = viewsheds
_spec.loader.exec_module(viewsheds)

# provider web packages written by gdal-camera-viewsheds.py
DEFAULT_PROVIDERS = tuple(
    folder / viewsheds.WEB_PACKAGE for folder in viewsheds.PROVIDER_OUTPUTS.values()
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--providers", type=Path, nargs="+", default=list(DEFAULT_PROVIDERS))
    parser.add_argument("--output-dir", type=Path, default=viewsheds.DEFAULT_COMBINED_OUTPUT)
    parser.add_argument("--qgis-app", type=Path, default=viewsheds.DEFAULT_QGIS_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    viewsheds.apply_qgis_environment(args.qgis_app)
    viewsheds.require_gdal()
    viewsheds.build_combined_coverage(args.providers, args.output_dir, lambda message: print(message, flush=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
