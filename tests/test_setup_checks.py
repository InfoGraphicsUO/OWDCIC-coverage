"""checks the GUI's setup checks and the DEM download"""
import contextlib
import csv
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import setup_checks  # noqa: E402
from qgis_runtime import default_qgis_root  # noqa: E402

spec = importlib.util.spec_from_file_location('fetch_dems', SCRIPTS / 'fetch-dems.py')
fetch_dems = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_dems)


def write_tiles(directory: Path, sources: dict[str, bytes]) -> Path:
    """a tile list whose download URLs point at local files"""
    rows = []

    for tile, content in sources.items():
        source = directory / 'server' / f'USGS_13_{tile}.tif'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(content)
        rows.append({'tile': tile, 'size_bytes': len(content), 'download_url': source.as_uri()})

    path = directory / 'tiles.csv'
    with path.open('w', newline='', encoding='utf-8') as file:
        writer = csv.DictWriter(file, fieldnames=['tile', 'size_bytes', 'download_url'])
        writer.writeheader()
        writer.writerows(rows)

    return path


class DemTileTests(unittest.TestCase):
    def test_tiles_are_named_after_their_north_west_corner(self):
        self.assertEqual(setup_checks.tile_name(-116.5, 41.5), 'n42w117')
        self.assertEqual(setup_checks.tile_name(-123.0, 45.0), 'n46w123')

    def test_a_radius_crossing_a_tile_edge_needs_both_tiles(self):
        self.assertEqual(setup_checks.tiles_for_camera(-116.5, 41.5, 12), {'n42w117'})
        self.assertEqual(setup_checks.tiles_for_camera(-116.99, 41.5, 12), {'n42w117', 'n42w118'})

    def test_every_camera_is_inside_the_listed_tiles(self):
        self.assertEqual(setup_checks.cameras_outside_tiles(setup_checks.read_tiles(), 12), [])

    def test_a_short_tile_counts_as_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            rows = setup_checks.read_tiles(write_tiles(directory, {'n42w117': b'abc', 'n42w118': b'defg'}))
            dems = directory / 'dems'
            dems.mkdir()
            (dems / 'USGS_13_n42w117.tif').write_bytes(b'abc')
            (dems / 'USGS_13_n42w118.tif').write_bytes(b'de')
            self.assertEqual([row['tile'] for row in setup_checks.missing_tiles(dems, rows)], ['n42w118'])
            check = setup_checks.dem_check(dems, rows)
            self.assertEqual(check.status, 'problem')
            self.assertIn('1 of 2 tiles missing', check.detail)

    def test_download_fetches_only_missing_tiles(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tiles = write_tiles(directory, {'n42w117': b'abc', 'n42w118': b'defg'})
            dems = directory / 'dems'
            dems.mkdir()
            kept = dems / 'USGS_13_n42w117.tif'
            kept.write_bytes(b'abc')
            before = kept.stat().st_mtime_ns

            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(fetch_dems.main(['--dem-dir', str(dems), '--tiles', str(tiles)]), 0)

            self.assertEqual((dems / 'USGS_13_n42w118.tif').read_bytes(), b'defg')
            # a finished tile is left alone
            self.assertEqual(kept.stat().st_mtime_ns, before)
            self.assertEqual(list(dems.glob('*.part')), [])


class QgisDiscoveryTests(unittest.TestCase):
    def test_newest_mac_install_is_found(self):
        with tempfile.TemporaryDirectory() as directory:
            applications = Path(directory)

            for name in ('QGIS-final-4_0_3.app', 'QGIS-final-4_2_1.app', 'QGIS-final-3_44_2.app'):
                (applications / name).mkdir()

            self.assertEqual(default_qgis_root('darwin', {}, applications).name, 'QGIS-final-4_2_1.app')

    def test_missing_mac_install_falls_back_to_the_standard_name(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(default_qgis_root('darwin', {}, Path(directory)).name, 'QGIS.app')


if __name__ == '__main__':
    unittest.main()
