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
    return SimpleNamespace(**values), [dem]


class ConfigurationTests(unittest.TestCase):
    def test_web_settings_change_only_web_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            args, dems = make_args(Path(directory))
            first = viewsheds.config_document(args, dems)
            args.web_resolution = 100.0
            second = viewsheds.config_document(args, dems)

        self.assertEqual(first["analysis_hash"], second["analysis_hash"])
        self.assertNotEqual(first["web_hash"], second["web_hash"])
        self.assertNotEqual(first["config_hash"], second["config_hash"])

    def test_dem_change_invalidates_analysis_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            args, dems = make_args(Path(directory))
            first = viewsheds.config_document(args, dems)
            dems[0].write_bytes(b"dem with more bytes")
            second = viewsheds.config_document(args, dems)

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
    def test_checked_in_boundary_is_one_regional_land_feature(self):
        boundary_path = SCRIPTS.parent / "data/pacific-northwest-land-mask.geojson"
        boundary = json.loads(boundary_path.read_text(encoding="utf-8"))

        self.assertEqual(boundary["type"], "FeatureCollection")
        self.assertEqual(len(boundary["features"]), 1)
        feature = boundary["features"][0]
        self.assertEqual(feature["properties"]["region"], "PNW-LAND")
        self.assertEqual(feature["properties"]["clip"], "coastline")
        self.assertEqual(
            feature["properties"]["bounds"],
            [-127.5, 40.0, -114.0, 51.0],
        )
        self.assertEqual(feature["geometry"]["type"], "MultiPolygon")


@unittest.skipIf(viewsheds.ogr is None, "QGIS OGR runtime not available")
class GeometryRepairTests(unittest.TestCase):
    def test_self_intersecting_polygon_is_repaired(self):
        ring = viewsheds.ogr.Geometry(viewsheds.ogr.wkbLinearRing)
        for x, y in ((0, 0), (2, 2), (0, 2), (2, 0), (0, 0)):
            ring.AddPoint_2D(x, y)
        polygon = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPolygon)
        polygon.AddGeometry(ring)

        repaired = viewsheds.repair_polygon_parts(polygon)

        self.assertFalse(repaired.IsEmpty())
        self.assertTrue(repaired.IsValid())

    def test_overlapping_members_are_repaired_as_a_collection(self):
        def square(x0, y0, x1, y1):
            ring = viewsheds.ogr.Geometry(viewsheds.ogr.wkbLinearRing)
            for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)):
                ring.AddPoint_2D(x, y)
            polygon = viewsheds.ogr.Geometry(viewsheds.ogr.wkbPolygon)
            polygon.AddGeometry(ring)
            return polygon

        collection = viewsheds.ogr.Geometry(viewsheds.ogr.wkbMultiPolygon)
        collection.AddGeometry(square(0, 0, 2, 2))
        collection.AddGeometry(square(1, 1, 3, 3))

        repaired = viewsheds.repair_polygon_parts(collection)

        self.assertFalse(repaired.IsEmpty())
        self.assertTrue(repaired.IsValid())


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
class DatasetMergeTests(unittest.TestCase):
    SITE = {
        "source_id": 1,
        "viewshed_id": "old-camera",
        "name": "Old Camera",
        "longitude": -122.0,
        "latitude": 45.0,
        "height_ft": 30.0,
        "aliases": [],
    }

    def save_state(self, root: Path, site: dict, analysis_hash: str, web_hash: str) -> Path:
        outputs = {}
        for key, suffix in (("raster", "tif"), ("exact", "gpkg"), ("web", "geojson")):
            path = root / f"{site['viewshed_id']}.{suffix}"
            path.touch()
            outputs[key] = str(path)
        state = {
            "status": "complete",
            "analysis_hash": analysis_hash,
            "web_hash": web_hash,
            "site": site,
            "outputs": outputs,
        }
        path = root / "state" / f"{site['viewshed_id']}.json"
        viewsheds.write_json(path, state)
        return path

    def test_other_cameras_do_not_change_a_camera_hash(self):
        moved = {**self.SITE, "height_ft": 40.0}
        renamed = {**self.SITE, "source_id": 9, "name": "Renamed", "aliases": ["Old Camera"]}
        self.assertEqual(
            viewsheds.site_hashes("analysis", "web", self.SITE),
            viewsheds.site_hashes("analysis", "web", renamed),
        )
        self.assertNotEqual(
            viewsheds.site_hashes("analysis", "web", self.SITE)[0],
            viewsheds.site_hashes("analysis", "web", moved)[0],
        )

    def test_legacy_state_survives_a_changed_sites_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, dems = make_args(root)
            config = viewsheds.config_document(args, dems)
            legacy_analysis = viewsheds.payload_hash(
                {"sites_sha256": "old-sites", **viewsheds.analysis_config_payload(args, dems)}
            )
            legacy_web = viewsheds.payload_hash(
                {"analysis_hash": legacy_analysis, **viewsheds.web_config_payload(args)}
            )
            path = self.save_state(root, self.SITE, legacy_analysis, legacy_web)
            other = self.save_state(root, {**self.SITE, "viewshed_id": "other"}, "other-settings", "web")

            self.assertEqual(viewsheds.current_states(root, config), ([], ["Old Camera", "Old Camera"]))
            self.assertEqual(viewsheds.upgrade_legacy_states(root, "old-sites", args, dems, config), 1)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(
                (state["analysis_hash"], state["web_hash"]),
                viewsheds.site_hashes(config["analysis_hash"], config["web_hash"], self.SITE),
            )
            self.assertEqual(json.loads(other.read_text(encoding="utf-8"))["analysis_hash"], "other-settings")
            self.assertEqual(viewsheds.reusable_stages(state, state["analysis_hash"], state["web_hash"], True), (True, True, True))

    def test_dataset_holds_every_current_camera_in_site_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, dems = make_args(root)
            config = viewsheds.config_document(args, dems)
            new = {**self.SITE, "source_id": 2, "viewshed_id": "new-camera", "name": "New Camera", "latitude": 46.0}
            stale = {**self.SITE, "source_id": 3, "viewshed_id": "stale-camera", "name": "Stale Camera"}
            for site in (new, self.SITE):
                self.save_state(root, site, *viewsheds.site_hashes(config["analysis_hash"], config["web_hash"], site))
            self.save_state(root, stale, "other-settings", "web")

            states, left_out = viewsheds.current_states(root, config)

        self.assertEqual([state["site"]["name"] for state in states], ["Old Camera", "New Camera"])
        self.assertEqual(left_out, ["Stale Camera"])


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
                "pano-camera-viewsheds",
                config,
                None,
                None,
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        # manifests are named after their provider like the Mapbox uploads
        self.assertEqual(manifest_path.name, "pano-viewshed-manifest.json")

        self.assertTrue(manifest["web_processing"]["majority_filter"])
        self.assertEqual(manifest["web_processing"]["smooth_iterations"], 1)
        self.assertTrue(manifest["web_processing"]["clip"]["enabled"])
        self.assertEqual(
            manifest["web_processing"]["clip"]["boundary_sha256"],
            "boundary",
        )


class CombinedCoverageTests(unittest.TestCase):
    def test_run_output_replaces_its_own_provider(self):
        output = Path("outputs/alertwest-elsewhere")
        providers = viewsheds.combined_providers("alertwest-camera-viewsheds", output)
        self.assertEqual(
            providers,
            [output / viewsheds.WEB_PACKAGE, viewsheds.PROVIDER_OUTPUTS["pano"] / viewsheds.WEB_PACKAGE],
        )

    def test_unknown_provider_is_added(self):
        providers = viewsheds.combined_providers("other-camera-viewsheds", Path("outputs/other"))
        self.assertEqual(len(providers), len(viewsheds.PROVIDER_OUTPUTS) + 1)


class PublishTests(unittest.TestCase):
    def write_manifest(self, directory: Path, *viewshed_ids: str) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "pano-viewshed-manifest.json"
        entries = [{"viewshed_id": viewshed_id, "status": "complete"} for viewshed_id in viewshed_ids]
        path.write_text(json.dumps({"viewsheds": entries}), encoding="utf-8")
        return path

    def test_manifest_replaces_the_published_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            self.write_manifest(data, "pano-a")
            manifest = self.write_manifest(Path(directory) / "output", "pano-a", "pano-b")
            published = viewsheds.publish_manifest(manifest, data)
            self.assertEqual(published.read_bytes(), manifest.read_bytes())

    def test_first_manifest_for_a_provider_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            data.mkdir()
            manifest = self.write_manifest(Path(directory) / "output", "pano-a")
            self.assertTrue(viewsheds.publish_manifest(manifest, data).is_file())

    def test_partial_output_folder_cannot_unpublish_viewsheds(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            published = self.write_manifest(data, "pano-a", "pano-b")
            before = published.read_bytes()
            manifest = self.write_manifest(Path(directory) / "output", "pano-a")
            with self.assertRaisesRegex(RuntimeError, "pano-b"):
                viewsheds.publish_manifest(manifest, data)
            self.assertEqual(published.read_bytes(), before)

    def test_script_output_reaches_the_log_and_failures_raise(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "step.py"
            script.write_text("import sys\nprint('built', sys.argv[1])\nsys.exit(int(sys.argv[1]))\n")
            lines = []
            viewsheds.run_script(script, ["0"], lines.append)
            self.assertEqual(lines, ["step.py: built 0"])
            with self.assertRaisesRegex(RuntimeError, r"step\.py failed \(3\)"):
                viewsheds.run_script(script, ["3"], lines.append)

    def test_metrics_need_published_site_data(self):
        with self.assertRaises(SystemExit):
            viewsheds.parse_args(["--publish-metrics"])
        with self.assertRaises(SystemExit):
            viewsheds.parse_args(["--publish-site-data", "--shapefiles-only"])
        args = viewsheds.parse_args(["--publish-site-data", "--publish-metrics"])
        self.assertTrue(args.publish_site_data and args.publish_metrics)


class ProgressTests(unittest.TestCase):
    def emitter(self, count=2):
        sites = [SimpleNamespace(name=f"camera {index}") for index in range(count)]
        return viewsheds.ProgressEmitter(False, sites)

    def test_cameras_fill_the_bar_without_finishing_steps(self):
        emitter = self.emitter()
        emitter.progress(1, "complete", 1.0, None)
        emitter.progress(2, "complete", 1.0, None)
        self.assertEqual(emitter.percent(), 100.0)

    def test_finishing_steps_hold_back_the_end_of_the_bar(self):
        emitter = self.emitter()
        emitter.plan_finishing(["web_polygons", "web_coverage"])
        emitter.progress(1, "complete", 1.0, None)
        self.assertAlmostEqual(emitter.percent(), 40.0)
        emitter.progress(2, "complete", 1.0, None)
        self.assertAlmostEqual(emitter.percent(), 80.0)
        emitter.finishing_stage("web_polygons", "")
        self.assertAlmostEqual(emitter.percent(), 80.0)
        emitter.finishing_stage("web_coverage", "")
        self.assertAlmostEqual(emitter.percent(), 90.0)

    def test_finishing_steps_advance_past_failed_cameras(self):
        emitter = self.emitter()
        emitter.plan_finishing(["web_polygons"])
        emitter.progress(1, "dem", 0.2, None)
        emitter.finishing_stage("web_polygons", "")
        self.assertAlmostEqual(emitter.percent(), 80.0)

    def test_unplanned_finishing_step_leaves_the_bar_alone(self):
        emitter = self.emitter()
        emitter.progress(1, "complete", 1.0, None)
        emitter.finishing_stage("mbtiles", "")
        self.assertAlmostEqual(emitter.percent(), 50.0)


class ProductNameTests(unittest.TestCase):
    def test_queue_file_keeps_its_provider(self):
        args = SimpleNamespace(product_name=None, sites=Path("data/alertwest-sites-needing-viewsheds.geojson"))
        self.assertEqual(viewsheds.product_name(args), "alertwest-camera-viewsheds")

    def test_provider_comes_from_sites_file_name(self):
        for sites, expected in (
            ("data/alertwest-sites.geojson", "alertwest-camera-viewsheds"),
            ("data/pano-sites.geojson", "pano-camera-viewsheds"),
            ("data/sites.geojson", "camera-viewsheds"),
        ):
            args = SimpleNamespace(sites=Path(sites), product_name=None)
            self.assertEqual(viewsheds.product_name(args), expected)

    def test_explicit_name_wins(self):
        args = SimpleNamespace(sites=Path("data/pano-sites.geojson"), product_name="Test Run")
        self.assertEqual(viewsheds.product_name(args), "test-run")


if __name__ == "__main__":
    unittest.main()
