"""Checks the data release's shapefile schema and README text without GDAL."""
import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("build_data_release", SCRIPTS / "build-data-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class DataReleaseTests(unittest.TestCase):
    def test_every_field_fits_a_shapefile_and_is_documented(self):
        for fields in (release.VIEWSHED_FIELDS, release.CAMERA_FIELDS, release.COVERAGE_FIELDS):
            for name in fields:
                with self.subTest(field=name):
                    self.assertLessEqual(len(name), 10)
                    self.assertIn(name, release.FIELD_NOTES)

    def test_bundles_cover_each_provider_and_state(self):
        self.assertEqual(set(release.PROVIDER_LABELS), set(release.viewsheds.PROVIDER_OUTPUTS))
        self.assertEqual([state for _, _, state in release.BUNDLES], ["OR", "WA", None])

    def test_readme_lists_files_cameras_and_scope(self):
        manifest = {
            "generated_utc": "2026-10-12T21:20:48+00:00",
            "web_processing": {"resolution_m": 50.0, "simplify_tolerance_m": 25.0, "smooth_iterations": 3},
        }
        summary = {
            "files": [
                ["pano_viewsheds.shp", 2, "polygon", "EPSG:5070"],
                ["all_camera_coverage.shp", 1, "polygon", "EPSG:5070"],
                ["camera_locations.shp", 3, "point", "EPSG:4326"],
                ["README.txt", "", "", ""],
            ],
            "omitted": ["envirovision_viewsheds.shp"],
            "cameras": [
                ["pano", 3, 2, 1, "2026-10-12"],
                ["envirovision", 0, 0, 0, "2026-10-12"],
            ],
            "coverage_sqkm": 1234.56,
            "radius_m": 19312.128,
        }
        text = release.readme_text("data-2026-10-20", "Washington", "WA", summary, {"pano": manifest})
        lines = [" ".join(line.split()) for line in text.splitlines()]

        self.assertIn("release: data-2026-10-20", text)
        self.assertIn("coverage: clipped to the Washington state boundary", text)
        self.assertIn("pano_viewsheds.shp 2 polygon EPSG:5070", lines)
        self.assertIn("omitted: envirovision_viewsheds.shp (0 cameras in Washington)", text)
        self.assertIn("Pano AI 3 2 1 2026-10-12", lines)
        self.assertIn("total 3 2 1", lines)
        self.assertIn("all providers, dissolved: 1,234.6 sq km", text)
        self.assertNotIn("\n\n\n", text)

        combined = release.readme_text(
            "data-2026-10-20", "Oregon and Washington", None, {**summary, "omitted": []}, {"pano": manifest}
        )
        self.assertIn("coverage: not clipped to a state", combined)
        self.assertNotIn("omitted:", combined)


if __name__ == "__main__":
    unittest.main()
