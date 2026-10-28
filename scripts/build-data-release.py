#!/usr/bin/env python3
"""packages the published camera viewsheds as shapefile downloads for a GitHub release

Writes three zips, each with one viewshed shapefile per provider, a camera
location shapefile, the dissolved coverage of every provider, and a README
describing the fields:

    owdcic-viewsheds-oregon.zip       cameras sited in Oregon, coverage clipped to Oregon
    owdcic-viewsheds-washington.zip   cameras sited in Washington, coverage clipped to Washington
    owdcic-viewsheds-or-wa.zip        every camera and all coverage

The viewsheds are the smoothed, land-clipped polygons the map shows, read from
each provider's published manifest in data/live/ and the per-camera web polygons
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
STATE_BOUNDARIES = viewsheds.SOURCE_DATA_DIR / "divisions/state.geojson"
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
# clipping to a state line can leave zero-area rings; shapefiles store ring roles by
# winding order, which such a ring lacks, so it reads back as a nested shell
SLIVER_AREA_M2 = 1.0

from camera_providers import PROVIDER_LABELS  # noqa: E402

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
    "provider": f"camera network ({' | '.join(PROVIDER_LABELS)})",
    "view_id": "viewshed id; unique across providers; joins camera_locations to *_viewsheds",
    "site_name": "camera site name",
    "state": "state of the camera location (OR | WA | blank if neither)",
    "owner": "camera operator; Pano AI sites only",
    "height_ft": "camera height above ground (ft); used as observer height",
    "height_m": "camera height above ground (m)",
    "radius_m": "analysis radius (m)",
    "area_sqkm": "polygon area (sq km), measured in EPSG:5070",
    "longitude": "camera longitude (WGS 84)",
    "latitude": "camera latitude (WGS 84)",
    "viewshed": "viewshed included in this release (yes | no)",
    "coverage": "coverage extent (or | wa | or-wa)",
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


def drop_slivers(geometry: Any) -> Any:
    """removes polygons and holes smaller than SLIVER_AREA_M2"""
    result = viewsheds.ogr.Geometry(viewsheds.ogr.wkbMultiPolygon)

    for part in viewsheds.polygon_parts(geometry):
        if part.GetArea() < SLIVER_AREA_M2:
            continue

        polygon = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPolygon)
        polygon.AddGeometry(part.GetGeometryRef(0).Clone())

        for index in range(1, part.GetGeometryCount()):
            ring = part.GetGeometryRef(index)
            hole = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPolygon)
            hole.AddGeometry(ring.Clone())

            if hole.GetArea() >= SLIVER_AREA_M2:
                polygon.AddGeometry(ring.Clone())

        result.AddGeometry(polygon)

    return result


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


def table(headers: list[str], rows: list[list[Any]]) -> str:
    """left-aligned plain text columns"""
    cells = [headers, *[[str(value) for value in row] for row in rows]]
    widths = [max(len(row[column]) for row in cells) for column in range(len(headers))]

    return "\n".join(
        "  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip() for row in cells
    )


def field_table(fields: dict[str, str]) -> str:
    return table(["field", "type", "description"], [[name, kind, FIELD_NOTES[name]] for name, kind in fields.items()])


def readme_text(tag: str, label: str, state: str | None, summary: dict[str, Any], manifests: dict[str, dict]) -> str:
    processing = next(iter(manifests.values()))["web_processing"]
    cameras = summary["cameras"]
    totals = [sum(row[column] for row in cameras) for column in (1, 2, 3)]
    omitted = "\n".join(f"omitted: {name} (0 cameras in {label})" for name in summary["omitted"])

    return f"""OWDCIC CAMERA VIEWSHEDS: {label.upper()}

release: {tag}
packaged: {date.today().isoformat()}
map: {MAP_URL}
issues: https://github.com/{REPOSITORY}/issues
camera sources: https://github.com/{REPOSITORY}/blob/main/SOURCES.md

SCOPE
viewsheds: {f"cameras located in {label}; full viewsheds, not clipped at the state line" if state else "all cameras; full viewsheds"}
coverage: {f"clipped to the {label} state boundary" if state else "not clipped to a state"}

FILES
{table(["file", "features", "geometry", "crs"], summary["files"])}
{omitted}

CAMERAS
{table(
    ["provider", "sites", "with viewshed", "without viewshed", "viewsheds generated"],
    [*[[PROVIDER_LABELS[row[0]], *row[1:]] for row in cameras], ["total", *totals, ""]],
)}

COVERAGE
all providers, dissolved: {summary["coverage_sqkm"]:,.1f} sq km

CRS
EPSG:5070: NAD83 / Conus Albers, meters (viewsheds, coverage)
EPSG:4326: WGS 84, degrees (camera_locations)

METHOD
engine: GDAL ViewshedGenerate
terrain: USGS 3DEP 1/3 arc-second DEM, resampled to 10 m
analysis radius: {summary["radius_m"]:,.0f} m (12 mi)
observer height: camera height above ground
target height: 0 m (ground level)
refraction coefficient: {viewsheds.REFRACTION_COEFFICIENT}
not modeled: vegetation, buildings
generalization: {processing["resolution_m"]:g} m grid; 3x3 majority filter; {processing["simplify_tolerance_m"]:g} m simplification; {processing["smooth_iterations"]} smoothing passes; clipped to coastline; {VERTEX_TOLERANCE_M:g} m vertex cleanup
matches: polygons shown on the map
exact 10 m polygons: available on request

FIELDS: *_viewsheds.shp
{field_table(VIEWSHED_FIELDS)}

FIELDS: all_camera_coverage.shp
{field_table(COVERAGE_FIELDS)}

FIELDS: camera_locations.shp
{field_table(CAMERA_FIELDS)}
""".replace("\n\n\n", "\n\n")


def build_bundle(
    folder: Path,
    label: str,
    state: str | None,
    tag: str,
    providers: dict[str, list],
    cameras: list[dict[str, Any]],
    coverage: Any,
    manifests: dict[str, dict],
) -> tuple[Path, dict[str, Any]]:
    """writes one bundle's shapefiles and README, then zips the folder"""
    if folder.exists():
        shutil.rmtree(folder)

    folder.mkdir(parents=True)
    summary: dict[str, Any] = {"files": [], "omitted": [], "cameras": [], "radius_m": None}
    selected_cameras = [camera for camera in cameras if state is None or camera["state"] == state]

    for provider, rows in providers.items():
        selected = [row for row in rows if state is None or row[1]["state"] == state]
        sites = [camera for camera in selected_cameras if camera["provider"] == provider]
        with_viewshed = sum(camera["viewshed"] == "yes" for camera in sites)
        summary["cameras"].append([
            provider, len(sites), with_viewshed, len(sites) - with_viewshed,
            manifests[provider]["generated_utc"][:10],
        ])
        name = f"{provider}_viewsheds.shp"

        if not selected:
            summary["omitted"].append(name)
            continue

        write_polygons(folder / name, VIEWSHED_FIELDS, selected)
        summary["files"].append([name, len(selected), "polygon", viewsheds.CANONICAL_CRS])
        summary["radius_m"] = summary["radius_m"] or selected[0][1]["radius_m"]

    coverage_id = state.lower() if state else "or-wa"
    summary["coverage_sqkm"] = area_sqkm(coverage)
    write_polygons(
        folder / "all_camera_coverage.shp",
        COVERAGE_FIELDS,
        [(coverage, {"coverage": coverage_id, "area_sqkm": summary["coverage_sqkm"]})],
    )
    summary["files"].append(["all_camera_coverage.shp", 1, "polygon", viewsheds.CANONICAL_CRS])

    write_cameras(folder / "camera_locations.shp", selected_cameras)
    summary["files"].append(["camera_locations.shp", len(selected_cameras), "point", viewsheds.WEB_CRS])
    summary["files"].append(["README.txt", "", "", ""])

    (folder / "README.txt").write_text(readme_text(tag, label, state, summary, manifests), encoding="utf-8")

    archive = folder.with_suffix(".zip")
    viewsheds.safe_unlink(archive)

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(folder.iterdir()):
            bundle.write(path, f"{folder.name}/{path.name}")

    return archive, summary


def release_notes(tag: str, bundles: list[tuple[Path, str, dict[str, Any]]]) -> str:
    sections = []

    for archive, label, summary in bundles:
        url = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{archive.name}"
        rows = "\n".join(f"| {name} | {features} |" for name, features, *_ in summary["files"][:-1])
        sections.append(
            f"### {label}\n\n[{archive.name}]({url})\n\n| file | features |\n| --- | --- |\n{rows}\n\n"
            f"coverage: {summary['coverage_sqkm']:,.1f} sq km"
        )

    return (
        f"Camera viewshed shapefiles. Polygons match the [map]({MAP_URL}). "
        "Field definitions and method: README.txt in each zip.\n\n" + "\n\n".join(sections) + "\n"
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
        clipped = drop_slivers(clipped)
        archive, summary = build_bundle(
            release_dir / f"{ASSET_PREFIX}-{suffix}",
            label,
            state,
            tag,
            providers,
            cameras,
            clipped,
            manifests,
        )
        bundles.append((archive, label, summary))
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
