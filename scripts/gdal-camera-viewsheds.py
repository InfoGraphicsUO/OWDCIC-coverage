#!/usr/bin/env python3
"""builds resumable projected camera viewsheds with QGIS-bundled GDAL

Runs under the QGIS Python so GDAL, OGR, NumPy, and QgsGeometry are used
in-process; the only external tool is the optional tippecanoe packager.
"""

from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import queue as queue_module
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Iterable

try:
    import numpy as np
    from osgeo import gdal, ogr, osr
except ImportError:  # unit tests may import this module outside the QGIS Python
    np = gdal = ogr = osr = None
else:
    gdal.UseExceptions()
    ogr.UseExceptions()
    osr.UseExceptions()

from qgis_runtime import default_qgis_root, qgis_runtime

# paths to default files and directories
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QGIS_ROOT = default_qgis_root()
DEFAULT_SITES = PROJECT_ROOT / "data/sites.geojson"
DEFAULT_DEMS = PROJECT_ROOT / "data/dems"
DEFAULT_OUTPUT = PROJECT_ROOT / "outputs/gdal_viewsheds"
DEFAULT_CLIP_BOUNDARY = PROJECT_ROOT / "data/or-wa-boundary.geojson"
DEFAULT_JOBS = max(1, min(4, (os.cpu_count() or 2) // 2))

PILOT_NAMES = ("Portland Tower",)  # 'pilot' mode processes only one site
VALIDATION_NAMES = ("Portland Tower", "Quail Prairie Mtn", "Beaty's Butte")
# coordinate reference system for viewsheds & web polygons
CANONICAL_CRS = "EPSG:5070"
WEB_CRS = "EPSG:4326"

REFRACTION_COEFFICIENT = 0.13  # refraction coefficient; accounts for earth curvature
NODATA_VALUE = 255  # viewshed raster cells outside the analysis radius
INDIVIDUAL_LAYER = "camera_viewsheds"  # name of individual viewshed layer in QGIS
COVERAGE_LAYER = "camera_viewshed_coverage"  # name of full coverage layer in QGIS
SITE_LAYER = "camera_viewshed"  # layer name inside per-camera outputs
MAPBOX_MIN_ZOOM = 5
MAPBOX_MAX_ZOOM = 12
SCHEMA_VERSION = 3

# share of one camera's work covered by each stage, for GUI progress
STAGE_SPANS = {
    "preparing": (0.00, 0.00),
    "dem": (0.00, 0.20),
    "viewshed": (0.20, 0.40),
    "exact_polygon": (0.40, 0.80),
    "web_polygon": (0.80, 1.00),
    "complete": (1.00, 1.00),
}

SITE_FIELDS = {
    "source_id": "integer",
    "viewshed_id": "string",
    "site_name": "string",
    "height_ft": "real",
    "height_m": "real",
    "radius_m": "real",
    "cell_size_m": "real",
    "method": "string",
}
COVERAGE_FIELDS = {"coverage_id": "string"}


@dataclass(frozen=True)
class Site:
    """one camera site"""

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
        """NAD83 UTM zone code chosen from the longitude"""
        zone = int((self.longitude + 180.0) // 6.0) + 1
        if zone not in (10, 11):
            raise ValueError(f"{self.name} falls in UTM zone {zone}; expected 10 or 11")
        return 26900 + zone

    @property
    def stem(self) -> str:
        return self.viewshed_id.replace("-", "_")


@dataclass(frozen=True)
class RunConfig:
    """everything a worker needs to process one camera; must stay picklable"""

    output_dir: Path
    source_vrt: Path
    radius_m: float
    cell_size_m: float
    web_resolution_m: float
    simplify_tolerance_m: float
    smooth_iterations: int
    web_majority_filter: bool
    min_web_patch_cells: int
    exact_polygons: bool
    keep_working_dems: bool
    overwrite: bool
    warp_threads: int
    clip_boundary_wkb: bytes | None  # EPSG:5070
    analysis_hash: str
    web_hash: str
    config_hash: str


class CancelledError(RuntimeError):
    """raised after the user cancels the run"""


# ---------------------------------------------------------------------------
# arguments, sites, and small helpers


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
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
    parser.add_argument(
        "--jobs",
        type=int,
        default=DEFAULT_JOBS,
        help=f"cameras processed in parallel (default: {DEFAULT_JOBS})",
    )
    parser.add_argument("--skip-exact-polygons", action="store_true")
    parser.add_argument("--keep-working-dems", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--json-progress", action="store_true")
    args = parser.parse_args(argv)
    for name in ("radius_miles", "cell_size", "web_resolution", "jobs"):
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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_unlink(path: Path) -> None:
    if path.is_file():
        path.unlink()


def write_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return document if isinstance(document, dict) else None


def load_sites(path: Path) -> list[Site]:
    """loads camera sites from a GeoJSON FeatureCollection of points"""
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
        site = Site(
            source_id=source_id,
            viewshed_id=slugify(name),
            name=name,
            longitude=longitude,
            latitude=latitude,
            height_ft=None if raw_height in (None, "") else float(raw_height),
            aliases=tuple(map(str, properties.get("aliases", []))),
        )
        _ = site.utm_epsg  # fail early on cameras outside zones 10 and 11
        sites.append(site)

    if not sites:
        raise ValueError(f"no camera sites found in {path}")
    return sites


def select_sites(sites: list[Site], args: argparse.Namespace) -> list[Site]:
    requested = args.site_names or {
        "pilot": PILOT_NAMES,
        "validation": VALIDATION_NAMES,
        "production": tuple(site.name for site in sites),
    }[args.mode]
    by_name = {site.name.casefold(): site for site in sites}
    missing = [name for name in requested if name.casefold() not in by_name]
    if missing:
        raise ValueError(f"camera(s) not found: {', '.join(missing)}")
    return [by_name[name.casefold()] for name in requested]


def apply_qgis_environment(qgis_root: Path) -> None:
    """fills PROJ/GDAL data paths and PATH when the launcher did not set them"""
    try:
        env = qgis_runtime(qgis_root).environment()
    except Exception:
        return
    for name in ("PROJ_DATA", "GDAL_DATA"):
        if not os.environ.get(name) and Path(env[name]).is_dir():
            os.environ[name] = env[name]
    os.environ["PATH"] = env["PATH"]


def require_gdal() -> None:
    if gdal is None:
        raise RuntimeError(
            "GDAL Python bindings are unavailable; run this script with the QGIS-bundled Python"
        )


# ---------------------------------------------------------------------------
# configuration hashing and resume state


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
    """inputs that change the 10 m viewshed rasters"""
    return {
        "sites_sha256": file_sha256(sites_path),
        "dem_inventory": [
            {"name": path.name, "size": path.stat().st_size, "mtime_ns": path.stat().st_mtime_ns}
            for path in dem_files
        ],
        "radius_m": args.radius_miles * 1609.344,
        "cell_size_m": args.cell_size,
        "refraction_coefficient": REFRACTION_COEFFICIENT,
    }


def web_config_payload(args: argparse.Namespace) -> dict[str, Any]:
    """inputs that change only the generalized web polygons"""
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
        "vector_pipeline": SCHEMA_VERSION,
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
        "schema_version": SCHEMA_VERSION,
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


def reusable_stages(
    state: dict[str, Any] | None,
    analysis_hash: str,
    web_hash: str,
    exact_required: bool,
) -> tuple[bool, bool, bool]:
    """returns (raster, exact polygon, web polygon) reusability for a saved state"""
    if not state or state.get("status") != "complete":
        return False, False, False
    outputs = state.get("outputs", {})

    def present(key: str) -> bool:
        return bool(outputs.get(key)) and Path(outputs[key]).is_file()

    analysis = state.get("analysis_hash") == analysis_hash and present("raster")
    exact = not exact_required or (analysis and present("exact"))
    web = analysis and state.get("web_hash") == web_hash and present("web")
    return analysis, exact, web


def output_paths(output_dir: Path, site: Site) -> dict[str, Path]:
    work = output_dir / "work" / site.stem
    return {
        "work": work,
        "dem": work / f"{site.stem}_dem_epsg{site.utm_epsg}.tif",
        "raster": output_dir / "rasters_10m" / f"{site.stem}.tif",
        "exact": output_dir / "polygons_exact" / f"{site.stem}.gpkg",
        "web": output_dir / "web" / f"{site.viewshed_id}.geojson",
        "state": output_dir / "state" / f"{site.stem}.json",
    }


def prepare_output(output_dir: Path) -> None:
    for name in ("rasters_10m", "polygons_exact", "web", "state", "work"):
        (output_dir / name).mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# progress reporting and cancellation


class ProgressEmitter:
    """prints human logs plus machine-readable GUI progress from the main process"""

    def __init__(self, enabled: bool, sites: list[Site]) -> None:
        self.enabled = enabled
        self.total = len(sites)
        self.names = {index: site.name for index, site in enumerate(sites, start=1)}
        self.fractions: dict[int, float] = {}
        self.started = time.monotonic()
        self.lock = threading.Lock()

    def _write(self, line: str) -> None:
        with self.lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def log(self, message: str) -> None:
        self._write(f"[{format_duration(time.monotonic() - self.started)}] {message}")

    def site_log(self, site_index: int, message: str) -> None:
        self.log(f"[{site_index}/{self.total}] {self.names[site_index]}: {message}")

    def progress(
        self,
        site_index: int,
        stage: str,
        fraction: float,
        detail: str | None,
    ) -> None:
        if site_index:
            self.fractions[site_index] = fraction
        percent = sum(self.fractions.values()) / self.total * 100 if self.total else 0.0
        if stage == "complete" and not site_index:
            percent = 100.0
        payload = {
            "percent": round(percent, 2),
            "site_index": site_index,
            "site_total": self.total,
            "site_name": self.names.get(site_index),
            "stage": stage,
            "detail": detail,
            "elapsed_seconds": round(time.monotonic() - self.started, 1),
        }
        if self.enabled:
            self._write("@@PROGRESS@@" + json.dumps(payload, separators=(",", ":")))
        if detail:
            if site_index:
                self.site_log(site_index, detail)
            else:
                self.log(detail)

    def handle(self, event: tuple[Any, ...]) -> None:
        """consumes one event sent by a worker reporter"""
        kind, site_index, *rest = event
        if kind == "log":
            self.site_log(site_index, rest[0])
        elif kind == "progress":
            self.progress(site_index, *rest)


class CancelState:
    """cancellation flag visible to the main process and every worker"""

    def __init__(self) -> None:
        self.local = threading.Event()
        self.shared: Any = None

    def request(self) -> None:
        self.local.set()
        if self.shared is not None:
            self.shared.set()

    def requested(self) -> bool:
        return self.local.is_set()


CANCEL = CancelState()


def request_cancel(_signum: int, _frame: Any) -> None:
    CANCEL.request()


class SiteReporter:
    """sends one camera's progress to the main process and exposes GDAL callbacks"""

    def __init__(self, site_index: int, sink: Any, cancel: Any) -> None:
        self.site_index = site_index
        self.sink = sink  # anything with put(event)
        self.cancel = cancel  # anything with is_set()

    def cancelled(self) -> bool:
        return bool(self.cancel.is_set())

    def check_cancel(self) -> None:
        if self.cancelled():
            raise CancelledError("run cancelled")

    def log(self, message: str) -> None:
        self.sink.put(("log", self.site_index, message))

    def stage(self, stage: str, detail: str | None = None, fraction: float | None = None) -> None:
        if fraction is None:
            fraction = STAGE_SPANS[stage][1]
        self.sink.put(("progress", self.site_index, stage, fraction, detail))

    def callback(self, stage: str) -> Callable[[float, str, Any], int]:
        """GDAL progress callback that reports fine-grained progress and honours cancel"""
        start, end = STAGE_SPANS[stage]
        last = [start]

        def progress(complete: float, _message: str, _data: Any) -> int:
            if self.cancelled():
                return 0
            fraction = start + (end - start) * min(max(complete, 0.0), 1.0)
            if fraction - last[0] >= 0.01:
                last[0] = fraction
                self.stage(stage, None, fraction)
            return 1

        return progress


class DirectSink:
    """delivers worker events straight to the emitter when running in-process"""

    def __init__(self, emitter: ProgressEmitter) -> None:
        self.emitter = emitter

    def put(self, event: tuple[Any, ...]) -> None:
        self.emitter.handle(event)


# ---------------------------------------------------------------------------
# spatial helpers


def spatial_reference(definition: int | str) -> Any:
    """builds an SRS with traditional lon/lat axis order"""
    srs = osr.SpatialReference()
    if isinstance(definition, int):
        srs.ImportFromEPSG(definition)
    elif definition.upper().startswith("EPSG:"):
        srs.ImportFromEPSG(int(definition.split(":", 1)[1]))
    else:
        srs.ImportFromWkt(definition)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def transformation(source: Any, target: Any) -> Any:
    return osr.CoordinateTransformation(source, target)


def epsg_code(srs: Any) -> str:
    code = srs.GetAuthorityCode(None)
    return f"EPSG:{code}" if code else srs.ExportToProj4()


def ogr_field_type(kind: str) -> int:
    return {"integer": ogr.OFTInteger, "real": ogr.OFTReal, "string": ogr.OFTString}[kind]


def memory_raster(values: Any, geotransform: tuple[float, ...], projection: str) -> Any:
    rows, columns = values.shape
    dataset = gdal.GetDriverByName("MEM").Create("", columns, rows, 1, gdal.GDT_Byte)
    dataset.SetGeoTransform(geotransform)
    dataset.SetProjection(projection)
    dataset.GetRasterBand(1).WriteArray(values)
    return dataset


def memory_vector() -> Any:
    driver = ogr.GetDriverByName("MEM") or ogr.GetDriverByName("Memory")
    return driver.CreateDataSource("")


def polygon_parts(geometry: Any) -> list[Any]:
    """returns the polygon members of any geometry, dropping lines and points"""
    kind = ogr.GT_Flatten(geometry.GetGeometryType())
    if kind == ogr.wkbPolygon:
        return [geometry] if not geometry.IsEmpty() else []
    if kind in (ogr.wkbMultiPolygon, ogr.wkbGeometryCollection):
        parts: list[Any] = []
        for index in range(geometry.GetGeometryCount()):
            parts.extend(polygon_parts(geometry.GetGeometryRef(index)))
        return parts
    return []


def union_polygons(geometries: Iterable[Any]) -> Any:
    """dissolves polygons into one valid MultiPolygon"""
    collection = ogr.Geometry(ogr.wkbMultiPolygon)
    for geometry in geometries:
        for part in polygon_parts(geometry):
            collection.AddGeometry(part.Clone())
    if collection.IsEmpty():
        return collection
    return as_multipolygon(collection.UnionCascaded())


def as_multipolygon(geometry: Any) -> Any:
    """makes a geometry valid and forces polygon-only MultiPolygon output"""
    valid = geometry.MakeValid()
    result = ogr.Geometry(ogr.wkbMultiPolygon)
    for part in polygon_parts(valid):
        result.AddGeometry(part.Clone())
    return result


def polygonize_visible(
    visible: Any,
    geotransform: tuple[float, ...],
    projection: str,
    callback: Callable[..., int] | None = None,
) -> Any:
    """dissolves the 8-connected visible cells of a boolean grid into one MultiPolygon"""
    raster = memory_raster(visible.astype(np.uint8), geotransform, projection)
    band = raster.GetRasterBand(1)
    vector = memory_vector()
    layer = vector.CreateLayer("visible", spatial_reference(projection), ogr.wkbPolygon)
    # the band doubles as its own mask, so only visible (non-zero) cells become polygons
    gdal.Polygonize(band, band, layer, -1, ["8CONNECTED=8"], callback=callback)
    geometry = union_polygons(feature.GetGeometryRef() for feature in layer)
    layer = vector = band = raster = None
    return geometry


def read_features(path: Path, layer_name: str | None = None) -> tuple[Any, list[tuple[Any, dict]]]:
    """returns the layer SRS and (geometry, attributes) pairs from a vector file"""
    source = ogr.Open(str(path))
    if source is None:
        raise RuntimeError(f"could not open vector file: {path}")
    layer = source.GetLayerByName(layer_name) if layer_name else source.GetLayer(0)
    if layer is None:
        raise RuntimeError(f"layer {layer_name or 0} missing in {path}")
    srs = layer.GetSpatialRef()
    srs = spatial_reference(srs.ExportToWkt()) if srs else None
    features = []
    for feature in layer:
        geometry = feature.GetGeometryRef()
        features.append((geometry.Clone() if geometry else None, feature.items()))
    return srs, features


def write_features(
    path: Path,
    driver: str,
    layer_name: str,
    srs: Any,
    fields: dict[str, str],
    features: Iterable[tuple[Any, dict[str, Any]]],
    layer_options: Iterable[str] = (),
    append: bool = False,
) -> int:
    """writes MultiPolygon features to a new file, or a new layer of an existing one"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if append and path.exists():
        source = ogr.Open(str(path), update=1)
    else:
        safe_unlink(path)
        source = ogr.GetDriverByName(driver).CreateDataSource(str(path))
    if source is None:
        raise RuntimeError(f"could not create {path}")
    layer = source.GetLayerByName(layer_name) if append else None
    if layer is None:
        layer = source.CreateLayer(layer_name, srs, ogr.wkbMultiPolygon, list(layer_options))
        for name, kind in fields.items():
            layer.CreateField(ogr.FieldDefn(name, ogr_field_type(kind)))
    definition = layer.GetLayerDefn()
    layer.StartTransaction()
    count = 0
    for geometry, attributes in features:
        feature = ogr.Feature(definition)
        feature.SetGeometry(ogr.ForceToMultiPolygon(geometry))
        for name in fields:
            value = attributes.get(name)
            if value is not None:
                feature.SetField(name, value)
        layer.CreateFeature(feature)
        count += 1
    layer.CommitTransaction()
    layer = source = None
    return count


def validate_vector(path: Path, layer_name: str | None, expected_count: int | None = None) -> int:
    """re-opens an output and checks that every geometry is present and valid"""
    _, features = read_features(path, layer_name)
    if expected_count is not None and len(features) != expected_count:
        raise RuntimeError(f"{path.name} has {len(features)} features; expected {expected_count}")
    for geometry, _ in features:
        if geometry is None or geometry.IsEmpty() or not geometry.IsValid():
            raise RuntimeError(f"invalid output geometry: {path}")
    return len(features)


def load_clip_boundary(path: Path) -> bytes:
    """projects the single web clip feature to EPSG:5070 and returns its WKB"""
    srs, features = read_features(path)
    if len(features) != 1 or features[0][0] is None:
        raise RuntimeError("web clip boundary must contain exactly one feature")
    geometry = features[0][0]
    geometry.Transform(transformation(srs or spatial_reference(WEB_CRS), spatial_reference(CANONICAL_CRS)))
    return bytes(as_multipolygon(geometry).ExportToWkb())


def smooth_geometry(geometry: Any, iterations: int) -> Any:
    """Chaikin corner cutting via QgsGeometry, matching native:smoothgeometry defaults"""
    try:
        from qgis.core import QgsGeometry
    except ImportError as error:
        raise RuntimeError("web smoothing needs the QGIS Python (qgis.core unavailable)") from error
    qgs_geometry = QgsGeometry()
    qgs_geometry.fromWkb(bytes(geometry.ExportToWkb()))
    smoothed = qgs_geometry.smooth(iterations, 0.25, -1.0, 180.0)
    if smoothed.isNull():
        raise RuntimeError("QGIS smoothing returned an empty geometry")
    return ogr.CreateGeometryFromWkb(bytes(smoothed.asWkb()))


def majority_filter_array(values: Any) -> Any:
    """returns a binary raster where at least 5 of 9 cells are visible"""
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


def site_attributes(site: Site, config: RunConfig) -> dict[str, Any]:
    return {
        "source_id": site.source_id,
        "viewshed_id": site.viewshed_id,
        "site_name": site.name,
        "height_ft": site.height_ft,
        "height_m": site.height_m,
        "radius_m": config.radius_m,
        "cell_size_m": config.cell_size_m,
        "method": "GDALViewshedGenerate",
    }


# ---------------------------------------------------------------------------
# per-camera pipeline


@dataclass
class ViewshedRaster:
    visible: Any  # boolean grid
    geotransform: tuple[float, ...]
    projection: str
    summary: dict[str, Any]


def build_vrt(output_dir: Path, dem_files: list[Path], emitter: ProgressEmitter, overwrite: bool) -> Path:
    vrt = output_dir / "source_dems.vrt"
    if vrt.exists() and not overwrite:
        emitter.log(f"reusing DEM index: {vrt}")
        return vrt
    safe_unlink(vrt)
    emitter.log(f"indexing {len(dem_files)} DEM TIFFs")
    dataset = gdal.BuildVRT(str(vrt), [str(path) for path in dem_files])
    dataset.FlushCache()
    dataset = None
    return vrt


def observer_coordinates(site: Site) -> tuple[float, float]:
    transform = transformation(spatial_reference(WEB_CRS), spatial_reference(site.utm_epsg))
    x, y, _ = transform.TransformPoint(site.longitude, site.latitude)
    return x, y


def build_dem(
    site: Site,
    observer: tuple[float, float],
    paths: dict[str, Path],
    config: RunConfig,
    reporter: SiteReporter,
) -> None:
    """warps the DEM index to a square, cell-aligned UTM grid around the camera"""
    x, y = observer
    margin = config.radius_m + config.cell_size_m
    paths["dem"].parent.mkdir(parents=True, exist_ok=True)
    gdal.Warp(
        str(paths["dem"]),
        str(config.source_vrt),
        dstSRS=f"EPSG:{site.utm_epsg}",
        outputBounds=(x - margin, y - margin, x + margin, y + margin),
        xRes=config.cell_size_m,
        yRes=config.cell_size_m,
        targetAlignedPixels=True,
        resampleAlg="bilinear",
        outputType=gdal.GDT_Float32,
        dstNodata=-999999,
        multithread=True,
        warpOptions=[f"NUM_THREADS={config.warp_threads}"],
        creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3"],
        callback=reporter.callback("dem"),
    )


def build_viewshed(
    site: Site,
    observer: tuple[float, float],
    paths: dict[str, Path],
    config: RunConfig,
    reporter: SiteReporter,
) -> None:
    x, y = observer
    safe_unlink(paths["raster"])
    paths["raster"].parent.mkdir(parents=True, exist_ok=True)
    dem = gdal.Open(str(paths["dem"]))
    output = gdal.ViewshedGenerate(
        dem.GetRasterBand(1),
        "GTiff",
        str(paths["raster"]),
        ["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=2"],
        x,
        y,
        site.height_m,  # observer height above the DEM cell
        0.0,  # target height
        1,  # visible value
        0,  # invisible value
        0,  # out of range value
        NODATA_VALUE,
        1.0 - REFRACTION_COEFFICIENT,  # GDAL curvature coefficient is one minus refraction
        gdal.GVM_Edge,
        config.radius_m,
        callback=reporter.callback("viewshed"),
    )
    if output is None:
        raise RuntimeError(f"viewshed generation failed for {site.name}")
    output.FlushCache()
    output = dem = None


def load_viewshed(path: Path, cell_size_m: float) -> ViewshedRaster:
    """reads a viewshed raster into memory and validates its contents"""
    dataset = gdal.Open(str(path))
    if dataset is None:
        raise RuntimeError(f"could not open viewshed raster: {path}")
    values = dataset.ReadAsArray()
    geotransform = tuple(dataset.GetGeoTransform())
    projection = dataset.GetProjection()
    dataset = None
    if values is None or values.ndim != 2:
        raise RuntimeError(f"viewshed raster is not a single band: {path}")
    if not set(np.unique(values).tolist()) <= {0, 1, NODATA_VALUE}:
        raise RuntimeError(f"viewshed validation failed: {path}")
    visible = values == 1
    visible_cells = int(np.count_nonzero(visible))
    if visible_cells <= 0:
        raise RuntimeError(f"viewshed has no visible cells: {path}")
    summary = {
        "width": int(values.shape[1]),
        "height": int(values.shape[0]),
        "visible_cells": visible_cells,
        "visible_area_sq_km": visible_cells * cell_size_m**2 / 1_000_000,
        "bytes": path.stat().st_size,
    }
    return ViewshedRaster(visible, geotransform, projection, summary)


def build_exact_polygon(
    site: Site,
    viewshed: ViewshedRaster,
    paths: dict[str, Path],
    config: RunConfig,
    reporter: SiteReporter,
) -> None:
    """dissolves every visible 10 m cell into one EPSG:5070 MultiPolygon"""
    geometry = polygonize_visible(
        viewshed.visible,
        viewshed.geotransform,
        viewshed.projection,
        reporter.callback("exact_polygon"),
    )
    if geometry.IsEmpty():
        raise RuntimeError(f"exact polygon is empty for {site.name}")
    canonical = spatial_reference(CANONICAL_CRS)
    geometry.Transform(transformation(spatial_reference(viewshed.projection), canonical))
    geometry = as_multipolygon(geometry)
    write_features(
        paths["exact"],
        "GPKG",
        SITE_LAYER,
        canonical,
        SITE_FIELDS,
        [(geometry, site_attributes(site, config))],
    )
    validate_vector(paths["exact"], SITE_LAYER, 1)


def build_web_polygon(
    site: Site,
    paths: dict[str, Path],
    config: RunConfig,
    reporter: SiteReporter,
) -> dict[str, Any]:
    """generalizes the viewshed to a web-friendly, smoothed, clipped GeoJSON polygon"""
    callback = reporter.callback("web_polygon")

    # coarser grid removes pixel-sized boundary detail before vectorizing
    web = gdal.Warp(
        "",
        str(paths["raster"]),
        format="MEM",
        xRes=config.web_resolution_m,
        yRes=config.web_resolution_m,
        targetAlignedPixels=True,
        resampleAlg="near",
        outputType=gdal.GDT_Byte,
        srcNodata=NODATA_VALUE,
        dstNodata=NODATA_VALUE,
    )
    values = web.ReadAsArray()
    geotransform = tuple(web.GetGeoTransform())
    projection = web.GetProjection()
    web = None
    reporter.check_cancel()

    raw_visible = int(np.count_nonzero(values == 1))
    if config.web_majority_filter:
        mask = majority_filter_array(values)
        changed = int(np.count_nonzero((values == 1) != (mask == 1)))
        reporter.log(f"3x3 majority filter changed {changed / values.size * 100:.2f}% of web cells")
    else:
        mask = (values == 1).astype(np.uint8)
        changed = 0
    if config.min_web_patch_cells:
        raster = memory_raster(mask, geotransform, projection)
        band = raster.GetRasterBand(1)
        gdal.SieveFilter(band, None, band, config.min_web_patch_cells, 8)
        mask = band.ReadAsArray()
        band = raster = None
    filter_summary = {
        "raw_visible_cells": raw_visible,
        "filtered_visible_cells": int(np.count_nonzero(mask == 1)),
        "changed_cells": changed,
        "changed_percent": changed / values.size * 100 if values.size else 0.0,
        "majority_enabled": config.web_majority_filter,
        "sieve_threshold_cells": config.min_web_patch_cells,
        "clip_enabled": config.clip_boundary_wkb is not None,
    }
    callback(0.2, "", None)

    geometry = polygonize_visible(mask == 1, geotransform, projection)
    if geometry.IsEmpty():
        raise RuntimeError(f"web polygon is empty for {site.name}")
    reporter.check_cancel()
    callback(0.5, "", None)

    canonical = spatial_reference(CANONICAL_CRS)
    geometry.Transform(transformation(spatial_reference(projection), canonical))
    if config.simplify_tolerance_m:
        geometry = as_multipolygon(geometry.SimplifyPreserveTopology(config.simplify_tolerance_m))
    if config.smooth_iterations:
        geometry = as_multipolygon(smooth_geometry(geometry, config.smooth_iterations))
    if config.clip_boundary_wkb is not None:
        clip = ogr.CreateGeometryFromWkb(config.clip_boundary_wkb)
        geometry = as_multipolygon(geometry.Intersection(clip))
    if geometry.IsEmpty():
        raise RuntimeError(f"web polygon is empty after generalization for {site.name}")
    callback(0.9, "", None)

    web_srs = spatial_reference(WEB_CRS)
    geometry.Transform(transformation(canonical, web_srs))
    write_features(
        paths["web"],
        "GeoJSON",
        SITE_LAYER,
        web_srs,
        SITE_FIELDS,
        [(geometry, site_attributes(site, config))],
        layer_options=["RFC7946=YES"],
    )
    validate_vector(paths["web"], None, 1)
    return filter_summary


def process_site(site: Site, site_index: int, config: RunConfig, reporter: SiteReporter) -> dict[str, Any]:
    """runs or resumes every stage for one camera and returns its state document"""
    paths = output_paths(config.output_dir, site)
    base_document = {
        "schema_version": SCHEMA_VERSION,
        "config_hash": config.config_hash,
        "analysis_hash": config.analysis_hash,
        "web_hash": config.web_hash,
        "site": asdict(site),
    }
    if site.height_m is None:
        document = {
            **base_document,
            "status": "skipped_missing_height",
            "generated_utc": utc_now(),
            "outputs": {"raster": None, "exact": None, "web": None},
            "elapsed_seconds": 0.0,
        }
        write_json(paths["state"], document)
        reporter.stage("complete", f"skipped {site.name}: missing camera height")
        return document

    previous_state = read_json(paths["state"])
    analysis_reusable, exact_reusable, web_reusable = reusable_stages(
        previous_state, config.analysis_hash, config.web_hash, config.exact_polygons
    )
    if config.overwrite:
        analysis_reusable = exact_reusable = web_reusable = False
    if analysis_reusable and exact_reusable and web_reusable:
        reporter.stage("complete", f"reused {site.name}")
        return previous_state or {}

    if paths["work"].exists():
        shutil.rmtree(paths["work"])
    paths["work"].mkdir(parents=True)
    if config.overwrite:
        for key in ("raster", "exact", "web", "state"):
            safe_unlink(paths[key])

    started = time.monotonic()
    reporter.stage("preparing", f"preparing {site.name}")
    if analysis_reusable:
        viewshed = load_viewshed(paths["raster"], config.cell_size_m)
        reporter.stage("viewshed", "reused 10 m viewshed")
    else:
        observer = observer_coordinates(site)
        build_dem(site, observer, paths, config, reporter)
        reporter.stage("dem", "projected DEM ready")
        build_viewshed(site, observer, paths, config, reporter)
        viewshed = load_viewshed(paths["raster"], config.cell_size_m)
        reporter.stage("viewshed", "viewshed validated")
    reporter.check_cancel()

    if not config.exact_polygons:
        exact_detail = "exact polygon skipped"
    elif exact_reusable:
        exact_detail = "reused exact polygon"
    else:
        build_exact_polygon(site, viewshed, paths, config, reporter)
        exact_detail = "exact polygon ready"
    reporter.stage("exact_polygon", exact_detail)
    reporter.check_cancel()

    if web_reusable:
        web_filter = (previous_state or {}).get("web_filter", {})
        reporter.stage("web_polygon", "reused web polygon")
    else:
        web_filter = build_web_polygon(site, paths, config, reporter)
        reporter.stage("web_polygon", "web polygon ready")

    document = {
        **base_document,
        "status": "complete",
        "generated_utc": utc_now(),
        "analysis_crs": f"EPSG:{site.utm_epsg}",
        "observer_height_m_agl": site.height_m,
        "raster": viewshed.summary,
        "web_filter": web_filter,
        "outputs": {
            "raster": str(paths["raster"]),
            "exact": str(paths["exact"]) if config.exact_polygons else None,
            "web": str(paths["web"]),
        },
        "elapsed_seconds": time.monotonic() - started,
    }
    write_json(paths["state"], document)
    if not config.keep_working_dems:
        shutil.rmtree(paths["work"], ignore_errors=True)
    reporter.stage("complete", f"completed {site.name} in {format_duration(time.monotonic() - started)}")
    return document


# ---------------------------------------------------------------------------
# worker orchestration

_WORKER: dict[str, Any] = {}


def _worker_init(sink: Any, cancel: Any, pool_worker: bool = True) -> None:
    """stores the shared event sink and cancel flag inside a worker process"""
    _WORKER["sink"] = sink
    _WORKER["cancel"] = cancel
    if pool_worker:
        # the parent owns cancellation and relays it through the shared event
        for name in ("SIGINT", "SIGBREAK"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_IGN)


def run_site(site: Site, site_index: int, config: RunConfig) -> dict[str, Any]:
    """worker entry point; never raises so results always travel back to the parent"""
    reporter = SiteReporter(site_index, _WORKER["sink"], _WORKER["cancel"])
    try:
        reporter.check_cancel()
        state = process_site(site, site_index, config, reporter)
        return {"site_index": site_index, "status": "ok", "state": state}
    except Exception as error:
        if reporter.cancelled():
            return {"site_index": site_index, "status": "cancelled"}
        return {"site_index": site_index, "status": "failed", "error": str(error)}


def run_sites(
    sites: list[Site],
    config: RunConfig,
    jobs: int,
    fail_fast: bool,
    emitter: ProgressEmitter,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """processes cameras serially or in a spawn-based process pool"""
    completed: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    def collect(result: dict[str, Any]) -> None:
        site = sites[result["site_index"] - 1]
        if result["status"] == "ok":
            completed.append(result["state"])
        elif result["status"] == "failed":
            failures.append({"site_name": site.name, "error": result["error"]})
            emitter.log(f"FAILED {site.name}: {result['error']}")
            if fail_fast:
                CANCEL.request()

    if jobs <= 1 or len(sites) == 1:
        _worker_init(DirectSink(emitter), CANCEL.local, pool_worker=False)
        for index, site in enumerate(sites, start=1):
            if CANCEL.requested():
                break
            collect(run_site(site, index, config))
        return completed, failures

    context = multiprocessing.get_context("spawn")
    events = context.Queue()
    CANCEL.shared = context.Event()
    if CANCEL.requested():
        CANCEL.shared.set()
    stop_pump = threading.Event()

    def pump() -> None:
        while not (stop_pump.is_set() and events.empty()):
            try:
                emitter.handle(events.get(timeout=0.2))
            except queue_module.Empty:
                continue

    pump_thread = threading.Thread(target=pump, daemon=True)
    pump_thread.start()
    emitter.log(f"processing up to {jobs} cameras in parallel")
    try:
        with ProcessPoolExecutor(
            max_workers=min(jobs, len(sites)),
            mp_context=context,
            initializer=_worker_init,
            initargs=(events, CANCEL.shared),
        ) as executor:
            pending = {
                executor.submit(run_site, site, index, config)
                for index, site in enumerate(sites, start=1)
            }
            try:
                # short timeouts keep signal handlers responsive on every platform
                while pending:
                    done, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
                    for future in done:
                        collect(future.result())
            finally:
                if CANCEL.requested():
                    for future in pending:
                        future.cancel()
    finally:
        stop_pump.set()
        pump_thread.join()
    return completed, failures


# ---------------------------------------------------------------------------
# combined products


def rebuild_combined_exact(states: list[dict[str, Any]], output_dir: Path, emitter: ProgressEmitter) -> Path | None:
    inputs = [Path(state["outputs"]["exact"]) for state in states if state["outputs"].get("exact")]
    if not inputs:
        return None
    combined = output_dir / "camera_viewsheds_exact_epsg5070.gpkg"
    emitter.log(f"combining {len(inputs)} exact polygons")

    def features() -> Iterable[tuple[Any, dict[str, Any]]]:
        for source in inputs:
            _, rows = read_features(source, SITE_LAYER)
            yield from rows

    write_features(combined, "GPKG", INDIVIDUAL_LAYER, spatial_reference(CANONICAL_CRS), SITE_FIELDS, features())
    validate_vector(combined, INDIVIDUAL_LAYER, len(inputs))
    return combined


def geopackage_feature_count(path: Path, layer: str) -> int | None:
    if not path.is_file():
        return None
    try:
        source = ogr.Open(str(path))
        target = source.GetLayerByName(layer) if source else None
        return target.GetFeatureCount() if target is not None else None
    except Exception:
        return None


def find_tippecanoe() -> Path | None:
    discovered = shutil.which("tippecanoe")
    candidates = [
        Path(discovered) if discovered else None,
        Path("/opt/homebrew/bin/tippecanoe"),
        Path("/usr/local/bin/tippecanoe"),
    ]
    return next((path for path in candidates if path and path.is_file()), None)


def validate_mbtiles(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        row = connection.execute("SELECT value FROM metadata WHERE name = 'json'").fetchone()
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


def rebuild_web_products(states: list[dict[str, Any]], output_dir: Path, emitter: ProgressEmitter) -> dict[str, Any] | None:
    """builds the review GeoPackage, Mapbox GeoJSON sources, and optional MBTiles"""
    inputs = [Path(state["outputs"]["web"]) for state in states if state["outputs"].get("web")]
    if not inputs:
        return None

    mapbox_dir = output_dir / "mapbox"
    mapbox_dir.mkdir(parents=True, exist_ok=True)
    staging = mapbox_dir / "camera_viewsheds_web_epsg5070.gpkg"
    individual_geojson = mapbox_dir / "camera-viewsheds.geojson"
    coverage_geojson = mapbox_dir / "camera-viewshed-coverage.geojson"
    mbtiles = mapbox_dir / "camera-viewsheds-z5.mbtiles"
    for path in (staging, individual_geojson, coverage_geojson, mbtiles):
        safe_unlink(path)

    canonical = spatial_reference(CANONICAL_CRS)
    web_srs = spatial_reference(WEB_CRS)
    to_canonical = transformation(web_srs, canonical)
    to_web = transformation(canonical, web_srs)

    # projected staging keeps the full union away from degree-based geometry math
    emitter.log(f"combining {len(inputs)} web polygons")
    individual: list[tuple[Any, dict[str, Any]]] = []
    for source in inputs:
        _, rows = read_features(source)
        for geometry, attributes in rows:
            geometry.Transform(to_canonical)
            individual.append((as_multipolygon(geometry), attributes))
    write_features(staging, "GPKG", INDIVIDUAL_LAYER, canonical, SITE_FIELDS, individual)
    validate_vector(staging, INDIVIDUAL_LAYER, len(inputs))

    emitter.log("dissolving web coverage")
    coverage = union_polygons(geometry for geometry, _ in individual)
    if coverage.IsEmpty():
        raise RuntimeError("dissolved web coverage is empty")
    # second layer makes the local review package match the hosted tileset
    write_features(
        staging, "GPKG", COVERAGE_LAYER, canonical, COVERAGE_FIELDS,
        [(coverage, {"coverage_id": "all"})], append=True,
    )
    validate_vector(staging, COVERAGE_LAYER, 1)

    for layer_name, fields, rows, destination in (
        (INDIVIDUAL_LAYER, SITE_FIELDS, individual, individual_geojson),
        (COVERAGE_LAYER, COVERAGE_FIELDS, [(coverage, {"coverage_id": "all"})], coverage_geojson),
    ):
        projected = []
        for geometry, attributes in rows:
            clone = geometry.Clone()
            clone.Transform(to_web)
            projected.append((clone, attributes))
        write_features(destination, "GeoJSON", layer_name, web_srs, fields, projected, ["RFC7946=YES"])
        validate_vector(destination, None, len(rows))

    packaging: dict[str, Any] = {"status": "skipped_tippecanoe_missing", "mbtiles": None, "error": None}
    tippecanoe = find_tippecanoe()
    if tippecanoe:
        emitter.log("building multilayer Mapbox MBTiles")
        try:
            result = subprocess.run(
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
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode:
                tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-20:])
                raise RuntimeError(f"tippecanoe failed ({result.returncode})\n{tail}")
            validate_mbtiles(mbtiles)
            packaging.update(status="complete", mbtiles=str(mbtiles))
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
    def relative(value: Any) -> str | None:
        return Path(value).relative_to(output_dir).as_posix() if value else None

    entries = []
    for state in states:
        site = state["site"]
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
                "web_geojson": relative(state["outputs"].get("web")),
                "exact_polygon": relative(state["outputs"].get("exact")),
            }
        )
    path_keys = {"individual_geojson", "coverage_geojson", "review_geopackage", "mbtiles"}
    manifest = output_dir / "viewshed-manifest.json"
    write_json(
        manifest,
        {
            "schema_version": SCHEMA_VERSION,
            "generated_utc": utc_now(),
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
            "combined_exact_polygon": relative(combined_exact),
            "web_products": (
                {
                    key: relative(value) if key in path_keys else value
                    for key, value in web_products.items()
                }
                if web_products
                else None
            ),
            "viewsheds": entries,
        },
    )
    return manifest


# ---------------------------------------------------------------------------


def main() -> int:
    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), request_cancel)
    args = parse_args()
    args.output_dir = args.output_dir.resolve()
    args.web_clip_boundary = args.web_clip_boundary.resolve()
    if args.web_clip and not args.web_clip_boundary.is_file():
        raise FileNotFoundError(f"web clip boundary not found: {args.web_clip_boundary}")
    apply_qgis_environment(args.qgis_app)
    require_gdal()

    sites = load_sites(args.sites)
    selected = select_sites(sites, args)
    emitter = ProgressEmitter(args.json_progress, selected)
    dem_files = sorted(args.dem_dir.glob("*.tif"))
    if not dem_files:
        raise RuntimeError(f"no GeoTIFF DEMs found in {args.dem_dir}")
    prepare_output(args.output_dir)

    previous_config = read_json(args.output_dir / "analysis_config.json") or {}
    config = config_document(args, dem_files, args.sites)
    analysis_changed = previous_config.get("analysis_hash") != config["analysis_hash"]
    emitter.progress(0, "preparing", 0.0, f"loaded {len(selected)} cameras and {len(dem_files)} DEMs")
    source_vrt = build_vrt(args.output_dir, dem_files, emitter, args.overwrite or analysis_changed)
    clip_wkb = load_clip_boundary(args.web_clip_boundary) if args.web_clip else None

    jobs = max(1, min(args.jobs, len(selected)))
    run_config = RunConfig(
        output_dir=args.output_dir,
        source_vrt=source_vrt,
        radius_m=config["radius_m"],
        cell_size_m=args.cell_size,
        web_resolution_m=args.web_resolution,
        simplify_tolerance_m=args.simplify_tolerance,
        smooth_iterations=args.smooth_iterations,
        web_majority_filter=args.web_majority_filter,
        min_web_patch_cells=args.min_web_patch_cells,
        exact_polygons=not args.skip_exact_polygons,
        keep_working_dems=args.keep_working_dems,
        overwrite=args.overwrite,
        warp_threads=max(1, (os.cpu_count() or 1) // jobs),
        clip_boundary_wkb=clip_wkb,
        analysis_hash=config["analysis_hash"],
        web_hash=config["web_hash"],
        config_hash=config["config_hash"],
    )

    completed, failures = run_sites(selected, run_config, jobs, args.fail_fast, emitter)
    if CANCEL.requested() and not (args.fail_fast and failures):
        emitter.log("cancelled by user")
        return 130
    completed.sort(key=lambda state: state["site"]["source_id"])

    if not failures:
        write_json(args.output_dir / "analysis_config.json", config)

    combined = None
    if completed and not args.skip_exact_polygons:
        expected_exact_count = sum(bool(state["outputs"].get("exact")) for state in completed)
        existing_combined = args.output_dir / "camera_viewsheds_exact_epsg5070.gpkg"
        if (
            not args.overwrite
            and not analysis_changed
            and geopackage_feature_count(existing_combined, INDIVIDUAL_LAYER) == expected_exact_count
        ):
            combined = existing_combined
            emitter.log(f"reusing combined exact polygon: {combined}")
        else:
            combined = rebuild_combined_exact(completed, args.output_dir, emitter)
    web_products = rebuild_web_products(completed, args.output_dir, emitter)
    manifest = write_manifest(completed, args.output_dir, config, combined, web_products)
    write_json(args.output_dir / "failures.json", failures)
    emitter.progress(0, "complete", 1.0, f"manifest ready: {manifest}")

    complete_count = sum(item.get("status") == "complete" for item in completed)
    skipped_count = sum(str(item.get("status", "")).startswith("skipped") for item in completed)
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
