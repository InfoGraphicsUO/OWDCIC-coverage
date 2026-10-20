#!/usr/bin/env python3
"""packages the published camera viewsheds as shapefile downloads for a GitHub release

Writes three zips, each with one viewshed shapefile per provider, a camera
location shapefile, the dissolved coverage of every provider, and a README
describing the fields:

    owdcic-viewsheds-oregon.zip       cameras sited in Oregon, coverage clipped to Oregon
    owdcic-viewsheds-washington.zip   cameras sited in Washington, coverage clipped to Washington
    owdcic-viewsheds-or-wa.zip        every camera and all coverage

The viewsheds are the smoothed, land-clipped polygons the map shows, read from
each provider's published manifest in data/ and the per-camera web polygons
in outputs/. Asset names stay the same between releases, so the README can
link straight to the latest download.

Run under the QGIS Python like gdal-camera-viewsheds.py:

    python scripts/build-data-release.py
    python scripts/build-data-release.py --publish   # also creates the GitHub release with gh

The viewshed GUI runs this as its Data release preset.
"""

from __future__ import annotations

import argparse
from datetime import date
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from typing import Any
import zipfile

SCRIPTS = Path(__file__).resolve().parent

# share the viewshed engine, which wrote the polygons being packaged
sys.path.insert(0, str(SCRIPTS))
_spec = importlib.util.spec_from_file_location("gdal_camera_viewsheds", SCRIPTS / "gdal-camera-viewsheds.py")
viewsheds = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = viewsheds
_spec.loader.exec_module(viewsheds)

DATA_DIR = viewsheds.DATA_DIR
DEFAULT_OUTPUT = viewsheds.PROJECT_ROOT / "outputs/data_release"
STATE_BOUNDARIES = DATA_DIR / "divisions/state.geojson"
REPOSITORY = "InfoGraphicsUO/OWDCIC-coverage"
MAP_URL = "https://infographicsuo.github.io/OWDCIC-coverage"
ASSET_PREFIX = "owdcic-viewsheds"
PROGRESS_PREFIX = "@@PROGRESS@@"
# where the GitHub CLI installs when the GUI's PATH does not include it
GH_LOCATIONS = (
    Path("/opt/homebrew/bin/gh"),
    Path("/usr/local/bin/gh"),
    Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "GitHub CLI/gh.exe",
)
# drops the near-collinear vertices smoothing leaves behind; well under the 50 m web
# grid, it changes area by about 0.001% and cuts vertices (and zip size) by about 60%
VERTEX_TOLERANCE_M = 2.0

PROVIDER_LABELS = {
    "alertwest": "ALERTWest",
    "pano": "Pano AI",
    "envirovision": "EnviroVision",
}
# (asset suffix, label, state code or None for every camera)
BUNDLES = (
    ("oregon", "Oregon", "OR"),
    ("washington", "Washington", "WA"),
    ("or-wa", "Oregon and Washington", None),
)

# shapefile attribute names are limited to 10 characters
VIEWSHED_FIELDS = {
    "provider": "string",
    "view_id": "string",
    "site_name": "string",
    "state": "string",
    "height_ft": "real",
    "height_m": "real",
    "radius_m": "real",
    "area_sqkm": "real",
}
CAMERA_FIELDS = {
    "provider": "string",
    "view_id": "string",
    "site_name": "string",
    "state": "string",
    "owner": "string",
    "height_ft": "real",
    "longitude": "real",
    "latitude": "real",
    "viewshed": "string",
}
COVERAGE_FIELDS = {"coverage": "string", "area_sqkm": "real"}

FIELD_NOTES = {
    "provider": "camera network: alertwest, pano, or envirovision",
    "view_id": "viewshed id, unique across providers; matches the map and the camera layer",
    "site_name": "camera site name",
    "state": "state the camera stands in (OR, WA, or blank outside both)",
    "owner": "organization that runs the camera, where known (Pano AI sites)",
    "height_ft": "camera height above ground in feet, used as the observer height",
    "height_m": "the same height in meters",
    "radius_m": "analysis radius around the camera in meters (12 miles)",
    "area_sqkm": "polygon area in square kilometers, measured in EPSG:5070",
    "longitude": "camera longitude, WGS 84",
    "latitude": "camera latitude, WGS 84",
    "viewshed": "yes when the camera has a viewshed in this release; no when it is still missing one",
    "coverage": "area the coverage was dissolved for (or, wa, or or-wa)",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--tag",
        help="release tag, also used for the output folder (default: data-<today>, "
        "with -2, -3, ... when that release already exists)",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--qgis-app", type=Path, default=viewsheds.DEFAULT_QGIS_ROOT)
    parser.add_argument(
        "--publish",
        action="store_true",
        help="create the GitHub release with gh and upload the zips as the latest release",
    )
    parser.add_argument("--json-progress", action="store_true")

    return parser.parse_args()


class Progress:
    """prints status lines, plus percent events for the GUI's progress bar"""

    def __init__(self, json_progress: bool) -> None:
        self.json_progress = json_progress

    def __call__(self, fraction: float, detail: str) -> None:
        if self.json_progress:
            event = {"percent": round(fraction * 100, 1), "detail": detail}
            print(PROGRESS_PREFIX + json.dumps(event), flush=True)

        print(detail, flush=True)


def find_gh() -> str:
    found = shutil.which("gh") or next((str(path) for path in GH_LOCATIONS if path.is_file()), None)
    if not found:
        raise SystemExit("GitHub CLI (gh) not found; install it from https://cli.github.com and run gh auth login")

    return found


def check_gh(gh: str) -> None:
    """fails before the slow packaging when the upload could not happen"""
    result = subprocess.run([gh, "auth", "status", "--hostname", "github.com"], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("GitHub CLI is not signed in; run gh auth login in a terminal, then try again")


def release_exists(gh: str, tag: str) -> bool:
    result = subprocess.run([gh, "release", "view", tag, "--repo", REPOSITORY], capture_output=True, text=True)
    return result.returncode == 0


def next_tag(gh: str | None) -> str:
    """dates the release, numbering repeat releases on the same day"""
    base = f"data-{date.today().isoformat()}"
    tag, number = base, 1

    while gh and release_exists(gh, tag):
        number += 1
        tag = f"{base}-{number}"

    return tag


def area_sqkm(geometry: Any) -> float:
    return round(geometry.GetArea() / 1_000_000, 3)


def load_states() -> dict[str, Any]:
    """returns each state's EPSG:5070 boundary by its two-letter code"""
    srs, rows = viewsheds.read_features(STATE_BOUNDARIES)
    to_canonical = viewsheds.transformation(srs, viewsheds.spatial_reference(viewsheds.CANONICAL_CRS))
    states = {}

    for geometry, attributes in rows:
        geometry.Transform(to_canonical)
        states[attributes["state"]] = viewsheds.as_multipolygon(geometry)

    return states


def state_of(longitude: float, latitude: float, states: dict[str, Any], to_canonical: Any) -> str:
    point = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPoint)
    point.AddPoint_2D(longitude, latitude)
    point.Transform(to_canonical)

    return next((code for code, boundary in states.items() if boundary.Contains(point)), "")


def load_provider(provider: str, states: dict[str, Any], to_canonical: Any) -> tuple[dict, list, list]:
    """returns the published manifest, viewshed rows, and camera rows for one provider

    The camera list comes from the published manifest, so the release matches
    the live map even while a newer run sits unpublished in outputs/.
    """
    manifest = json.loads((DATA_DIR / f"{provider}-viewshed-manifest.json").read_text(encoding="utf-8"))
    output_dir = viewsheds.PROVIDER_OUTPUTS[provider]
    local = viewsheds.read_json(output_dir / f"{provider}-viewshed-manifest.json")

    if local and local["generated_utc"] != manifest["generated_utc"]:
        print(
            f"note: {provider} has an unpublished run from {local['generated_utc']}; "
            f"packaging the published one from {manifest['generated_utc']}",
            flush=True,
        )

    rows = []
    with_viewshed = set()

    for entry in manifest["viewsheds"]:
        if entry["status"] != "complete":
            continue

        srs, features = viewsheds.read_features(output_dir / entry["web_geojson"])
        geometry, attributes = features[0]
        geometry.Transform(viewsheds.transformation(srs, viewsheds.spatial_reference(viewsheds.CANONICAL_CRS)))
        geometry = viewsheds.as_multipolygon(geometry.SimplifyPreserveTopology(VERTEX_TOLERANCE_M))
        with_viewshed.add(entry["viewshed_id"])
        rows.append((geometry, {
            "provider": provider,
            "view_id": entry["viewshed_id"],
            "site_name": entry["site_name"],
            "state": state_of(entry["longitude"], entry["latitude"], states, to_canonical),
            "height_ft": entry["height_ft"],
            "height_m": attributes.get("height_m"),
            "radius_m": attributes.get("radius_m"),
            "area_sqkm": area_sqkm(geometry),
        }))

    sites = json.loads((DATA_DIR / f"{provider}-sites.geojson").read_text(encoding="utf-8"))
    cameras = []

    for feature in sites["features"]:
        properties = feature["properties"]
        longitude, latitude = feature["geometry"]["coordinates"][:2]
        view_id = viewsheds.slugify(str(properties.get("viewshedId") or properties["name"]))
        cameras.append({
            "provider": provider,
            "view_id": view_id,
            "site_name": properties["name"],
            "state": state_of(longitude, latitude, states, to_canonical),
            "owner": properties.get("owner"),
            "height_ft": properties.get("cameraHeightFt"),
            "longitude": longitude,
            "latitude": latitude,
            "viewshed": "yes" if view_id in with_viewshed else "no",
        })

    return manifest, rows, cameras


def write_cameras(path: Path, cameras: list[dict[str, Any]]) -> None:
    """writes camera points; the engine's writer only handles polygons"""
    source = viewsheds.ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(str(path))
    layer = source.CreateLayer(
        path.stem, viewsheds.spatial_reference(viewsheds.WEB_CRS), viewsheds.ogr.wkbPoint, ["ENCODING=UTF-8"]
    )

    for name, kind in CAMERA_FIELDS.items():
        layer.CreateField(viewsheds.ogr.FieldDefn(name, viewsheds.ogr_field_type(kind)))

    definition = layer.GetLayerDefn()

    for camera in cameras:
        feature = viewsheds.ogr.Feature(definition)
        point = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPoint)
        point.AddPoint_2D(camera["longitude"], camera["latitude"])
        feature.SetGeometry(point)

        for name in CAMERA_FIELDS:
            if camera.get(name) is not None:
                feature.SetField(name, camera[name])

        layer.CreateFeature(feature)

    layer = source = None


def write_polygons(path: Path, fields: dict[str, str], rows: list[tuple[Any, dict]]) -> None:
    viewsheds.write_features(
        path,
        "ESRI Shapefile",
        path.stem,
        viewsheds.spatial_reference(viewsheds.CANONICAL_CRS),
        fields,
        rows,
        ["ENCODING=UTF-8"],
    )
    viewsheds.validate_vector(path, None, len(rows))


def field_table(fields: dict[str, str]) -> str:
    return "\n".join(f"  {name:<10}  {FIELD_NOTES[name]}" for name in fields)


def readme_text(
    tag: str, label: str, state: str | None, contents: list[str], manifests: dict[str, dict]
) -> str:
    processing = next(iter(manifests.values()))["web_processing"]
    runs = "\n".join(
        f"  {PROVIDER_LABELS[provider]}: {manifest['generated_utc'][:10]}"
        for provider, manifest in manifests.items()
    )
    scope = (
        f"Viewshed layers hold the cameras that stand in {label}; each keeps its full\n"
        f"viewshed, including any part that reaches across the state line. The coverage\n"
        f"layer is clipped to {label}."
        if state
        else "Viewshed layers hold every mapped camera. The coverage layer is not clipped\nto a state."
    )

    return f"""Oregon-Washington wildfire camera viewsheds: {label}
Release {tag}, packaged {date.today().isoformat()}
Interactive map: {MAP_URL}
Questions and requests: https://github.com/{REPOSITORY}/issues

{scope}

Files
{chr(10).join(f"  {line}" for line in contents)}

Viewsheds were last generated on
{runs}

Coordinate systems
  Viewshed and coverage shapefiles: NAD83 / Conus Albers (EPSG:5070), meters
  camera_locations: WGS 84 (EPSG:4326)

Method
  Each viewshed is the land a camera can see within 12 miles, computed with
  GDAL ViewshedGenerate on USGS 3DEP 1/3 arc-second terrain resampled to 10 m.
  The observer stands at the camera's height above the ground, targets are at
  ground level, and a refraction coefficient of {viewsheds.REFRACTION_COEFFICIENT} accounts for earth
  curvature. Trees and buildings are not modeled, so real views are smaller.

  These are the polygons shown on the map: the 10 m result is resampled to a
  {processing['resolution_m']:g} m grid, cleaned with a 3x3 majority filter, simplified at {processing['simplify_tolerance_m']:g} m,
  smoothed ({processing['smooth_iterations']} passes), and clipped to the coastline. Leftover vertices
  within {VERTEX_TOLERANCE_M:g} m of a straight line are then dropped to keep the files small.
  Exact 10 m polygons are available on request.

Viewshed fields (*_viewsheds.shp)
{field_table(VIEWSHED_FIELDS)}

Coverage fields (all_camera_coverage.shp)
{field_table(COVERAGE_FIELDS)}

Camera fields (camera_locations.shp)
{field_table(CAMERA_FIELDS)}

Camera sources are listed at https://github.com/{REPOSITORY}/blob/main/SOURCES.md
"""


def build_bundle(
    folder: Path,
    label: str,
    state: str | None,
    tag: str,
    providers: dict[str, list],
    cameras: list[dict[str, Any]],
    coverage: Any,
    manifests: dict[str, dict],
) -> tuple[Path, list[str]]:
    """writes one bundle's shapefiles and README, then zips the folder"""
    if folder.exists():
        shutil.rmtree(folder)

    folder.mkdir(parents=True)
    contents = []

    for provider, rows in providers.items():
        selected = [row for row in rows if state is None or row[1]["state"] == state]
        if not selected:
            contents.append(f"{provider}_viewsheds: none; no {PROVIDER_LABELS[provider]} cameras here")
            continue

        write_polygons(folder / f"{provider}_viewsheds.shp", VIEWSHED_FIELDS, selected)
        contents.append(f"{provider}_viewsheds.shp: {len(selected)} {PROVIDER_LABELS[provider]} camera viewsheds")

    coverage_id = state.lower() if state else "or-wa"
    write_polygons(
        folder / "all_camera_coverage.shp",
        COVERAGE_FIELDS,
        [(coverage, {"coverage": coverage_id, "area_sqkm": area_sqkm(coverage)})],
    )
    contents.append(
        f"all_camera_coverage.shp: every provider's viewsheds dissolved into one area "
        f"({area_sqkm(coverage):,.0f} sq km)"
    )

    selected_cameras = [camera for camera in cameras if state is None or camera["state"] == state]
    write_cameras(folder / "camera_locations.shp", selected_cameras)
    missing = sum(camera["viewshed"] == "no" for camera in selected_cameras)
    contents.append(
        f"camera_locations.shp: {len(selected_cameras)} camera sites, {missing} still without a viewshed"
    )

    (folder / "README.txt").write_text(readme_text(tag, label, state, contents, manifests), encoding="utf-8")

    archive = folder.with_suffix(".zip")
    viewsheds.safe_unlink(archive)

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(folder.iterdir()):
            bundle.write(path, f"{folder.name}/{path.name}")

    return archive, contents


def release_notes(tag: str, bundles: list[tuple[Path, str, list[str]]]) -> str:
    sections = "\n\n".join(
        f"**{label}** ([{archive.name}](https://github.com/{REPOSITORY}/releases/download/{tag}/{archive.name}))\n"
        + "\n".join(f"- {line}" for line in contents)
        for archive, label, contents in bundles
    )

    return (
        "Camera viewshed shapefiles for GIS use, matching the polygons on the "
        f"[map]({MAP_URL}). Each zip has a README.txt with field descriptions and the method.\n\n"
        f"{sections}\n"
    )


def main() -> int:
    args = parse_args()
    # the GUI's cancel button terminates this process; exit like the viewshed runner does
    signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(130))
    progress = Progress(args.json_progress)
    viewsheds.apply_qgis_environment(args.qgis_app)
    viewsheds.require_gdal()
    gh = find_gh() if args.publish else None

    if gh:
        check_gh(gh)

    tag = args.tag or next_tag(gh)

    if gh and release_exists(gh, tag):
        raise SystemExit(f"release {tag} already exists; choose another --tag")

    progress(0.0, f"building release {tag}")
    states = load_states()
    to_canonical = viewsheds.transformation(
        viewsheds.spatial_reference(viewsheds.WEB_CRS), viewsheds.spatial_reference(viewsheds.CANONICAL_CRS)
    )
    manifests, providers, cameras = {}, {}, []

    # rough shares of a run: loading 25%, dissolving 30%, zipping 30%, uploading 15%
    for index, provider in enumerate(viewsheds.PROVIDER_OUTPUTS):
        progress(0.25 * index / len(viewsheds.PROVIDER_OUTPUTS), f"loading {PROVIDER_LABELS[provider]} viewsheds")
        manifest, rows, provider_cameras = load_provider(provider, states, to_canonical)
        manifests[provider], providers[provider] = manifest, rows
        cameras.extend(provider_cameras)
        print(f"loaded {len(rows)} {provider} viewsheds and {len(provider_cameras)} cameras", flush=True)

    progress(0.25, "dissolving combined coverage")
    coverage = viewsheds.union_polygons(geometry for rows in providers.values() for geometry, _ in rows)
    release_dir = args.output_dir / tag
    bundles = []

    for index, (suffix, label, state) in enumerate(BUNDLES):
        progress(0.55 + 0.3 * index / len(BUNDLES), f"packaging the {label} download")
        clipped = coverage if state is None else viewsheds.as_multipolygon(coverage.Intersection(states[state]))
        archive, contents = build_bundle(
            release_dir / f"{ASSET_PREFIX}-{suffix}",
            label,
            state,
            tag,
            providers,
            cameras,
            clipped,
            manifests,
        )
        bundles.append((archive, label, contents))
        print(f"wrote {archive} ({archive.stat().st_size / 1_000_000:.0f} MB)", flush=True)

    notes = release_dir / "release-notes.md"
    notes.write_text(release_notes(tag, bundles), encoding="utf-8")
    print(f"wrote {notes}", flush=True)

    if not gh:
        progress(1.0, f"release {tag} is ready in {release_dir}")
        return 0

    progress(0.85, f"uploading release {tag} to GitHub")
    subprocess.run(
        [
            gh, "release", "create", tag,
            *(str(archive) for archive, _, _ in bundles),
            "--repo", REPOSITORY,
            "--title", f"Camera viewshed data ({tag.removeprefix('data-')})",
            "--notes-file", str(notes),
            "--latest",
        ],
        check=True,
    )
    progress(1.0, f"release {tag} is live at https://github.com/{REPOSITORY}/releases/tag/{tag}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
