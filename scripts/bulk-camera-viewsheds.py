#!/usr/bin/env python
"""build per-camera geodesic viewsheds from the project GeoJSON and USGS DEMs"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


FEET_TO_METERS = 0.3048
MILES_TO_KILOMETERS = 1.609344
DEFAULT_RADIUS_MILES = 20.0
DEFAULT_RADIUS_KM = DEFAULT_RADIUS_MILES * MILES_TO_KILOMETERS
SCRIPT_DIR = Path(__file__).resolve().parent

# portable bundle keeps script sites.geojson and dems together
if (SCRIPT_DIR / "sites.geojson").is_file() or (SCRIPT_DIR / "dems").is_dir():
    PROJECT_ROOT = SCRIPT_DIR
    DEFAULT_SITES_PATH = PROJECT_ROOT / "sites.geojson"
    DEFAULT_DEM_DIR = PROJECT_ROOT / "dems"
else:
    PROJECT_ROOT = SCRIPT_DIR.parent
    DEFAULT_SITES_PATH = PROJECT_ROOT / "data" / "sites.geojson"
    DEFAULT_DEM_DIR = PROJECT_ROOT / "data" / "dems"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "outputs" / "viewsheds"


@dataclass(frozen=True)
class Site:
    """camera input needed by the ArcPy workflow"""

    source_id: int
    name: str
    longitude: float
    latitude: float
    height_ft: float | None

    @property
    def height_m(self) -> float | None:
        return None if self.height_ft is None else self.height_ft * FEET_TO_METERS


@dataclass(frozen=True)
class WorkflowResult:
    """paths and counts returned to command-line and toolbox callers"""

    geodatabase: str
    combined_polygons: str | None
    geojson: str | None
    failures: int
    site_count: int
    dem_count: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create one ArcGIS Pro Geodesic Viewshed raster per camera. "
            "Run this with the Python Command Prompt installed with ArcGIS Pro."
        )
    )
    parser.add_argument(
        "--sites",
        type=Path,
        default=DEFAULT_SITES_PATH,
        help="camera GeoJSON (default: auto-detected sites.geojson)",
    )
    parser.add_argument(
        "--dem-dir",
        type=Path,
        default=DEFAULT_DEM_DIR,
        help="folder containing the local DEM GeoTIFFs; every TIFF is used",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="folder for the file geodatabase, log, and optional GeoJSON",
    )
    parser.add_argument(
        "--radius-km",
        type=float,
        default=DEFAULT_RADIUS_KM,
        help="2D outer radius in kilometers (default: 32.18688 km / 20 mi)",
    )
    parser.add_argument(
        "--rebuild-mosaic",
        action="store_true",
        help="replace the generated mosaic dataset so newly added TIFFs are included",
    )
    parser.add_argument(
        "--overwrite-viewsheds",
        action="store_true",
        help="replace existing per-camera outputs instead of resuming around them",
    )
    parser.add_argument(
        "--polygons",
        action="store_true",
        help="also create per-camera and combined visible-area polygons",
    )
    parser.add_argument(
        "--export-geojson",
        action="store_true",
        help="export combined polygons to camera_viewsheds.geojson; implies --polygons",
    )
    parser.add_argument(
        "--cpu-only",
        action="store_true",
        help="disable GPU processing for Geodesic Viewshed",
    )
    args = parser.parse_args()

    if args.radius_km <= 0:
        parser.error("--radius-km must be greater than zero")
    if args.export_geojson:
        args.polygons = True
    return args


def load_arcpy():
    """loads ArcPy with a useful error outside the ArcGIS Pro environment"""

    try:
        import arcpy  # pylint: disable=import-outside-toplevel
    except ImportError as error:
        raise SystemExit(
            "ArcPy is unavailable. Run this script from the ArcGIS Pro Python "
            "Command Prompt or an ArcGIS Pro notebook."
        ) from error
    return arcpy


def load_sites(path: Path) -> list[Site]:
    """reads and validates the camera fields used by the analysis"""

    with path.open(encoding="utf-8") as source:
        payload = json.load(source)

    if payload.get("type") != "FeatureCollection":
        raise ValueError(f"{path} is not a GeoJSON FeatureCollection")

    sites: list[Site] = []
    names: set[str] = set()
    for source_id, feature in enumerate(payload.get("features", []), start=1):
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        coordinates = geometry.get("coordinates") or []
        name = str(properties.get("name") or "").strip()

        if geometry.get("type") != "Point" or len(coordinates) < 2:
            raise ValueError(f"feature {source_id} is not a valid point")
        if not name:
            raise ValueError(f"feature {source_id} has no name")
        if name.casefold() in names:
            raise ValueError(f"duplicate camera name: {name}")

        longitude = float(coordinates[0])
        latitude = float(coordinates[1])
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise ValueError(f"{name} has invalid coordinates")

        raw_height = properties.get("cameraHeightFt")
        height_ft = None if raw_height in (None, "") else float(raw_height)
        if height_ft is not None and (not math.isfinite(height_ft) or height_ft <= 0):
            raise ValueError(f"{name} has an invalid cameraHeightFt value")

        names.add(name.casefold())
        sites.append(Site(source_id, name, longitude, latitude, height_ft))

    if not sites:
        raise ValueError(f"{path} contains no camera points")
    return sites


def safe_dataset_name(name: str, source_id: int) -> str:
    """returns a stable geodatabase-safe suffix for one camera"""

    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", ascii_name).strip("_").lower()
    slug = slug[:42].rstrip("_") or f"camera_{source_id:03d}"
    if slug[0].isdigit():
        slug = f"camera_{slug}"
    return f"{source_id:03d}_{slug}"


def message(arcpy, text: str) -> None:
    """writes progress to both ArcGIS geoprocessing and the terminal"""

    print(text)
    try:
        arcpy.AddMessage(text)
    except RuntimeError:
        pass


def find_dem_files(dem_dir: Path) -> list[Path]:
    extensions = {".tif", ".tiff"}
    return sorted(
        path for path in dem_dir.rglob("*") if path.is_file() and path.suffix.lower() in extensions
    )


def ensure_geodatabase(arcpy, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    geodatabase = output_dir / "camera_viewsheds.gdb"
    if not arcpy.Exists(str(geodatabase)):
        arcpy.management.CreateFileGDB(str(output_dir), geodatabase.name)
    return geodatabase


def ensure_local_scratch_geodatabase(arcpy) -> str:
    """keeps ArcGIS intermediate rasters off network workspaces"""

    scratch_dir = Path(tempfile.gettempdir()) / "owdcic_viewsheds"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    scratch_geodatabase = scratch_dir / "scratch.gdb"
    if not arcpy.Exists(str(scratch_geodatabase)):
        arcpy.management.CreateFileGDB(str(scratch_dir), scratch_geodatabase.name)
    return str(scratch_geodatabase)


def create_camera_feature_class(arcpy, geodatabase: Path, sites: list[Site]) -> str:
    """creates a clean observer feature class from the minimal GeoJSON fields"""

    output = str(geodatabase / "camera_sites")
    if arcpy.Exists(output):
        arcpy.management.Delete(output)

    arcpy.management.CreateFeatureclass(
        str(geodatabase), "camera_sites", "POINT", spatial_reference=arcpy.SpatialReference(4326)
    )
    arcpy.management.AddField(output, "source_id", "LONG")
    arcpy.management.AddField(output, "site_name", "TEXT", field_length=150)
    arcpy.management.AddField(output, "height_ft", "DOUBLE")
    arcpy.management.AddField(output, "height_m", "DOUBLE")

    fields = ["SHAPE@XY", "source_id", "site_name", "height_ft", "height_m"]
    with arcpy.da.InsertCursor(output, fields) as cursor:
        for site in sites:
            cursor.insertRow(
                (
                    (site.longitude, site.latitude),
                    site.source_id,
                    site.name,
                    site.height_ft,
                    site.height_m,
                )
            )
    return output


def prepare_mosaic_dataset(
    arcpy, geodatabase: Path, dem_dir: Path, dem_files: list[Path], rebuild: bool
) -> str:
    """references tiled DEMs without writing a massive statewide raster"""

    mosaic = str(geodatabase / "dem_mosaic")
    if arcpy.Exists(mosaic) and not rebuild:
        message(arcpy, "Reusing dem_mosaic; use --rebuild-mosaic after adding DEM files")
        return mosaic
    if arcpy.Exists(mosaic):
        arcpy.management.Delete(mosaic)

    first_description = arcpy.Describe(str(dem_files[0]))
    spatial_reference = first_description.spatialReference
    if not spatial_reference or spatial_reference.name == "Unknown":
        raise RuntimeError(f"DEM has an unknown coordinate system: {dem_files[0]}")

    arcpy.management.CreateMosaicDataset(
        str(geodatabase),
        "dem_mosaic",
        spatial_reference,
        num_bands=1,
        pixel_type="32_BIT_FLOAT",
    )
    arcpy.management.AddRastersToMosaicDataset(
        mosaic,
        "Raster Dataset",
        str(dem_dir),
        filter=r"REGEX:.*\.[Tt][Ii][Ff]{1,2}$",
        sub_folder="SUBFOLDERS",
        duplicate_items_action="EXCLUDE_DUPLICATES",
        build_pyramids="NO_PYRAMIDS",
        calculate_statistics="CALCULATE_STATISTICS",
        build_thumbnails="NO_THUMBNAILS",
    )
    return mosaic


def add_polygon_metadata(
    arcpy, polygon: str, site: Site, radius_km: float, dem_source: str, run_utc: str
) -> None:
    fields = {field.name.casefold() for field in arcpy.ListFields(polygon)}
    definitions = (
        ("site_name", "TEXT", 150),
        ("height_ft", "DOUBLE", None),
        ("radius_km", "DOUBLE", None),
        ("dem_source", "TEXT", 80),
        ("run_utc", "TEXT", 32),
    )
    for name, field_type, length in definitions:
        if name.casefold() not in fields:
            kwargs = {"field_length": length} if length else {}
            arcpy.management.AddField(polygon, name, field_type, **kwargs)

    update_fields = ["site_name", "height_ft", "radius_km", "dem_source", "run_utc"]
    with arcpy.da.UpdateCursor(polygon, update_fields) as cursor:
        for _ in cursor:
            cursor.updateRow((site.name, site.height_ft, radius_km, dem_source, run_utc))


class RunRecorder:
    """flushes one CSV status row after every camera"""

    def __init__(self, path: Path):
        self.handle = path.open("w", newline="", encoding="utf-8")
        self.writer = csv.DictWriter(
            self.handle,
            fieldnames=["source_id", "site_name", "status", "raster", "polygon", "detail"],
        )
        self.writer.writeheader()
        self.handle.flush()

    def add(
        self,
        site: Site,
        status: str,
        raster: str = "",
        polygon: str = "",
        detail: str = "",
    ) -> None:
        self.writer.writerow(
            {
                "source_id": site.source_id,
                "site_name": site.name,
                "status": status,
                "raster": raster,
                "polygon": polygon,
                "detail": detail,
            }
        )
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


def create_polygon(arcpy, raster: str, polygon: str) -> None:
    """keeps visible value 1 and drops non-visible value 0"""

    if arcpy.Exists(polygon):
        arcpy.management.Delete(polygon)
    visible_only = arcpy.sa.SetNull(raster, 1, "VALUE = 0")
    arcpy.conversion.RasterToPolygon(
        visible_only,
        polygon,
        simplify="NO_SIMPLIFY",
        raster_field="Value",
        create_multipart_features="MULTIPLE_OUTER_PART",
    )


def process_viewsheds(
    arcpy,
    sites: list[Site],
    camera_features: str,
    mosaic: str,
    geodatabase: Path,
    scratch_geodatabase: str,
    output_dir: Path,
    radius_km: float,
    overwrite: bool,
    polygons: bool,
    cpu_only: bool,
) -> tuple[list[str], int]:
    """runs one bounded viewshed at a time and keeps processing after site errors"""

    recorder = RunRecorder(output_dir / "viewshed_run.csv")
    polygon_outputs: list[str] = []
    failures = 0
    run_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
    target_device = "CPU_ONLY" if cpu_only else "GPU_THEN_CPU"

    try:
        for position, site in enumerate(sites, start=1):
            suffix = safe_dataset_name(site.name, site.source_id)
            raster = str(geodatabase / f"vs_{suffix}")
            polygon = str(geodatabase / f"vp_{suffix}") if polygons else ""
            raster_created = False

            if site.height_m is None:
                detail = "cameraHeightFt is missing"
                message(arcpy, f"[{position}/{len(sites)}] skipping {site.name}: {detail}")
                recorder.add(site, "skipped", detail=detail)
                continue

            try:
                message(arcpy, f"[{position}/{len(sites)}] processing {site.name}")
                if overwrite and arcpy.Exists(raster):
                    arcpy.management.Delete(raster)

                if not arcpy.Exists(raster):
                    observer_layer = "camera_observer_layer"
                    where = f"source_id = {site.source_id}"
                    arcpy.management.MakeFeatureLayer(camera_features, observer_layer, where)

                    observer = "memory/camera_observer"
                    analysis_area = "memory/camera_analysis_area"
                    for temporary in (observer, analysis_area):
                        if arcpy.Exists(temporary):
                            arcpy.management.Delete(temporary)
                    arcpy.management.CopyFeatures(observer_layer, observer)

                    # geodesic buffer keeps the distance consistent across WGS 84 latitudes
                    arcpy.analysis.Buffer(
                        observer,
                        analysis_area,
                        f"{radius_km} Kilometers",
                        dissolve_option="ALL",
                        method="GEODESIC",
                    )
                    analysis_extent = arcpy.Describe(analysis_area).extent

                    # frequency with one observer produces a binary 0/1 viewshed
                    with arcpy.EnvManager(
                        workspace=str(geodatabase),
                        scratchWorkspace=scratch_geodatabase,
                        extent=analysis_extent,
                        snapRaster=mosaic,
                        cellSize=mosaic,
                    ):
                        # explicit output avoids a fragile Map Algebra temp raster
                        arcpy.ddd.Viewshed2(
                            in_raster=mosaic,
                            in_observer_features=observer,
                            out_raster=raster,
                            analysis_type="FREQUENCY",
                            vertical_error=0,
                            refractivity_coefficient=0.13,
                            surface_offset=0,
                            observer_elevation=None,
                            observer_offset="height_m",
                            inner_radius=0,
                            inner_radius_is_3d="GROUND",
                            outer_radius=f"{radius_km} Kilometers",
                            outer_radius_is_3d="GROUND",
                            horizontal_start_angle=0,
                            horizontal_end_angle=360,
                            vertical_upper_angle=90,
                            vertical_lower_angle=-90,
                            analysis_method="ALL_SIGHTLINES",
                            analysis_target_device=target_device,
                        )
                    raster_created = True

                if polygons:
                    if overwrite or not arcpy.Exists(polygon):
                        create_polygon(arcpy, raster, polygon)
                        add_polygon_metadata(
                            arcpy,
                            polygon,
                            site,
                            radius_km,
                            "USGS 1/3 arc-second DEM",
                            run_utc,
                        )
                    polygon_outputs.append(polygon)

                status = "created" if raster_created else "complete"
                recorder.add(site, status, raster, polygon)
            except Exception as error:  # ArcPy errors vary by installed Pro release
                failures += 1
                detail = str(error).replace("\n", " ")
                message(arcpy, f"Failed {site.name}: {detail}")
                recorder.add(site, "failed", raster, polygon, detail)
    finally:
        recorder.close()

    return polygon_outputs, failures


def merge_and_export_polygons(
    arcpy,
    polygon_outputs: list[str],
    geodatabase: Path,
    output_dir: Path,
    export_geojson: bool,
) -> str | None:
    if not polygon_outputs:
        return None

    combined = str(geodatabase / "camera_viewsheds_combined")
    if arcpy.Exists(combined):
        arcpy.management.Delete(combined)
    arcpy.management.Merge(polygon_outputs, combined)

    if export_geojson:
        output_geojson = output_dir / "camera_viewsheds.geojson"
        if output_geojson.exists():
            output_geojson.unlink()
        arcpy.conversion.FeaturesToJSON(
            combined,
            str(output_geojson),
            format_json="FORMATTED",
            geoJSON="GEOJSON",
            outputToWGS84="WGS84",
        )
    return combined


def run_workflow(
    sites_path: Path,
    dem_dir: Path,
    output_dir: Path,
    radius_km: float = DEFAULT_RADIUS_KM,
    rebuild_mosaic: bool = False,
    overwrite_viewsheds: bool = False,
    polygons: bool = False,
    export_geojson: bool = False,
    cpu_only: bool = False,
) -> WorkflowResult:
    """runs the complete workflow for CLI and Python toolbox entry points"""

    sites_path = Path(sites_path).resolve()
    dem_dir = Path(dem_dir).resolve()
    output_dir = Path(output_dir).resolve()
    if radius_km <= 0:
        raise ValueError("radius_km must be greater than zero")
    if export_geojson:
        polygons = True

    sites = load_sites(sites_path)
    dem_files = find_dem_files(dem_dir)
    if not dem_files:
        raise RuntimeError(f"No GeoTIFF DEMs found in {dem_dir}")

    arcpy = load_arcpy()
    arcpy.env.overwriteOutput = True
    message(arcpy, f"Using {len(dem_files)} GeoTIFF DEMs from {dem_dir}")
    geodatabase = ensure_geodatabase(arcpy, output_dir)
    scratch_geodatabase = ensure_local_scratch_geodatabase(arcpy)
    message(arcpy, f"Local scratch geodatabase: {scratch_geodatabase}")
    camera_features = create_camera_feature_class(arcpy, geodatabase, sites)
    mosaic = prepare_mosaic_dataset(
        arcpy,
        geodatabase,
        dem_dir,
        dem_files,
        rebuild_mosaic,
    )

    if arcpy.CheckExtension("Spatial") != "Available":
        raise SystemExit("The Geodesic Viewshed workflow requires a Spatial Analyst license")

    arcpy.CheckOutExtension("Spatial")
    try:
        polygon_outputs, failures = process_viewsheds(
            arcpy,
            sites,
            camera_features,
            mosaic,
            geodatabase,
            scratch_geodatabase,
            output_dir,
            radius_km,
            overwrite_viewsheds,
            polygons,
            cpu_only,
        )
        combined = merge_and_export_polygons(
            arcpy,
            polygon_outputs,
            geodatabase,
            output_dir,
            export_geojson,
        )
    finally:
        arcpy.CheckInExtension("Spatial")

    message(arcpy, f"Viewshed geodatabase: {geodatabase}")
    if combined:
        message(arcpy, f"Combined polygons: {combined}")
    if failures:
        message(arcpy, f"Completed with {failures} failed camera(s); see viewshed_run.csv")
    else:
        message(arcpy, "Viewshed processing complete")

    geojson = (
        str(output_dir / "camera_viewsheds.geojson")
        if export_geojson and combined
        else None
    )
    return WorkflowResult(
        geodatabase=str(geodatabase),
        combined_polygons=combined,
        geojson=geojson,
        failures=failures,
        site_count=len(sites),
        dem_count=len(dem_files),
    )


def main() -> int:
    args = parse_args()
    result = run_workflow(
        sites_path=args.sites,
        dem_dir=args.dem_dir,
        output_dir=args.output_dir,
        radius_km=args.radius_km,
        rebuild_mosaic=args.rebuild_mosaic,
        overwrite_viewsheds=args.overwrite_viewsheds,
        polygons=args.polygons,
        export_geojson=args.export_geojson,
        cpu_only=args.cpu_only,
    )
    return 1 if result.failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("Cancelled") from None
