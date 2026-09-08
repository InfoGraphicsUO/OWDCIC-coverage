import importlib.util
import json
import math
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse


SCRIPT = Path(__file__).parents[1] / "scripts" / "build-division-data.py"
SPEC = importlib.util.spec_from_file_location("build_division_data", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def ring(x0, y0, x1, y1, clockwise=False):
    points = [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]
    return points if clockwise else list(reversed(points))


def raw_feature(
    geoid="41001",
    state="41",
    name="Baker County",
    geometry=None,
    lon="-117.5",
    lat="44.5",
):
    return {
        "attributes": {
            "GEOID": geoid,
            "STATE": state,
            "NAME": name,
            "INTPTLON": lon,
            "INTPTLAT": lat,
        },
        "geometry": geometry
        or {"rings": [ring(-118, 44, -117, 45, clockwise=True)]},
    }


class DivisionDataTests(unittest.TestCase):
    def test_query_requests_only_county_fields_and_geometry_options(self):
        query = parse_qs(urlparse(MODULE.query_url()).query)
        self.assertEqual(
            query["outFields"], ["GEOID,NAME,STATE,INTPTLAT,INTPTLON"]
        )
        self.assertEqual(query["outSR"], ["4326"])
        self.assertEqual(query["geometryPrecision"], ["5"])
        self.assertEqual(query["maxAllowableOffset"], ["0.0005"])
        self.assertEqual(query["returnGeometry"], ["true"])
        self.assertEqual(query["f"], ["geojson"])

    def test_normalizes_polygon_and_multipolygon(self):
        polygon = raw_feature()
        multi = raw_feature(
            geoid="53001",
            state="53",
            name="Adams County",
            lon="-117.5",
            lat="45.5",
            geometry={
                "type": "MultiPolygon",
                "coordinates": [
                    [ring(-118, 45, -117, 46)],
                    [ring(-116, 45, -115, 46)],
                ],
            },
        )
        data = MODULE.normalize_counties(
            {"features": [multi, polygon]}, expected_count=2
        )

        self.assertEqual(
            [feature["id"] for feature in data["features"]],
            ["county:41001", "county:53001"],
        )
        self.assertEqual(data["features"][0]["geometry"]["type"], "Polygon")
        self.assertEqual(
            data["features"][1]["geometry"]["type"], "MultiPolygon"
        )
        self.assertEqual(
            data["features"][0]["bbox"], [-118.0, 44.0, -117.0, 45.0]
        )
        self.assertEqual(
            data["features"][1]["bbox"], [-118.0, 45.0, -115.0, 46.0]
        )
        self.assertEqual(data["features"][0]["properties"]["shortName"], "Baker")
        self.assertEqual(data["features"][0]["properties"]["label"], "OR • Baker")

    def test_sorts_counties_by_state_and_name(self):
        data = MODULE.normalize_counties(
            {
                "features": [
                    raw_feature(geoid="41003", name="Zed County"),
                    raw_feature(
                        geoid="53001",
                        state="53",
                        name="Adams County",
                        lon="-117.5",
                        lat="44.5",
                    ),
                    raw_feature(geoid="41005", name="Alpha County"),
                ]
            },
            expected_count=3,
        )

        self.assertEqual(
            [feature["properties"]["label"] for feature in data["features"]],
            ["OR • Alpha", "OR • Zed", "WA • Adams"],
        )

    def test_arcgis_multiple_outer_rings_becomes_multipolygon(self):
        feature = MODULE.normalize_counties(
            {
                "features": [
                    raw_feature(
                        geometry={
                            "rings": [
                                ring(0, 0, 1, 1, True),
                                ring(2, 2, 3, 3, True),
                            ]
                        },
                        lon="0.5",
                        lat="0.5",
                    )
                ]
            },
            expected_count=1,
        )["features"][0]

        self.assertEqual(feature["geometry"]["type"], "MultiPolygon")

    def test_fetch_uses_mocked_network(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"features": [raw_feature()]}).encode()

        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            return Response()

        result = MODULE.fetch_counties(opener)

        self.assertEqual(len(result["features"]), 1)
        self.assertEqual(calls[0][1], 60)

    def test_rejects_bad_geometry_type(self):
        with self.assertRaisesRegex(ValueError, "Polygon or MultiPolygon"):
            MODULE.normalize_counties(
                {
                    "features": [
                        raw_feature(
                            geometry={"type": "Point", "coordinates": [0, 0]}
                        )
                    ]
                }
            )

    def test_rejects_duplicate_ids(self):
        first = MODULE.normalize_counties(
            {"features": [raw_feature()]}, expected_count=1
        )["features"][0]
        duplicate = json.loads(json.dumps(first))
        duplicate["properties"]["labelPoint"] = [-117.4, 44.4]

        with self.assertRaisesRegex(ValueError, "not unique"):
            MODULE.validate_counties(
                {
                    "type": "FeatureCollection",
                    "features": [first, duplicate],
                },
                expected_count=2,
            )

    def test_rejects_nonfinite_label_point_and_outside_bbox(self):
        feature = MODULE.normalize_counties(
            {"features": [raw_feature()]}, expected_count=1
        )["features"][0]
        feature["properties"]["labelPoint"] = [math.inf, 44.5]
        with self.assertRaisesRegex(ValueError, "labelPoint"):
            MODULE.validate_counties(
                {"type": "FeatureCollection", "features": [feature]},
                expected_count=1,
            )

    def test_boundary_check_ignores_coverage_build_fields(self):
        feature = MODULE.normalize_counties(
            {"features": [raw_feature()]}, expected_count=1
        )["features"][0]
        feature["properties"].update(
            {
                "countyAreaSqKm": 10,
                "cameraViewshedAreaSqKm": 2,
                "cameraViewshedCoveragePct": 20,
            }
        )
        data = {
            "type": "FeatureCollection",
            "coverageMetadata": {"areaCrs": "EPSG:5070"},
            "features": [feature],
        }

        stripped = MODULE.without_coverage(data)

        self.assertNotIn("coverageMetadata", stripped)
        for field in MODULE.COVERAGE_FIELDS:
            self.assertNotIn(field, feature["properties"])

        feature["properties"]["labelPoint"] = [-116.0, 44.5]
        with self.assertRaisesRegex(ValueError, "outside bbox"):
            MODULE.validate_counties(
                {"type": "FeatureCollection", "features": [feature]},
                expected_count=1,
            )


if __name__ == "__main__":
    unittest.main()
