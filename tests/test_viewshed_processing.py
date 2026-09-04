from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "gdal_camera_viewsheds",
    SCRIPTS / "gdal-camera-viewsheds.py",
)
viewsheds = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = viewsheds
SPEC.loader.exec_module(viewsheds)

try:
    import numpy as np
except ImportError:
    np = None


def make_args(directory: Path, **overrides):
    dem = directory / "dem.tif"
    dem.write_bytes(b"dem")
    sites = directory / "sites.geojson"
    sites.write_text("{}", encoding="utf-8")
    boundary = directory / "boundary.geojson"
    boundary.write_text("boundary", encoding="utf-8")
    values = dict(
        radius_miles=20.0,
        cell_size=10.0,
        web_resolution=50.0,
        simplify_tolerance=25.0,
        smooth_iterations=1,
        web_majority_filter=True,
        min_web_patch_cells=0,
        web_clip=True,
        web_clip_boundary=boundary,
        skip_exact_polygons=False,
    )
    values.update(overrides)
    return SimpleNamespace(**values), [dem], sites


class ConfigurationTests(unittest.TestCase):
    def test_web_settings_change_only_web_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            args, dems, sites = make_args(Path(directory))
            first = viewsheds.config_document(args, dems, sites)
            args.web_resolution = 100.0
            second = viewsheds.config_document(args, dems, sites)

        self.assertEqual(first["analysis_hash"], second["analysis_hash"])
        self.assertNotEqual(first["web_hash"], second["web_hash"])
        self.assertNotEqual(first["config_hash"], second["config_hash"])

    def test_dem_change_invalidates_analysis_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            args, dems, sites = make_args(Path(directory))
            first = viewsheds.config_document(args, dems, sites)
            dems[0].write_bytes(b"dem with more bytes")
            second = viewsheds.config_document(args, dems, sites)

        self.assertNotEqual(first["analysis_hash"], second["analysis_hash"])
        self.assertNotEqual(first["web_hash"], second["web_hash"])

    def test_boundary_change_invalidates_only_web_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            boundary = Path(directory) / "boundary.geojson"
            boundary.write_text("first boundary", encoding="utf-8")
            args = SimpleNamespace(
                web_resolution=50,
                simplify_tolerance=25,
                smooth_iterations=1,
                web_majority_filter=True,
                min_web_patch_cells=0,
                web_clip=True,
                web_clip_boundary=boundary,
            )

            first = viewsheds.web_config_payload(args)
            boundary.write_text("updated boundary", encoding="utf-8")
            second = viewsheds.web_config_payload(args)

            self.assertNotEqual(
                first["web_clip_boundary_sha256"],
                second["web_clip_boundary_sha256"],
            )

    def test_disabled_clipping_does_not_require_boundary_file(self):
        args = SimpleNamespace(
            web_resolution=50,
            simplify_tolerance=25,
            smooth_iterations=1,
            web_majority_filter=True,
            min_web_patch_cells=0,
            web_clip=False,
            web_clip_boundary=Path("missing-boundary.geojson"),
        )

        config = viewsheds.web_config_payload(args)

        self.assertFalse(config["web_clip"])
        self.assertIsNone(config["web_clip_boundary_sha256"])


class BoundaryDataTests(unittest.TestCase):
    def test_checked_in_boundary_is_one_oregon_washington_feature(self):
        boundary_path = SCRIPTS.parent / "data/or-wa-boundary.geojson"
        boundary = json.loads(boundary_path.read_text(encoding="utf-8"))

        self.assertEqual(boundary["type"], "FeatureCollection")
        self.assertEqual(len(boundary["features"]), 1)
        self.assertEqual(boundary["features"][0]["properties"]["region"], "OR-WA")
        self.assertIn(
            boundary["features"][0]["geometry"]["type"],
            {"Polygon", "MultiPolygon"},
        )


class ResumeTests(unittest.TestCase):
    def make_state(self, root: Path, **overrides):
        outputs = {}
        for key, name in (("raster", "camera.tif"), ("exact", "camera.gpkg"), ("web", "camera.geojson")):
            path = root / name
            path.touch()
            outputs[key] = str(path)
        state = {
            "status": "complete",
            "analysis_hash": "analysis",
            "web_hash": "web",
            "outputs": outputs,
        }
        state.update(overrides)
        return state

    def test_matching_hashes_reuse_every_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self.make_state(Path(directory))
            self.assertEqual(
                viewsheds.reusable_stages(state, "analysis", "web", True),
                (True, True, True),
            )

    def test_web_change_keeps_raster_and_exact_polygon(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self.make_state(Path(directory))
            self.assertEqual(
                viewsheds.reusable_stages(state, "analysis", "web-changed", True),
                (True, True, False),
            )

    def test_analysis_change_rebuilds_everything(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self.make_state(Path(directory))
            self.assertEqual(
                viewsheds.reusable_stages(state, "analysis-changed", "web", True),
                (False, False, False),
            )

    def test_missing_output_file_is_not_reusable(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self.make_state(Path(directory))
            Path(state["outputs"]["exact"]).unlink()
            self.assertEqual(
                viewsheds.reusable_stages(state, "analysis", "web", True),
                (True, False, True),
            )
            # exact polygons are not required, so their absence does not matter
            self.assertEqual(
                viewsheds.reusable_stages(state, "analysis", "web", False),
                (True, True, True),
            )

    def test_incomplete_or_missing_state_is_not_reusable(self):
        self.assertEqual(
            viewsheds.reusable_stages(None, "analysis", "web", True),
            (False, False, False),
        )
        self.assertEqual(
            viewsheds.reusable_stages({"status": "failed"}, "analysis", "web", True),
            (False, False, False),
        )


@unittest.skipIf(np is None, "QGIS NumPy runtime not available")
class MajorityFilterTests(unittest.TestCase):
    def test_isolated_cell_is_removed(self):
        values = np.zeros((3, 3), dtype=np.uint8)
        values[1, 1] = 1
        self.assertEqual(int(viewsheds.majority_filter_array(values).sum()), 0)

    def test_hole_is_filled(self):
        values = np.ones((3, 3), dtype=np.uint8)
        values[1, 1] = 0
        self.assertEqual(viewsheds.majority_filter_array(values)[1, 1], 1)

    def test_exact_five_cell_majority_is_visible(self):
        values = np.array(
            [[0, 1, 0], [1, 1, 1], [0, 1, 0]],
            dtype=np.uint8,
        )
        self.assertEqual(viewsheds.majority_filter_array(values)[1, 1], 1)

    def test_outside_raster_is_invisible(self):
        values = np.ones((3, 3), dtype=np.uint8)
        result = viewsheds.majority_filter_array(values)
        self.assertEqual(result[0, 0], 0)
        self.assertEqual(result[0, 1], 1)

    def test_empty_raster_stays_empty(self):
        values = np.zeros((4, 4), dtype=np.uint8)
        self.assertFalse(viewsheds.majority_filter_array(values).any())

    def test_full_raster_keeps_interior_visible(self):
        values = np.ones((5, 5), dtype=np.uint8)
        result = viewsheds.majority_filter_array(values)
        self.assertTrue(result[1:4, 1:4].all())


class MbtilesValidationTests(unittest.TestCase):
    def test_expected_layers_and_zooms_validate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "viewsheds.mbtiles"
            metadata = {
                "vector_layers": [
                    {"id": viewsheds.INDIVIDUAL_LAYER},
                    {"id": viewsheds.COVERAGE_LAYER},
                ]
            }
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
                connection.executemany(
                    "INSERT INTO metadata VALUES (?, ?)",
                    [
                        ("json", json.dumps(metadata)),
                        ("minzoom", str(viewsheds.MAPBOX_MIN_ZOOM)),
                        ("maxzoom", str(viewsheds.MAPBOX_MAX_ZOOM)),
                    ],
                )
                connection.commit()

            viewsheds.validate_mbtiles(path)


class ManifestTests(unittest.TestCase):
    def test_web_processing_records_smoothing_and_clipping(self):
        config = {
            "config_hash": "config",
            "web_resolution_m": 50,
            "simplify_tolerance_m": 25,
            "smooth_iterations": 1,
            "web_majority_filter": True,
            "min_web_patch_cells": 0,
            "web_clip": True,
            "web_clip_boundary_sha256": "boundary",
        }
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = viewsheds.write_manifest(
                [],
                Path(directory),
                config,
                None,
                None,
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertTrue(manifest["web_processing"]["majority_filter"])
        self.assertEqual(manifest["web_processing"]["smooth_iterations"], 1)
        self.assertTrue(manifest["web_processing"]["clip"]["enabled"])
        self.assertEqual(
            manifest["web_processing"]["clip"]["boundary_sha256"],
            "boundary",
        )


if __name__ == "__main__":
    unittest.main()
