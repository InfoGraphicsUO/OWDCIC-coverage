#!/usr/bin/env python3
"""builds resumable projected camera viewsheds with QGIS-bundled GDAL"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import shutil
import signal
import subprocess
import sys
import time
from typing import Any

from qgis_runtime import QgisRuntime, default_qgis_root, qgis_runtime


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QGIS_ROOT = default_qgis_root()
DEFAULT_SITES = PROJECT_ROOT / "data/sites.geojson"
DEFAULT_DEMS = PROJECT_ROOT / "data/dems"
DEFAULT_OUTPUT = PROJECT_ROOT / "outputs/gdal_viewsheds"
DEFAULT_CLIP_BOUNDARY = PROJECT_ROOT / "data/or-wa-boundary.geojson"

PILOT_NAMES = ("Portland Tower",)
VALIDATION_NAMES = ("Portland Tower", "Quail Prairie Mtn", "Beaty's Butte")
CANONICAL_CRS = "EPSG:5070"
WEB_CRS = "EPSG:4326"
REFRACTION_COEFFICIENT = 0.13
INDIVIDUAL_LAYER = "camera_viewsheds"
COVERAGE_LAYER = "camera_viewshed_coverage"
MAPBOX_MIN_ZOOM = 5
MAPBOX_MAX_ZOOM = 12
STAGE_FRACTIONS = {
    "preparing": 0.00,
    "dem": 0.20,
    "viewshed": 0.35,
    "exact_polygon": 0.75,
    "web_polygon": 0.95,
    "complete": 1.00,
}


@dataclass(frozen=True)
class Site:
    source_id: int
    viewshed_id: str
    name: str
    longitude: float
    latitude: float
    height_ft: float | None
    aliases: tuple[str, ...]

    @property
    def height_m(self) -> float | None:
        return None if self.height_ft is None else self.height_ft * 0.3048

    @property
    def utm_epsg(self) -> int:
        zone = int((self.longitude + 180.0) // 6.0) + 1
        if zone not in (10, 11):
            raise ValueError(f"{self.name} falls in UTM zone {zone}; expected 10 or 11")
        return 26900 + zone

    @property
    def stem(self) -> str:
        return self.viewshed_id.replace("-", "_")


class CancelledError(RuntimeError):
    """raised after the user cancels the active process"""


class ProgressEmitter:
    """prints human logs plus machine-readable GUI progress"""

    def __init__(self, enabled: bool, total_sites: int) -> None:
        self.enabled = enabled
        self.total_sites = total_sites
        self.started = time.monotonic()

    def log(self, message: str) -> None:
        elapsed = format_duration(time.monotonic() - self.started)
        print(f"[{elapsed}] {message}", flush=True)

    def progress(
        self,
        site_index: int,
        site: Site | None,
        stage: str,
        detail: str,
    ) -> None:
        if site is None:
            percent = 0.0 if stage != "complete" else 100.0
        else:
            site_fraction = STAGE_FRACTIONS.get(stage, 0.0)
            percent = ((site_index - 1) + site_fraction) / self.total_sites * 100.0
        payload = {
            "percent": round(percent, 2),
            "site_index": site_index,
            "site_total": self.total_sites,
            "site_name": site.name if site else None,
            "stage": stage,
            "detail": detail,
            "elapsed_seconds": round(time.monotonic() - self.started, 1),
        }
        if self.enabled:
            print("@@PROGRESS@@" + json.dumps(payload, separators=(",", ":")), flush=True)
        self.log(detail)


ACTIVE_PROCESS: subprocess.Popen[str] | None = None
CANCEL_REQUESTED = False


def request_cancel(_signum: int, _frame: Any) -> None:
    global CANCEL_REQUESTED
    CANCEL_REQUESTED = True
    if ACTIVE_PROCESS and ACTIVE_PROCESS.poll() is None:
        try:
            if os.name == "nt":
                ACTIVE_PROCESS.terminate()
            else:
                os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create resumable 10 m GDAL camera viewsheds and polygon exports."
    )
    parser.add_argument(
        "--qgis-app",
        type=Path,
        default=DEFAULT_QGIS_ROOT,
        help="QGIS install root; defaults to auto-discovery or OWDCIC_QGIS_ROOT",
    )
    parser.add_argument("--sites", type=Path, default=DEFAULT_SITES)
    parser.add_argument("--dem-dir", type=Path, default=DEFAULT_DEMS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--mode",
        choices=("pilot", "validation", "production"),
        default="pilot",
    )
    parser.add_argument(
        "--site-name",
        action="append",
        dest="site_names",
        help="process only this camera; repeat for more than one",
    )
    parser.add_argument("--radius-miles", type=float, default=20.0)
    parser.add_argument("--cell-size", type=float, default=10.0)
    parser.add_argument("--web-resolution", type=float, default=50.0)
    parser.add_argument("--simplify-tolerance", type=float, default=25.0)
    parser.add_argument("--smooth-iterations", type=int, default=1)
    parser.add_argument("--web-clip-boundary", type=Path, default=DEFAULT_CLIP_BOUNDARY)
    parser.add_argument(
        "--web-clip",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="clip web polygons to Oregon and Washington (default: enabled)",
    )
    parser.add_argument(
        "--web-majority-filter",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="apply a 3x3 majority filter to the web mask (default: enabled)",
    )
    parser.add_argument("--min-web-patch-cells", type=int, default=0)
    parser.add_argument("--skip-exact-polygons", action="store_true")
    parser.add_argument("--keep-working-dems", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--json-progress", action="store_true")
    args = parser.parse_args()
    for name in ("radius_miles", "cell_size", "web_resolution"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.simplify_tolerance < 0 or args.smooth_iterations < 0 or args.min_web_patch_cells < 0:
        parser.error("simplification, smoothing, and patch thresholds cannot be negative")
    return args


def slugify(value: str) -> str:
    slug = "".join(character.lower() if character.isalnum() else "-" for character in value)
    return "-".join(part for part in slug.split("-") if part)


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, remainder = divmod(seconds, 60)
    if minutes < 60:
        return f"{int(minutes)}m {remainder:.0f}s"
    hours, minutes = divmod(minutes, 60)
    return f"{int(hours)}h {int(minutes)}m"


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load_sites(path: Path) -> list[Site]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("type") != "FeatureCollection":
        raise ValueError(f"sites file is not a GeoJSON FeatureCollection: {path}")
    sites: list[Site] = []
    for source_id, feature in enumerate(payload.get("features", []), start=1):
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        if geometry.get("type") != "Point" or len(geometry.get("coordinates", [])) < 2:
            raise ValueError(f"site {source_id} does not contain a Point geometry")
        longitude, latitude = map(float, geometry["coordinates"][:2])
        name = str(properties.get("name", "")).strip()
        raw_height = properties.get("cameraHeightFt")
        height_ft = None if raw_height in (None, "") else float(raw_height)
        site = Site(
            source_id=source_id,
            viewshed_id=slugify(name),
            name=name,
            longitude=longitude,
            latitude=latitude,
            height_ft=height_ft,
            aliases=tuple(map(str, properties.get("aliases", []))),
        )
        _ = site.utm_epsg
        sites.append(site)
    if not sites:
        raise ValueError(f"no camera sites found in {path}")
    return sites


def select_sites(sites: list[Site], args: argparse.Namespace) -> list[Site]:
    requested = args.site_names
    if not requested:
        requested = {
            "pilot": PILOT_NAMES,
            "validation": VALIDATION_NAMES,
            "production": tuple(site.name for site in sites),
        }[args.mode]
    by_name = {site.name.casefold(): site for site in sites}
    missing = [name for name in requested if name.casefold() not in by_name]
    if missing:
        raise ValueError(f"camera(s) not found: {', '.join(missing)}")
    return [by_name[name.casefold()] for name in requested]


def qgis_environment(qgis_root: Path) -> tuple[dict[str, str], QgisRuntime]:
    runtime = qgis_runtime(qgis_root)
    runtime.validate_tools()
    env = runtime.environment()
    env["OGR_GEOJSON_MAX_OBJ_SIZE"] = "0"
    for name in (
        "OWDCIC_QGIS_ROOT",
        "QGIS_PREFIX_PATH",
        "PROJ_DATA",
        "GDAL_DATA",
        "PATH",
        "PYTHONPATH",
        "QT_PLUGIN_PATH",
    ):
        if name in env:
            os.environ[name] = env[name]
    return env, runtime


def run_command(
    command: list[str],
    env: dict[str, str],
    emitter: ProgressEmitter,
    label: str,
    input_text: str | None = None,
) -> str:
    global ACTIVE_PROCESS
    if CANCEL_REQUESTED:
        raise CancelledError("run cancelled")
    emitter.log(f"starting {label}")
    started = time.monotonic()
    process_options: dict[str, Any] = {}
    if os.name == "nt":
        process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        process_options["start_new_session"] = True

    ACTIVE_PROCESS = subprocess.Popen(
        command,
        env=env,
        stdin=subprocess.PIPE if input_text is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        **process_options,
    )
    try:
        output, _ = ACTIVE_PROCESS.communicate(input=input_text)
    finally:
        process = ACTIVE_PROCESS
        ACTIVE_PROCESS = None
    if CANCEL_REQUESTED:
        raise CancelledError("run cancelled")
    if process.returncode:
        tail = "\n".join(output.strip().splitlines()[-20:])
        raise RuntimeError(f"{label} failed ({process.returncode})\n{tail}")
    emitter.log(f"finished {label} in {format_duration(time.monotonic() - started)}")
    return output


def output_paths(output_dir: Path, site: Site) -> dict[str, Path]:
    work = output_dir / "work" / site.stem
    return {
        "work": work,
        "dem": work / f"{site.stem}_dem_10m_epsg{site.utm_epsg}.tif",
        "mask": work / "visible_mask.tif",
        "raw": work / "visible_raw.gpkg",
        "web_raster": work / "web_generalized.tif",
        "web_mask": work / "web_mask.tif",
        "web_filtered": work / "web_majority.tif",
        "web_sieved": work / "web_sieved.tif",
        "web_raw": work / "web_raw.gpkg",
        "web_projected": work / "web_epsg5070.gpkg",
        "web_simplified": work / "web_simplified_epsg5070.gpkg",
        "web_smoothed": work / "web_smoothed_epsg5070.gpkg",
        "web_clipped": work / "web_clipped_epsg5070.gpkg",
        "raster": output_dir / "rasters_10m" / f"{site.stem}.tif",
        "exact": output_dir / "polygons_exact" / f"{site.stem}.gpkg",
        "web": output_dir / "web" / f"{site.viewshed_id}.geojson",
        "state": output_dir / "state" / f"{site.stem}.json",
    }


def safe_unlink(path: Path) -> None:
    if path.exists() and path.is_file():
        path.unlink()


def prepare_output(output_dir: Path) -> None:
    for name in ("rasters_10m", "polygons_exact", "web", "state", "work"):
        (output_dir / name).mkdir(parents=True, exist_ok=True)


def payload_hash(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analysis_config_payload(
    args: argparse.Namespace,
    dem_files: list[Path],
    sites_path: Path,
) -> dict[str, Any]:
    return {
        "sites_sha256": hashlib.sha256(sites_path.read_bytes()).hexdigest(),
        "dem_inventory": [
            {"name": path.name, "size": path.stat().st_size, "mtime_ns": path.stat().st_mtime_ns}
            for path in dem_files
        ],
        "radius_m": args.radius_miles * 1609.344,
        "cell_size_m": args.cell_size,
        "refraction_coefficient": REFRACTION_COEFFICIENT,
    }


def web_config_payload(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "web_resolution_m": args.web_resolution,
        "simplify_tolerance_m": args.simplify_tolerance,
        "smooth_iterations": args.smooth_iterations,
        "web_majority_filter": args.web_majority_filter,
        "min_web_patch_cells": args.min_web_patch_cells,
        "web_clip": args.web_clip,
        "web_clip_boundary_sha256": (
            file_sha256(args.web_clip_boundary) if args.web_clip else None
        ),
    }


def config_document(
    args: argparse.Namespace,
    dem_files: list[Path],
    sites_path: Path,
) -> dict[str, Any]:
    analysis = analysis_config_payload(args, dem_files, sites_path)
    web = web_config_payload(args)
    analysis_hash = payload_hash(analysis)
    web_hash = payload_hash({"analysis_hash": analysis_hash, **web})
    base = {
        "schema_version": 2,
        **analysis,
        **web,
        "exact_polygons": not args.skip_exact_polygons,
    }
    return {
        **base,
        "analysis_hash": analysis_hash,
        "web_hash": web_hash,
        "config_hash": payload_hash(base),
    }


def write_config(output_dir: Path, document: dict[str, Any]) -> None:
    (output_dir / "analysis_config.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )


def read_existing_config(output_dir: Path) -> dict[str, Any] | None:
    path = output_dir / "analysis_config.json"
    if not path.exists():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        return document if isinstance(document, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


ANALYSIS_CONFIG_KEYS = (
    "sites_sha256",
    "dem_inventory",
    "radius_m",
    "cell_size_m",
    "refraction_coefficient",
)


def analysis_configs_match(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
) -> bool:
    if not previous:
        return False
    return all(previous.get(key) == current.get(key) for key in ANALYSIS_CONFIG_KEYS)


def build_vrt(
    output_dir: Path,
    dem_files: list[Path],
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    overwrite: bool,
) -> Path:
    vrt = output_dir / "source_dems.vrt"
    if vrt.exists() and not overwrite:
        emitter.log(f"reusing DEM index: {vrt}")
        return vrt
    safe_unlink(vrt)
    run_command(
        [*runtime.tool("gdalbuildvrt"), str(vrt), *map(str, dem_files)],
        env,
        emitter,
        f"DEM index for {len(dem_files)} TIFFs",
    )
    return vrt


def prepare_web_clip_boundary(
    source: Path,
    output_dir: Path,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> Path:
    """projects the shared web clipping boundary to EPSG:5070"""

    projected = output_dir / "work/web_clip_boundary_epsg5070.gpkg"
    safe_unlink(projected)
    run_command(
        [
            *runtime.tool("ogr2ogr"),
            "-f",
            "GPKG",
            str(projected),
            str(source),
            "-t_srs",
            CANONICAL_CRS,
            "-makevalid",
            "-nln",
            "web_clip_boundary",
        ],
        env,
        emitter,
        "Oregon and Washington web clip boundary",
    )
    validate_vector(projected, "web_clip_boundary", runtime, env, emitter)
    if geopackage_feature_count(projected, "web_clip_boundary") != 1:
        raise RuntimeError("web clip boundary must contain exactly one feature")
    return projected


def transform_observer(
    site: Site,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> tuple[float, float]:
    output = run_command(
        [
            *runtime.tool("gdaltransform"),
            "-s_srs",
            WEB_CRS,
            "-t_srs",
            f"EPSG:{site.utm_epsg}",
        ],
        env,
        emitter,
        f"coordinate transform for {site.name}",
        input_text=f"{site.longitude} {site.latitude}\n",
    )
    x_text, y_text, *_ = output.strip().splitlines()[-1].split()
    return float(x_text), float(y_text)


def build_dem(
    site: Site,
    observer: tuple[float, float],
    source_vrt: Path,
    paths: dict[str, Path],
    radius_m: float,
    cell_size_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> None:
    x, y = observer
    margin = radius_m + cell_size_m
    bounds = (x - margin, y - margin, x + margin, y + margin)
    run_command(
        [
            *runtime.tool("gdalwarp"),
            "-overwrite",
            "-t_srs",
            f"EPSG:{site.utm_epsg}",
            "-te",
            *map(str, bounds),
            "-tr",
            str(cell_size_m),
            str(cell_size_m),
            "-tap",
            "-r",
            "bilinear",
            "-ot",
            "Float32",
            "-dstnodata",
            "-999999",
            "-multi",
            "-wo",
            "NUM_THREADS=ALL_CPUS",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "PREDICTOR=3",
            str(source_vrt),
            str(paths["dem"]),
        ],
        env,
        emitter,
        f"10 m projected DEM for {site.name}",
    )


def build_viewshed(
    site: Site,
    observer: tuple[float, float],
    paths: dict[str, Path],
    radius_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> None:
    x, y = observer
    curvature = 1.0 - REFRACTION_COEFFICIENT
    safe_unlink(paths["raster"])
    run_command(
        [
            *runtime.tool("gdal_viewshed"),
            "-ox",
            str(x),
            "-oy",
            str(y),
            # GDAL adds this AGL offset to the observer DEM cell
            "-oz",
            str(site.height_m),
            "-tz",
            "0",
            "-md",
            str(radius_m),
            # GDAL curvature coefficient is one minus refraction
            "-cc",
            str(curvature),
            "-vv",
            "1",
            "-iv",
            "0",
            "-ov",
            "0",
            "-a_nodata",
            "255",
            "-of",
            "GTiff",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "PREDICTOR=2",
            str(paths["dem"]),
            str(paths["raster"]),
        ],
        env,
        emitter,
        f"viewshed for {site.name}",
    )


def raster_summary(
    raster: Path,
    cell_size_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> dict[str, Any]:
    output = run_command(
        [*runtime.tool("gdalinfo"), "-json", "-stats", "-hist", str(raster)],
        env,
        emitter,
        f"raster validation for {raster.stem}",
    )
    info = json.loads(output)
    band = info["bands"][0]
    buckets = band.get("histogram", {}).get("buckets", [])
    visible_cells = int(buckets[1]) if len(buckets) > 1 else 0
    if band.get("minimum") != 0.0 or band.get("maximum") != 1.0 or visible_cells <= 0:
        raise RuntimeError(f"viewshed validation failed: {raster}")
    return {
        "width": int(info["size"][0]),
        "height": int(info["size"][1]),
        "visible_cells": visible_cells,
        "visible_area_sq_km": visible_cells * cell_size_m**2 / 1_000_000,
        "bytes": raster.stat().st_size,
    }


def build_mask(
    source: Path,
    destination: Path,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    label: str,
) -> None:
    safe_unlink(destination)
    run_command(
        [
            *runtime.tool("gdal_calc"),
            "-A",
            str(source),
            "--calc=A==1",
            "--type=Byte",
            "--NoDataValue=0",
            "--co=TILED=YES",
            "--co=COMPRESS=DEFLATE",
            f"--outfile={destination}",
        ],
        env,
        emitter,
        label,
    )


def majority_filter_array(values: Any) -> Any:
    """returns a binary raster where at least 5 of 9 cells are visible"""

    import numpy as np

    visible = np.asarray(values) == 1
    # cells beyond the raster boundary count as not visible
    padded = np.pad(visible, 1, mode="constant", constant_values=False)
    counts = np.zeros(visible.shape, dtype=np.uint8)
    for row_offset in range(3):
        for column_offset in range(3):
            counts += padded[
                row_offset : row_offset + visible.shape[0],
                column_offset : column_offset + visible.shape[1],
            ]
    return (counts >= 5).astype(np.uint8)


def majority_filter_raster(source: Path, destination: Path) -> dict[str, int | float]:
    """writes the 3x3 majority result while preserving raster alignment"""

    import numpy as np
    from osgeo import gdal

    gdal.UseExceptions()
    dataset = gdal.Open(str(source), gdal.GA_ReadOnly)
    if dataset is None:
        raise RuntimeError(f"could not open web mask: {source}")
    values = dataset.GetRasterBand(1).ReadAsArray()
    filtered = majority_filter_array(values)
    raw_visible = int(np.count_nonzero(values == 1))
    filtered_visible = int(np.count_nonzero(filtered == 1))
    changed = int(np.count_nonzero((values == 1) != (filtered == 1)))

    safe_unlink(destination)
    output = gdal.GetDriverByName("GTiff").Create(
        str(destination),
        dataset.RasterXSize,
        dataset.RasterYSize,
        1,
        gdal.GDT_Byte,
        options=("TILED=YES", "COMPRESS=DEFLATE"),
    )
    if output is None:
        raise RuntimeError(f"could not create majority raster: {destination}")
    output.SetGeoTransform(dataset.GetGeoTransform())
    output.SetProjection(dataset.GetProjection())
    band = output.GetRasterBand(1)
    band.SetNoDataValue(0)
    band.WriteArray(filtered)
    band.FlushCache()
    output.FlushCache()
    output = None
    dataset = None
    total_cells = int(values.size)
    return {
        "raw_visible_cells": raw_visible,
        "filtered_visible_cells": filtered_visible,
        "changed_cells": changed,
        "changed_percent": changed / total_cells * 100 if total_cells else 0.0,
    }


def polygonize_mask(
    mask: Path,
    output: Path,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    label: str,
) -> None:
    safe_unlink(output)
    run_command(
        [
            *runtime.tool("gdal_polygonize"),
            "-8",
            str(mask),
            "-f",
            "GPKG",
            str(output),
            "visible_parts",
            "visible",
        ],
        env,
        emitter,
        label,
    )


def union_sql(site: Site, radius_m: float, cell_size_m: float) -> str:
    if site.height_ft is None or site.height_m is None:
        raise RuntimeError(f"{site.name} has no camera height")
    return (
        "SELECT ST_Union(geom) AS geom, "
        f"{site.source_id} AS source_id, {sql_literal(site.viewshed_id)} AS viewshed_id, "
        f"{sql_literal(site.name)} AS site_name, {site.height_ft} AS height_ft, "
        f"{site.height_m} AS height_m, {radius_m} AS radius_m, "
        f"{cell_size_m} AS cell_size_m, 'GDALViewshedGenerate' AS method "
        "FROM visible_parts WHERE visible = 1"
    )


def dissolve_to_5070(
    source: Path,
    destination: Path,
    site: Site,
    radius_m: float,
    cell_size_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    label: str,
) -> None:
    safe_unlink(destination)
    run_command(
        [
            *runtime.tool("ogr2ogr"),
            "-f",
            "GPKG",
            str(destination),
            str(source),
            "-t_srs",
            CANONICAL_CRS,
            "-dialect",
            "SQLITE",
            "-sql",
            union_sql(site, radius_m, cell_size_m),
            "-nln",
            "camera_viewshed",
        ],
        env,
        emitter,
        label,
    )


def build_exact_polygon(
    site: Site,
    paths: dict[str, Path],
    radius_m: float,
    cell_size_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> None:
    build_mask(paths["raster"], paths["mask"], runtime, env, emitter, f"exact mask for {site.name}")
    polygonize_mask(paths["mask"], paths["raw"], runtime, env, emitter, f"exact polygonize for {site.name}")
    dissolve_to_5070(
        paths["raw"],
        paths["exact"],
        site,
        radius_m,
        cell_size_m,
        runtime,
        env,
        emitter,
        f"exact polygon dissolve for {site.name}",
    )


def build_web_polygon(
    site: Site,
    paths: dict[str, Path],
    args: argparse.Namespace,
    radius_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    clip_boundary: Path | None,
) -> dict[str, int | float | bool]:
    safe_unlink(paths["web_raster"])
    run_command(
        [
            *runtime.tool("gdalwarp"),
            "-overwrite",
            "-tr",
            str(args.web_resolution),
            str(args.web_resolution),
            "-tap",
            "-r",
            "near",
            "-ot",
            "Byte",
            "-srcnodata",
            "255",
            "-dstnodata",
            "255",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            str(paths["raster"]),
            str(paths["web_raster"]),
        ],
        env,
        emitter,
        f"{args.web_resolution:g} m web raster for {site.name}",
    )
    build_mask(
        paths["web_raster"], paths["web_mask"], runtime, env, emitter, f"web mask for {site.name}"
    )
    polygon_mask = paths["web_mask"]
    if args.web_majority_filter:
        filter_summary = majority_filter_raster(paths["web_mask"], paths["web_filtered"])
        polygon_mask = paths["web_filtered"]
        emitter.log(
            f"3x3 majority filter changed {filter_summary['changed_percent']:.2f}% "
            f"of web cells for {site.name}"
        )
    else:
        from osgeo import gdal

        gdal.UseExceptions()
        dataset = gdal.Open(str(paths["web_mask"]), gdal.GA_ReadOnly)
        values = dataset.GetRasterBand(1).ReadAsArray()
        visible_cells = int((values == 1).sum())
        filter_summary = {
            "raw_visible_cells": visible_cells,
            "filtered_visible_cells": visible_cells,
            "changed_cells": 0,
            "changed_percent": 0.0,
        }
        dataset = None
    if args.min_web_patch_cells:
        safe_unlink(paths["web_sieved"])
        run_command(
            [
                *runtime.tool("gdal_sieve"),
                "-st",
                str(args.min_web_patch_cells),
                "-8",
                "-nomask",
                str(polygon_mask),
                str(paths["web_sieved"]),
            ],
            env,
            emitter,
            f"small web patch cleanup for {site.name}",
        )
        polygon_mask = paths["web_sieved"]
    polygonize_mask(
        polygon_mask, paths["web_raw"], runtime, env, emitter, f"web polygonize for {site.name}"
    )
    dissolve_to_5070(
        paths["web_raw"],
        paths["web_projected"],
        site,
        radius_m,
        args.cell_size,
        runtime,
        env,
        emitter,
        f"web polygon dissolve for {site.name}",
    )
    polygon_source = paths["web_projected"]
    polygon_layer = "camera_viewshed"
    if args.simplify_tolerance:
        safe_unlink(paths["web_simplified"])
        run_command(
            [
                *runtime.tool("ogr2ogr"),
                "-f",
                "GPKG",
                str(paths["web_simplified"]),
                str(polygon_source),
                "camera_viewshed",
                "-simplify",
                str(args.simplify_tolerance),
                "-makevalid",
                "-nln",
                "camera_viewshed",
            ],
            env,
            emitter,
            f"web polygon simplification for {site.name}",
        )
        polygon_source = paths["web_simplified"]

    if args.smooth_iterations:
        safe_unlink(paths["web_smoothed"])
        run_command(
            [
                *runtime.tool("qgis_process"),
                "run",
                "native:smoothgeometry",
                "--",
                f"INPUT={polygon_source}|layername={polygon_layer}",
                f"ITERATIONS={args.smooth_iterations}",
                "OFFSET=0.25",
                "MAX_ANGLE=180",
                f"OUTPUT={paths['web_smoothed']}",
            ],
            env,
            emitter,
            f"web polygon smoothing for {site.name}",
        )
        polygon_source = paths["web_smoothed"]
        polygon_layer = paths["web_smoothed"].stem

    if clip_boundary:
        safe_unlink(paths["web_clipped"])
        run_command(
            [
                *runtime.tool("ogr2ogr"),
                "-f",
                "GPKG",
                str(paths["web_clipped"]),
                str(polygon_source),
                polygon_layer,
                "-clipsrc",
                str(clip_boundary),
                "-clipsrclayer",
                "web_clip_boundary",
                "-makevalid",
                "-nln",
                "camera_viewshed",
            ],
            env,
            emitter,
            f"Oregon and Washington clip for {site.name}",
        )
        polygon_source = paths["web_clipped"]
        polygon_layer = "camera_viewshed"

    safe_unlink(paths["web"])
    run_command(
        [
            *runtime.tool("ogr2ogr"),
            "-f",
            "GeoJSON",
            str(paths["web"]),
            str(polygon_source),
            polygon_layer,
            "-makevalid",
            "-t_srs",
            WEB_CRS,
            "-lco",
            "RFC7946=YES",
            "-nln",
            "camera_viewshed",
        ],
        env,
        emitter,
        f"smoothed web GeoJSON for {site.name}",
    )
    return {
        **filter_summary,
        "majority_enabled": args.web_majority_filter,
        "sieve_threshold_cells": args.min_web_patch_cells,
        "clip_enabled": clip_boundary is not None,
    }


def validate_vector(
    path: Path,
    layer: str | None,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> None:
    describe_command = [*runtime.tool("ogrinfo"), "-so", "-al", str(path)]
    if layer:
        describe_command.append(layer)
    description = run_command(
        describe_command,
        env,
        emitter,
        f"geometry metadata for {path.name}",
    )
    geometry_column = "geometry"
    detected_layer = layer
    for line in description.splitlines():
        if line.startswith("Layer name:") and not detected_layer:
            detected_layer = line.split(":", 1)[1].strip()
        if line.startswith("Geometry Column ="):
            geometry_column = line.split("=", 1)[1].strip()
    if not detected_layer:
        raise RuntimeError(f"could not determine output layer: {path}")
    output = run_command(
        [
            *runtime.tool("ogrinfo"),
            "-dialect",
            "SQLITE",
            "-sql",
            f'SELECT MIN(ST_IsValid("{geometry_column}")) AS is_valid FROM "{detected_layer}"',
            str(path),
        ],
        env,
        emitter,
        f"geometry validation for {path.name}",
    )
    if "is_valid (Integer) = 1" not in output:
        raise RuntimeError(f"invalid output geometry: {path}")


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def reusable_stages(
    state_path: Path,
    analysis_hash: str,
    web_hash: str,
    exact_required: bool,
    legacy_config_hashes: set[str],
    legacy_analysis_matches: bool,
) -> tuple[dict[str, Any] | None, bool, bool, bool]:
    state = load_state(state_path)
    if not state or state.get("status") != "complete":
        return state, False, False, False
    outputs = state.get("outputs", {})
    current_analysis = state.get("analysis_hash") == analysis_hash
    # version 1 states only carry the prior full config hash
    migrated_analysis = (
        legacy_analysis_matches
        and state.get("config_hash") in legacy_config_hashes
    )
    analysis_reusable = (current_analysis or migrated_analysis) and bool(
        outputs.get("raster") and Path(outputs["raster"]).is_file()
    )
    exact_reusable = not exact_required or (
        analysis_reusable
        and bool(outputs.get("exact") and Path(outputs["exact"]).is_file())
    )
    web_reusable = (
        analysis_reusable
        and state.get("web_hash") == web_hash
        and bool(outputs.get("web") and Path(outputs["web"]).is_file())
    )
    return state, analysis_reusable, exact_reusable, web_reusable


def write_state(path: Path, document: dict[str, Any]) -> None:
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def process_site(
    site: Site,
    site_index: int,
    args: argparse.Namespace,
    source_vrt: Path,
    config_hash: str,
    analysis_hash: str,
    web_hash: str,
    legacy_config_hashes: set[str],
    legacy_analysis_matches: bool,
    radius_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
    clip_boundary: Path | None,
) -> dict[str, Any]:
    paths = output_paths(args.output_dir, site)
    if site.height_m is None:
        document = {
            "schema_version": 2,
            "status": "skipped_missing_height",
            "config_hash": config_hash,
            "analysis_hash": analysis_hash,
            "web_hash": web_hash,
            "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "site": asdict(site),
            "outputs": {"raster": None, "exact": None, "web": None},
            "elapsed_seconds": 0.0,
        }
        write_state(paths["state"], document)
        emitter.progress(
            site_index,
            site,
            "complete",
            f"[{site_index}/{emitter.total_sites}] skipped {site.name}: missing camera height",
        )
        return document
    previous_state, analysis_reusable, exact_reusable, web_reusable = reusable_stages(
        paths["state"],
        analysis_hash,
        web_hash,
        not args.skip_exact_polygons,
        legacy_config_hashes,
        legacy_analysis_matches,
    )
    if args.overwrite:
        analysis_reusable = exact_reusable = web_reusable = False
    if analysis_reusable and exact_reusable and web_reusable:
        emitter.progress(
            site_index,
            site,
            "complete",
            f"[{site_index}/{emitter.total_sites}] reused {site.name}",
        )
        return previous_state or {}

    if paths["work"].exists():
        shutil.rmtree(paths["work"])
    paths["work"].mkdir(parents=True)
    if args.overwrite:
        for key in ("raster", "exact", "web", "state"):
            safe_unlink(paths[key])

    started = time.monotonic()
    emitter.progress(site_index, site, "preparing", f"[{site_index}/{emitter.total_sites}] preparing {site.name}")
    if analysis_reusable:
        summary = (previous_state or {}).get("raster")
        if not summary:
            summary = raster_summary(paths["raster"], args.cell_size, runtime, env, emitter)
        emitter.progress(
            site_index,
            site,
            "viewshed",
            f"[{site_index}/{emitter.total_sites}] reused 10 m viewshed",
        )
    else:
        observer = transform_observer(site, runtime, env, emitter)
        build_dem(site, observer, source_vrt, paths, radius_m, args.cell_size, runtime, env, emitter)
        emitter.progress(site_index, site, "dem", f"[{site_index}/{emitter.total_sites}] projected DEM ready")
        build_viewshed(site, observer, paths, radius_m, runtime, env, emitter)
        summary = raster_summary(paths["raster"], args.cell_size, runtime, env, emitter)
        emitter.progress(site_index, site, "viewshed", f"[{site_index}/{emitter.total_sites}] viewshed validated")

    if not args.skip_exact_polygons and not exact_reusable:
        build_exact_polygon(site, paths, radius_m, args.cell_size, runtime, env, emitter)
        validate_vector(paths["exact"], "camera_viewshed", runtime, env, emitter)
    if args.skip_exact_polygons:
        exact_detail = "exact polygon skipped"
    else:
        exact_detail = "reused exact polygon" if exact_reusable else "exact polygon ready"
    emitter.progress(site_index, site, "exact_polygon", f"[{site_index}/{emitter.total_sites}] {exact_detail}")

    if web_reusable:
        web_filter = (previous_state or {}).get("web_filter", {})
        web_detail = "reused web polygon"
    else:
        web_filter = build_web_polygon(
            site,
            paths,
            args,
            radius_m,
            runtime,
            env,
            emitter,
            clip_boundary,
        )
        validate_vector(paths["web"], "camera_viewshed", runtime, env, emitter)
        web_detail = "web polygon ready"
    emitter.progress(
        site_index,
        site,
        "web_polygon",
        f"[{site_index}/{emitter.total_sites}] {web_detail}",
    )

    document = {
        "schema_version": 2,
        "status": "complete",
        "config_hash": config_hash,
        "analysis_hash": analysis_hash,
        "web_hash": web_hash,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "site": asdict(site),
        "analysis_crs": f"EPSG:{site.utm_epsg}",
        "observer_height_m_agl": site.height_m,
        "raster": summary,
        "web_filter": web_filter,
        "outputs": {
            "raster": str(paths["raster"]),
            "exact": str(paths["exact"]) if not args.skip_exact_polygons else None,
            "web": str(paths["web"]),
        },
        "elapsed_seconds": time.monotonic() - started,
    }
    write_state(paths["state"], document)
    if not args.keep_working_dems:
        shutil.rmtree(paths["work"])
    emitter.progress(site_index, site, "complete", f"[{site_index}/{emitter.total_sites}] completed {site.name}")
    return document


def rebuild_combined_exact(
    states: list[dict[str, Any]],
    output_dir: Path,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> Path | None:
    inputs = [Path(state["outputs"]["exact"]) for state in states if state["outputs"].get("exact")]
    if not inputs:
        return None
    combined = output_dir / "camera_viewsheds_exact_epsg5070.gpkg"
    safe_unlink(combined)
    for index, source in enumerate(inputs):
        command = runtime.tool("ogr2ogr")
        if index == 0:
            command.extend(("-f", "GPKG", str(combined), str(source), "camera_viewshed"))
        else:
            command.extend(("-update", "-append", str(combined), str(source), "camera_viewshed"))
        command.extend(("-nln", "camera_viewsheds"))
        run_command(command, env, emitter, f"combined exact polygon {index + 1}/{len(inputs)}")
    return combined


def geopackage_feature_count(path: Path, layer: str) -> int | None:
    if not path.is_file() or not layer.replace("_", "").isalnum():
        return None
    try:
        with sqlite3.connect(path) as connection:
            row = connection.execute(f'SELECT COUNT(*) FROM "{layer}"').fetchone()
        return int(row[0]) if row else None
    except sqlite3.Error:
        return None


def find_tippecanoe(env: dict[str, str]) -> Path | None:
    discovered = shutil.which("tippecanoe", path=env.get("PATH"))
    candidates = [
        Path(discovered) if discovered else None,
        Path("/opt/homebrew/bin/tippecanoe"),
        Path("/usr/local/bin/tippecanoe"),
    ]
    return next((path for path in candidates if path and path.is_file()), None)


def validate_mbtiles(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT value FROM metadata WHERE name = 'json'"
        ).fetchone()
        zooms = dict(
            connection.execute(
                "SELECT name, value FROM metadata WHERE name IN ('minzoom', 'maxzoom')"
            )
        )
    if not row:
        raise RuntimeError(f"MBTiles layer metadata missing: {path}")
    metadata = json.loads(row[0])
    layer_ids = {layer.get("id") for layer in metadata.get("vector_layers", [])}
    expected = {INDIVIDUAL_LAYER, COVERAGE_LAYER}
    if not expected.issubset(layer_ids):
        raise RuntimeError(f"MBTiles layers missing: {', '.join(sorted(expected - layer_ids))}")
    if zooms != {"minzoom": str(MAPBOX_MIN_ZOOM), "maxzoom": str(MAPBOX_MAX_ZOOM)}:
        raise RuntimeError(f"unexpected MBTiles zoom metadata: {zooms}")


def rebuild_web_products(
    states: list[dict[str, Any]],
    output_dir: Path,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> dict[str, Any] | None:
    inputs = [Path(state["outputs"]["web"]) for state in states if state["outputs"].get("web")]
    if not inputs:
        return None

    mapbox_dir = output_dir / "mapbox"
    mapbox_dir.mkdir(parents=True, exist_ok=True)
    staging = mapbox_dir / "camera_viewsheds_web_epsg5070.gpkg"
    coverage_staging = mapbox_dir / "coverage_staging.gpkg"
    individual_geojson = mapbox_dir / "camera-viewsheds.geojson"
    coverage_geojson = mapbox_dir / "camera-viewshed-coverage.geojson"
    mbtiles = mapbox_dir / "camera-viewsheds-z5.mbtiles"
    for path in (staging, coverage_staging, individual_geojson, coverage_geojson, mbtiles):
        safe_unlink(path)

    # projected staging keeps the full union away from degree-based geometry math
    for index, source in enumerate(inputs):
        command = runtime.tool("ogr2ogr")
        if index == 0:
            command.extend(("-f", "GPKG", str(staging), str(source), "camera_viewshed"))
        else:
            command.extend(("-update", "-append", str(staging), str(source), "camera_viewshed"))
        command.extend(("-t_srs", CANONICAL_CRS, "-makevalid", "-nln", INDIVIDUAL_LAYER))
        run_command(command, env, emitter, f"combined web polygon {index + 1}/{len(inputs)}")
    validate_vector(staging, INDIVIDUAL_LAYER, runtime, env, emitter)
    individual_count = geopackage_feature_count(staging, INDIVIDUAL_LAYER)
    if individual_count != len(inputs):
        raise RuntimeError(
            f"combined web feature count is {individual_count}; expected {len(inputs)}"
        )

    run_command(
        [
            *runtime.tool("ogr2ogr"),
            "-f",
            "GPKG",
            str(coverage_staging),
            str(staging),
            "-dialect",
            "SQLITE",
            "-sql",
            (
                "SELECT ST_Union(geom) AS geom, 'all' AS coverage_id "
                f'FROM "{INDIVIDUAL_LAYER}"'
            ),
            "-nln",
            COVERAGE_LAYER,
        ],
        env,
        emitter,
        "dissolved web coverage",
    )
    validate_vector(coverage_staging, COVERAGE_LAYER, runtime, env, emitter)
    if geopackage_feature_count(coverage_staging, COVERAGE_LAYER) != 1:
        raise RuntimeError("dissolved web coverage must contain exactly one feature")

    # second layer makes the local review package match the hosted tileset
    run_command(
        [
            *runtime.tool("ogr2ogr"),
            "-update",
            str(staging),
            str(coverage_staging),
            COVERAGE_LAYER,
            "-nln",
            COVERAGE_LAYER,
        ],
        env,
        emitter,
        "add dissolved coverage to review package",
    )
    safe_unlink(coverage_staging)

    for source_layer, destination in (
        (INDIVIDUAL_LAYER, individual_geojson),
        (COVERAGE_LAYER, coverage_geojson),
    ):
        run_command(
            [
                *runtime.tool("ogr2ogr"),
                "-f",
                "GeoJSON",
                str(destination),
                str(staging),
                source_layer,
                "-t_srs",
                WEB_CRS,
                "-makevalid",
                "-lco",
                "RFC7946=YES",
            ],
            env,
            emitter,
            f"Mapbox source {source_layer}",
        )
        validate_vector(destination, None, runtime, env, emitter)

    tippecanoe = find_tippecanoe(env)
    packaging: dict[str, Any] = {
        "status": "skipped_tippecanoe_missing",
        "mbtiles": None,
        "error": None,
    }
    if tippecanoe:
        try:
            run_command(
                [
                    str(tippecanoe),
                    "--force",
                    f"--minimum-zoom={MAPBOX_MIN_ZOOM}",
                    f"--maximum-zoom={MAPBOX_MAX_ZOOM}",
                    "--drop-densest-as-needed",
                    f"--output={mbtiles}",
                    "-L",
                    f"{INDIVIDUAL_LAYER}:{individual_geojson}",
                    "-L",
                    f"{COVERAGE_LAYER}:{coverage_geojson}",
                ],
                env,
                emitter,
                "multilayer Mapbox MBTiles",
            )
            validate_mbtiles(mbtiles)
            packaging.update(status="complete", mbtiles=str(mbtiles))
        except CancelledError:
            safe_unlink(mbtiles)
            raise
        except Exception as error:
            safe_unlink(mbtiles)
            packaging.update(status="failed", error=str(error))
            emitter.log(f"Mapbox packaging failed: {error}")
    else:
        emitter.log("Tippecanoe not found; GeoJSON sources are ready but MBTiles was not built")

    return {
        "individual_geojson": str(individual_geojson),
        "coverage_geojson": str(coverage_geojson),
        "review_geopackage": str(staging),
        "individual_layer": INDIVIDUAL_LAYER,
        "coverage_layer": COVERAGE_LAYER,
        "minzoom": MAPBOX_MIN_ZOOM,
        "maxzoom": MAPBOX_MAX_ZOOM,
        **packaging,
    }


def write_manifest(
    states: list[dict[str, Any]],
    output_dir: Path,
    config: dict[str, Any],
    combined_exact: Path | None,
    web_products: dict[str, Any] | None,
) -> Path:
    entries = []
    for state in states:
        site = state["site"]
        web_output = state["outputs"].get("web")
        exact_output = state["outputs"].get("exact")
        entries.append(
            {
                "source_id": site["source_id"],
                "viewshed_id": site["viewshed_id"],
                "site_name": site["name"],
                "aliases": site.get("aliases", []),
                "longitude": site["longitude"],
                "latitude": site["latitude"],
                "height_ft": site["height_ft"],
                "status": state["status"],
                "web_geojson": (
                    str(Path(web_output).relative_to(output_dir)) if web_output else None
                ),
                "exact_polygon": (
                    str(Path(exact_output).relative_to(output_dir))
                    if exact_output
                    else None
                ),
            }
        )
    manifest = output_dir / "viewshed-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "config_hash": config["config_hash"],
                "web_processing": {
                    "resolution_m": config["web_resolution_m"],
                    "simplify_tolerance_m": config["simplify_tolerance_m"],
                    "smooth_iterations": config["smooth_iterations"],
                    "majority_filter": config["web_majority_filter"],
                    "minimum_patch_cells": config["min_web_patch_cells"],
                    "clip": {
                        "enabled": config["web_clip"],
                        "boundary_sha256": config["web_clip_boundary_sha256"],
                    },
                },
                "combined_exact_polygon": (
                    str(combined_exact.relative_to(output_dir))
                    if combined_exact
                    else None
                ),
                "web_products": (
                    {
                        key: (
                            str(Path(value).relative_to(output_dir))
                            if key in {
                                "individual_geojson",
                                "coverage_geojson",
                                "review_geopackage",
                                "mbtiles",
                            }
                            and value
                            else value
                        )
                        for key, value in web_products.items()
                    }
                    if web_products
                    else None
                ),
                "viewsheds": entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    args = parse_args()
    args.output_dir = args.output_dir.resolve()
    args.web_clip_boundary = args.web_clip_boundary.resolve()
    if args.web_clip and not args.web_clip_boundary.is_file():
        raise FileNotFoundError(f"web clip boundary not found: {args.web_clip_boundary}")
    env, runtime = qgis_environment(args.qgis_app)
    sites = load_sites(args.sites)
    selected = select_sites(sites, args)
    emitter = ProgressEmitter(args.json_progress, len(selected))
    dem_files = sorted(args.dem_dir.glob("*.tif"))
    if not dem_files:
        raise RuntimeError(f"no GeoTIFF DEMs found in {args.dem_dir}")
    prepare_output(args.output_dir)
    previous_config = read_existing_config(args.output_dir)
    config = config_document(args, dem_files, args.sites)
    legacy_analysis_matches = analysis_configs_match(previous_config, config)
    # keeps untouched v1 states reusable after pilot or interrupted runs
    legacy_config_hashes = set(
        (previous_config or {}).get("compatible_legacy_config_hashes", [])
    )
    if legacy_analysis_matches and previous_config and previous_config.get("config_hash"):
        legacy_config_hashes.add(previous_config["config_hash"])
    config["compatible_legacy_config_hashes"] = sorted(legacy_config_hashes)
    previous_analysis_hash = (
        previous_config.get("analysis_hash")
        if previous_config
        else None
    )
    if previous_analysis_hash is None and legacy_analysis_matches:
        previous_analysis_hash = config["analysis_hash"]
    emitter.progress(0, None, "preparing", f"loaded {len(selected)} cameras and {len(dem_files)} DEMs")
    source_vrt = build_vrt(
        args.output_dir,
        dem_files,
        runtime,
        env,
        emitter,
        args.overwrite or previous_analysis_hash != config["analysis_hash"],
    )
    clip_boundary = (
        prepare_web_clip_boundary(
            args.web_clip_boundary,
            args.output_dir,
            runtime,
            env,
            emitter,
        )
        if args.web_clip
        else None
    )
    radius_m = args.radius_miles * 1609.344

    completed: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for site_index, site in enumerate(selected, start=1):
        try:
            completed.append(
                process_site(
                    site,
                    site_index,
                    args,
                    source_vrt,
                    config["config_hash"],
                    config["analysis_hash"],
                    config["web_hash"],
                    legacy_config_hashes,
                    legacy_analysis_matches,
                    radius_m,
                    runtime,
                    env,
                    emitter,
                    clip_boundary,
                )
            )
        except CancelledError:
            emitter.log("cancelled by user")
            return 130
        except Exception as error:
            failures.append({"site_name": site.name, "error": str(error)})
            emitter.log(f"FAILED {site.name}: {error}")
            if args.fail_fast:
                break

    if not failures:
        write_config(args.output_dir, config)

    combined = None
    if completed and not args.skip_exact_polygons:
        expected_exact_count = sum(bool(state["outputs"].get("exact")) for state in completed)
        existing_combined = args.output_dir / "camera_viewsheds_exact_epsg5070.gpkg"
        reuse_combined = (
            not args.overwrite
            and previous_analysis_hash == config["analysis_hash"]
            and geopackage_feature_count(existing_combined, INDIVIDUAL_LAYER)
            == expected_exact_count
        )
        if reuse_combined:
            combined = existing_combined
            emitter.log(f"reusing combined exact polygon: {combined}")
        else:
            combined = rebuild_combined_exact(completed, args.output_dir, runtime, env, emitter)
    web_products = rebuild_web_products(completed, args.output_dir, runtime, env, emitter)
    manifest = write_manifest(
        completed,
        args.output_dir,
        config,
        combined,
        web_products,
    )
    (args.output_dir / "failures.json").write_text(
        json.dumps(failures, indent=2) + "\n", encoding="utf-8"
    )
    emitter.progress(len(selected), None, "complete", f"manifest ready: {manifest}")
    complete_count = sum(item.get("status") == "complete" for item in completed)
    skipped_count = sum(item.get("status", "").startswith("skipped") for item in completed)
    emitter.log(
        f"completed {complete_count}/{len(selected)} cameras; "
        f"skipped: {skipped_count}; failures: {len(failures)}"
    )
    packaging_failed = bool(web_products and web_products.get("status") == "failed")
    return 1 if failures or packaging_failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CancelledError:
        raise SystemExit(130)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1) from error
