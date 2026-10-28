"""checks the tools and data a viewshed run needs, for the viewshed GUI's Setup tab

each check says what it found and, when something is missing, how to fix it, so a
new maintainer can get a machine ready without reading the scripts
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
import json
import math
from pathlib import Path
import shutil
import subprocess

from camera_providers import PROVIDER_LABELS, output_dir, sites_path
from qgis_runtime import find_tippecanoe

ROOT = Path(__file__).resolve().parents[1]
DEM_TILES = ROOT / 'data/source/or-wa-dems-latest.csv'
DEFAULT_DEMS = ROOT / 'data/source/dems'
# where the DEMs lived before data/ was split into live and source folders
LEGACY_DEMS = ROOT / 'data/dems'
WEB_PACKAGE = 'mapbox/camera_viewsheds_web_epsg5070.gpkg'
# where the GitHub CLI installs when a double-clicked launcher's PATH does not include it
GH_LOCATIONS = (Path('/opt/homebrew/bin/gh'), Path('/usr/local/bin/gh'), Path('C:/Program Files/GitHub CLI/gh.exe'))
# the DEMs take about 30 GB and the provider output folders a few more
MIN_FREE_GB = 10
KM_PER_DEGREE = 111.32


@dataclass(frozen=True)
class Check:
    name: str
    # ok, warning (some runs still work) or problem (runs will fail)
    status: str
    detail: str
    fix: str = ''


def read_tiles(path: Path = DEM_TILES) -> list[dict]:
    with path.open(newline='', encoding='utf-8') as file:
        return list(csv.DictReader(file))


def tile_file(row: dict) -> str:
    return row['download_url'].rsplit('/', 1)[-1]


def missing_tiles(dem_dir: Path, rows: list[dict]) -> list[dict]:
    """tiles absent from the folder or cut short by an interrupted download"""
    return [row for row in rows if not (dem_dir / tile_file(row)).is_file()
            or (dem_dir / tile_file(row)).stat().st_size != int(row['size_bytes'])]


def tile_name(longitude: float, latitude: float) -> str:
    """USGS names each 1 degree tile after its north-west corner"""
    return f'n{math.floor(latitude) + 1}w{-math.floor(longitude):03d}'


def tiles_for_camera(longitude: float, latitude: float, radius_miles: float) -> set[str]:
    radius_km = radius_miles * 1.609344
    dlat = radius_km / KM_PER_DEGREE
    dlon = radius_km / (KM_PER_DEGREE * math.cos(math.radians(latitude)))
    # a 12 mile radius is far smaller than a tile, so its corners and edges name every tile it touches
    return {tile_name(longitude + x * dlon, latitude + y * dlat) for x in (-1, 0, 1) for y in (-1, 0, 1)}


def cameras_outside_tiles(rows: list[dict], radius_miles: float) -> list[tuple[str, str, list[str]]]:
    listed = {row['tile'] for row in rows}
    outside = []

    for provider in PROVIDER_LABELS:
        path = sites_path(provider)
        if not path.is_file():
            continue

        for feature in json.loads(path.read_text(encoding='utf-8'))['features']:
            longitude, latitude = feature['geometry']['coordinates'][:2]
            needed = sorted(tiles_for_camera(longitude, latitude, radius_miles) - listed)
            if needed:
                outside.append((PROVIDER_LABELS[provider], feature['properties']['name'], needed))

    return outside


def qgis_check(root: Path) -> Check:
    if not root.is_dir():
        return Check('QGIS', 'problem', f'not found at {root}',
                     'Install QGIS from qgis.org, or set OWDCIC_QGIS_ROOT to its install folder.')

    try:
        from osgeo import gdal
    except ImportError:
        return Check('QGIS', 'problem', f'{root} found, but its GDAL could not be loaded',
                     'Start the GUI with generate-viewshed-macos.command or generate-viewshed-win.bat.')

    return Check('QGIS', 'ok', f'{root.name}, GDAL {gdal.__version__}')


def dem_check(dem_dir: Path, rows: list[dict]) -> Check:
    missing = missing_tiles(dem_dir, rows)

    if not missing:
        return Check('Terrain (DEMs)', 'ok', f'all {len(rows)} tiles in {dem_dir}')

    size_gb = sum(int(row['size_bytes']) for row in missing) / 1e9
    detail = f'{len(missing)} of {len(rows)} tiles missing from {dem_dir} ({size_gb:.0f} GB)'

    if dem_dir.resolve() == DEFAULT_DEMS.resolve() and LEGACY_DEMS.is_dir() and any(LEGACY_DEMS.glob('*.tif')):
        return Check('Terrain (DEMs)', 'problem', detail,
                     f'Move the tiles in {LEGACY_DEMS} to {DEFAULT_DEMS} instead of downloading them again.')

    return Check('Terrain (DEMs)', 'problem', detail,
                 'Use Download missing DEMs below, or copy the tiles from another machine.')


def dem_coverage_check(rows: list[dict], radius_miles: float) -> Check:
    outside = cameras_outside_tiles(rows, radius_miles)

    if not outside:
        return Check('Terrain coverage', 'ok', f'every camera\'s {radius_miles:g} mile radius is inside the tile list')

    names = ', '.join(f'{name} ({provider})' for provider, name, _ in outside[:5])
    tiles = sorted({tile for *_, needed in outside for tile in needed})
    return Check('Terrain coverage', 'problem',
                 f'{len(outside)} cameras reach past the DEM tiles: {names}{", …" if len(outside) > 5 else ""}',
                 f'Check those sites\' coordinates. If they are right, add tiles {", ".join(tiles)} '
                 f'from apps.nationalmap.gov to {DEM_TILES.relative_to(ROOT)}.')


def tippecanoe_check() -> Check:
    found = find_tippecanoe()

    if found:
        return Check('tippecanoe', 'ok', str(found))

    return Check('tippecanoe', 'problem', 'not found; Live site runs and the combined coverage need it',
                 'macOS: brew install tippecanoe. It has no native Windows build, so publish from a Mac or Linux machine.')


def find_gh() -> str | None:
    return shutil.which('gh') or next((str(path) for path in GH_LOCATIONS if path.is_file()), None)


def gh_check() -> Check:
    gh = find_gh()

    if not gh:
        return Check('GitHub CLI', 'warning', 'not found; only the Data release upload needs it',
                     'Install it from cli.github.com, then run gh auth login in a terminal.')

    try:
        result = subprocess.run([gh, 'auth', 'status', '--hostname', 'github.com'],
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return Check('GitHub CLI', 'warning', f'could not check sign-in: {error}')

    if result.returncode:
        return Check('GitHub CLI', 'warning', 'not signed in; only the Data release upload needs it',
                     'Run gh auth login in a terminal.')

    return Check('GitHub CLI', 'ok', 'signed in to github.com')


def outputs_check() -> Check:
    """each provider's saved viewsheds feed the combined coverage and metrics of every Live run"""
    missing = [label for provider, label in PROVIDER_LABELS.items() if not (output_dir(provider) / WEB_PACKAGE).is_file()]

    if not missing:
        return Check('Saved viewsheds', 'ok', f'every provider has a folder in {(ROOT / "outputs").relative_to(ROOT)}')

    return Check('Saved viewsheds', 'warning',
                 f'no saved viewsheds for {", ".join(missing)}; Live site runs cannot rebuild the combined coverage '
                 'or metrics without every provider',
                 'Copy the outputs/gdal_viewsheds_* folders from the previous maintainer, which git does not track, '
                 'or run a Live site run for each provider listed.')


def disk_check(path: Path = ROOT) -> Check:
    free_gb = shutil.disk_usage(path).free / 1e9

    if free_gb >= MIN_FREE_GB:
        return Check('Disk space', 'ok', f'{free_gb:.0f} GB free')

    return Check('Disk space', 'warning', f'{free_gb:.0f} GB free; runs and DEM downloads may run out',
                 f'Free up at least {MIN_FREE_GB} GB.')


def git_check(root: Path = ROOT) -> Check:
    try:
        result = subprocess.run(['git', 'status', '--porcelain', '--', 'data'], cwd=root,
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return Check('Data changes', 'warning', 'git not found, so changes to data/ cannot be listed')

    changed = [line for line in result.stdout.splitlines() if line.strip()]

    if not changed:
        return Check('Data changes', 'ok', 'no uncommitted changes in data/')

    return Check('Data changes', 'warning', f'{len(changed)} uncommitted files in data/',
                 'Commit them before a Live site run, so the run\'s own changes are easy to review.')


def run_checks(qgis_root: Path, dem_dir: Path, radius_miles: float) -> list[Check]:
    rows = read_tiles()
    return [
        qgis_check(qgis_root),
        dem_check(dem_dir, rows),
        dem_coverage_check(rows, radius_miles),
        tippecanoe_check(),
        outputs_check(),
        gh_check(),
        disk_check(),
        git_check(),
    ]
