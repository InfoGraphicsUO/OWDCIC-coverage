import importlib.util
import math
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "build-county-coverage.py"
SPEC = importlib.util.spec_from_file_location("build_county_coverage", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def county_feature(properties=None):
    return {
        "type": "Feature",
        "properties": properties or {},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
    }


class CountyCoverageTests(unittest.TestCase):
    def test_committed_counties_have_coverage_metrics(self):
        data = MODULE.load_geojson(MODULE.DEFAULT_COUNTIES)
        MODULE.validate_coverage(data)
        self.assertEqual(len(data["features"]), 75)
        self.assertEqual(data["coverageMetadata"]["areaCrs"], "EPSG:5070")

    def test_metrics_use_dissolved_area_once(self):
        self.assertEqual(
            MODULE.coverage_metrics(2_000_000, 501_000),
            {
                "countyAreaSqKm": 2.0,
                "cameraViewshedAreaSqKm": 0.501,
                "cameraViewshedCoveragePct": 25.05,
            },
        )

    def test_metrics_clamp_tiny_coverage_overshoot(self):
        self.assertEqual(
            MODULE.coverage_metrics(1_000_000, 1_000_000.001),
            {
                "countyAreaSqKm": 1.0,
                "cameraViewshedAreaSqKm": 1.0,
                "cameraViewshedCoveragePct": 100.0,
            },
        )

    def test_metrics_reject_invalid_areas(self):
        for county_area, covered_area in (
            (0, 0),
            (1, -1),
            (math.inf, 1),
            (1, math.nan),
        ):
            with self.subTest(county_area=county_area, covered_area=covered_area):
                with self.assertRaises(ValueError):
                    MODULE.coverage_metrics(county_area, covered_area)

    def test_validation_requires_every_coverage_field(self):
        data = {
            "type": "FeatureCollection",
            "features": [county_feature({"countyAreaSqKm": 10})],
        }
        with self.assertRaisesRegex(ValueError, "incomplete"):
            MODULE.validate_coverage(data)

    def test_validation_accepts_zero_and_full_coverage(self):
        data = {
            "type": "FeatureCollection",
            "features": [
                county_feature(
                    {
                        "countyAreaSqKm": 10,
                        "cameraViewshedAreaSqKm": 0,
                        "cameraViewshedCoveragePct": 0,
                    }
                ),
                county_feature(
                    {
                        "countyAreaSqKm": 20,
                        "cameraViewshedAreaSqKm": 20,
                        "cameraViewshedCoveragePct": 100,
                    }
                ),
            ],
        }
        MODULE.validate_coverage(data)

    def test_validation_rejects_out_of_range_values(self):
        data = {
            "type": "FeatureCollection",
            "features": [
                county_feature(
                    {
                        "countyAreaSqKm": 10,
                        "cameraViewshedAreaSqKm": 11,
                        "cameraViewshedCoveragePct": 101,
                    }
                )
            ],
        }
        with self.assertRaisesRegex(ValueError, "outside the valid range"):
            MODULE.validate_coverage(data)


if __name__ == "__main__":
    unittest.main()
