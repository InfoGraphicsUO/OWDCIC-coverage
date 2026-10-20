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

    def test_readme_describes_the_state_scope_and_run_dates(self):
        manifest = {
            "generated_utc": "2026-10-12T21:20:48+00:00",
            "web_processing": {"resolution_m": 50.0, "simplify_tolerance_m": 25.0, "smooth_iterations": 3},
        }
        text = release.readme_text(
            "data-2026-10-20", "Washington", "WA", ["pano_viewsheds.shp: 2 Pano AI camera viewsheds"],
            {"pano": manifest},
        )

        self.assertIn("Release data-2026-10-20", text)
        self.assertIn("coverage\nlayer is clipped to Washington", text)
        self.assertIn("Pano AI: 2026-10-12", text)
        self.assertIn("  pano_viewsheds.shp: 2 Pano AI camera viewsheds", text)

        combined = release.readme_text("data-2026-10-20", "Oregon and Washington", None, [], {"pano": manifest})
        self.assertIn("not clipped", combined)


if __name__ == "__main__":
    unittest.main()
