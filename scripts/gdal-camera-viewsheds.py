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

PILOT_NAMES = ("Portland Tower",)
VALIDATION_NAMES = ("Portland Tower", "Quail Prairie Mtn", "Beaty's Butte")
CANONICAL_CRS = "EPSG:5070"
WEB_CRS = "EPSG:4326"
REFRACTION_COEFFICIENT = 0.13
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
    if args.simplify_tolerance < 0 or args.min_web_patch_cells < 0:
        parser.error("simplification and patch thresholds cannot be negative")
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
    return runtime.environment(), runtime


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
        "web_sieved": work / "web_sieved.tif",
        "web_raw": work / "web_raw.gpkg",
        "web_projected": work / "web_epsg5070.gpkg",
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


def config_payload(
    args: argparse.Namespace,
    dem_files: list[Path],
    sites_path: Path,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "sites_sha256": hashlib.sha256(sites_path.read_bytes()).hexdigest(),
        "dem_inventory": [
            {"name": path.name, "size": path.stat().st_size, "mtime_ns": path.stat().st_mtime_ns}
            for path in dem_files
        ],
        "radius_m": args.radius_miles * 1609.344,
        "cell_size_m": args.cell_size,
        "web_resolution_m": args.web_resolution,
        "simplify_tolerance_m": args.simplify_tolerance,
        "min_web_patch_cells": args.min_web_patch_cells,
        "refraction_coefficient": REFRACTION_COEFFICIENT,
        "exact_polygons": not args.skip_exact_polygons,
    }


def write_config(output_dir: Path, payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    config_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    document = {**payload, "config_hash": config_hash}
    (output_dir / "analysis_config.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )
    return config_hash


def existing_config_hash(output_dir: Path) -> str | None:
    path = output_dir / "analysis_config.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("config_hash")
    except (OSError, json.JSONDecodeError):
        return None


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
) -> None:
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
    if args.min_web_patch_cells:
        safe_unlink(paths["web_sieved"])
        run_command(
            [
                *runtime.tool("gdal_sieve"),
                "-st",
                str(args.min_web_patch_cells),
                "-8",
                str(paths["web_mask"]),
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
    safe_unlink(paths["web"])
    command = [
        *runtime.tool("ogr2ogr"),
        "-f",
        "GeoJSON",
        str(paths["web"]),
        str(paths["web_projected"]),
        "camera_viewshed",
        "-makevalid",
    ]
    if args.simplify_tolerance:
        # runs in EPSG:5070 metres before the WGS84 reprojection
        command.extend(("-simplify", str(args.simplify_tolerance)))
    command.extend(("-t_srs", WEB_CRS, "-lco", "RFC7946=YES"))
    run_command(command, env, emitter, f"smoothed web GeoJSON for {site.name}")


def validate_vector(
    path: Path,
    layer: str,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> None:
    description = run_command(
        [*runtime.tool("ogrinfo"), "-so", "-al", str(path), layer],
        env,
        emitter,
        f"geometry metadata for {path.name}",
    )
    geometry_column = "geometry"
    for line in description.splitlines():
        if line.startswith("Geometry Column ="):
            geometry_column = line.split("=", 1)[1].strip()
            break
    output = run_command(
        [
            *runtime.tool("ogrinfo"),
            "-dialect",
            "SQLITE",
            "-sql",
            f'SELECT ST_IsValid("{geometry_column}") AS is_valid FROM "{layer}"',
            str(path),
        ],
        env,
        emitter,
        f"geometry validation for {path.name}",
    )
    if "is_valid (Integer) = 1" not in output:
        raise RuntimeError(f"invalid output geometry: {path}")


def state_is_reusable(
    state_path: Path,
    config_hash: str,
    exact_required: bool,
) -> bool:
    if not state_path.exists():
        return False
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if state.get("status") != "complete" or state.get("config_hash") != config_hash:
        return False
    outputs = state.get("outputs", {})
    required = [outputs.get("raster"), outputs.get("web")]
    if exact_required:
        required.append(outputs.get("exact"))
    return all(value and Path(value).is_file() for value in required)


def write_state(path: Path, document: dict[str, Any]) -> None:
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def process_site(
    site: Site,
    site_index: int,
    args: argparse.Namespace,
    source_vrt: Path,
    config_hash: str,
    radius_m: float,
    runtime: QgisRuntime,
    env: dict[str, str],
    emitter: ProgressEmitter,
) -> dict[str, Any]:
    paths = output_paths(args.output_dir, site)
    if site.height_m is None:
        document = {
            "schema_version": 1,
            "status": "skipped_missing_height",
            "config_hash": config_hash,
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
    if not args.overwrite and state_is_reusable(
        paths["state"], config_hash, not args.skip_exact_polygons
    ):
        emitter.progress(site_index, site, "complete", f"[{site_index}/{emitter.total_sites}] reused {site.name}")
        return json.loads(paths["state"].read_text(encoding="utf-8"))

    if paths["work"].exists():
        shutil.rmtree(paths["work"])
    paths["work"].mkdir(parents=True)
    if args.overwrite:
        for key in ("raster", "exact", "web", "state"):
            safe_unlink(paths[key])

    started = time.monotonic()
    emitter.progress(site_index, site, "preparing", f"[{site_index}/{emitter.total_sites}] preparing {site.name}")
    observer = transform_observer(site, runtime, env, emitter)
    build_dem(site, observer, source_vrt, paths, radius_m, args.cell_size, runtime, env, emitter)
    emitter.progress(site_index, site, "dem", f"[{site_index}/{emitter.total_sites}] projected DEM ready")
    build_viewshed(site, observer, paths, radius_m, runtime, env, emitter)
    summary = raster_summary(paths["raster"], args.cell_size, runtime, env, emitter)
    emitter.progress(site_index, site, "viewshed", f"[{site_index}/{emitter.total_sites}] viewshed validated")

    if not args.skip_exact_polygons:
        build_exact_polygon(site, paths, radius_m, args.cell_size, runtime, env, emitter)
        validate_vector(paths["exact"], "camera_viewshed", runtime, env, emitter)
    emitter.progress(site_index, site, "exact_polygon", f"[{site_index}/{emitter.total_sites}] exact polygon ready")

    build_web_polygon(site, paths, args, radius_m, runtime, env, emitter)
    validate_vector(paths["web"], "camera_viewshed", runtime, env, emitter)
    emitter.progress(site_index, site, "web_polygon", f"[{site_index}/{emitter.total_sites}] web polygon ready")

    document = {
        "schema_version": 1,
        "status": "complete",
        "config_hash": config_hash,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "site": asdict(site),
        "analysis_crs": f"EPSG:{site.utm_epsg}",
        "observer_height_m_agl": site.height_m,
        "raster": summary,
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


def write_manifest(
    states: list[dict[str, Any]],
    output_dir: Path,
    config_hash: str,
    combined_exact: Path | None,
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
                "schema_version": 1,
                "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "config_hash": config_hash,
                "combined_exact_polygon": (
                    str(combined_exact.relative_to(output_dir))
                    if combined_exact
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
    env, runtime = qgis_environment(args.qgis_app)
    sites = load_sites(args.sites)
    selected = select_sites(sites, args)
    emitter = ProgressEmitter(args.json_progress, len(selected))
    dem_files = sorted(args.dem_dir.glob("*.tif"))
    if not dem_files:
        raise RuntimeError(f"no GeoTIFF DEMs found in {args.dem_dir}")
    prepare_output(args.output_dir)
    config = config_payload(args, dem_files, args.sites)
    previous_hash = existing_config_hash(args.output_dir)
    config_hash = write_config(args.output_dir, config)
    emitter.progress(0, None, "preparing", f"loaded {len(selected)} cameras and {len(dem_files)} DEMs")
    source_vrt = build_vrt(
        args.output_dir,
        dem_files,
        runtime,
        env,
        emitter,
        args.overwrite or previous_hash != config_hash,
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
                    config_hash,
                    radius_m,
                    runtime,
                    env,
                    emitter,
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

    combined = None
    if completed and not args.skip_exact_polygons:
        combined = rebuild_combined_exact(completed, args.output_dir, runtime, env, emitter)
    manifest = write_manifest(completed, args.output_dir, config_hash, combined)
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
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CancelledError:
        raise SystemExit(130)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1) from error
