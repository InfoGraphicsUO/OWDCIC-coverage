"""Small geometry cases for the land coverage and designation contract."""
import importlib.util
import json
import tempfile
from pathlib import Path
import unittest

try:
    from shapely.geometry import box, mapping
    from shapely import union_all
except ImportError:
    box = union_all = None


@unittest.skipIf(box is None, 'QGIS Shapely runtime not available')
class SelectionMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'scripts/build-selection-metrics.py'
        spec = importlib.util.spec_from_file_location('selection_metrics', path)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_zero_partial_full_and_overlapping_viewsheds(self):
        selected = box(0, 0, 1000, 1000)
        cases = [
            (box(2000, 2000, 3000, 3000), 0),
            (box(0, 0, 500, 1000), 50),
            (box(0, 0, 1000, 1000), 100),
            (union_all([box(0, 0, 750, 1000), box(250, 0, 1000, 1000)]), 100),
        ]
        for coverage, expected in cases:
            with self.subTest(expected=expected):
                got = self.module.coverage_metrics(selected, coverage)
                self.assertEqual(got['cameraViewshedCoveragePct'], expected)
                self.assertAlmostEqual(got['cameraViewshedAreaSqKm'], expected / 100)

    def test_designation_priority_and_remainder_sum_to_100(self):
        selected = box(0, 0, 1000, 1000)
        designations = [
            ('Tribal land', box(0, 0, 500, 1000)),
            ('National Forest', box(250, 0, 750, 1000)),
        ]
        result = self.module.mix_for(selected, selected.area, designations)
        shares = {row['label']: row['percentage'] for row in result}
        self.assertEqual(shares['Tribal land'], 50)
        self.assertEqual(shares['National Forest'], 25)
        self.assertEqual(shares['Other/unclassified'], 25)
        self.assertAlmostEqual(sum(shares.values()), 100)

    def test_positive_area_does_not_round_to_zero_sqkm(self):
        self.assertEqual(self.module.area_sqkm(400), 0.001)
        self.assertEqual(self.module.area_sqkm(1_500_000), 1.5)
        self.assertEqual(self.module.area_sqkm(0), 0.0)

    def test_padus_fee_uses_owner_type_and_keeps_unmapped_land_unknown(self):
        features = [
            ('STAT', box(0, 0, 1000, 1000)),
            ('LOC', box(1000, 0, 2000, 1000)),
            ('DIST', box(2000, 0, 3000, 1000)),
            ('PVT', box(3000, 0, 4000, 1000)),
            ('FED', box(4000, 0, 5000, 1000)),
        ]
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.geojsonl') as cache:
            for owner_type, geometry in features:
                cache.write(json.dumps({
                    'type': 'Feature',
                    'properties': {'Own_Type': owner_type},
                    'geometry': mapping(geometry),
                }) + '\n')
            cache.flush()
            categories = dict(self.module.load_padus_fee_categories(Path(cache.name)))
        selected = box(0, 0, 6000, 1000)
        self.assertEqual(categories['State land'].intersection(selected).area, 1_000_000)
        self.assertEqual(categories['Local government land'].intersection(selected).area, 2_000_000)
        self.assertEqual(categories['Mapped private open space'].intersection(selected).area, 1_000_000)
        self.assertEqual(categories['Other federal land'].intersection(selected).area, 1_000_000)
        mix = self.module.mix_for(
            box(0, 0, 6000, 1000), 6_000_000,
            list(categories.items()))
        self.assertEqual(mix[-1]['label'], 'Other/unclassified')
        self.assertAlmostEqual(mix[-1]['percentage'], 100 / 6, places=1)

    def test_federal_chart_excludes_proclamation_manager_groups(self):
        geometry = mapping(box(-124, 42, -123.9, 42.1))
        features = [
            {'properties': {'name': name}, 'geometry': geometry}
            for name in ('National Park Service', 'U.S. Forest Service',
                         'Bureau of Land Management', 'U.S. Department of Defense',
                         'Other federal fee manager')
        ]
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.geojson') as source:
            source.write(json.dumps({'features': features}))
            source.flush()
            categories = dict(self.module.load_federal_categories(
                Path(source.name), box(-5_000_000, 0, 5_000_000, 5_000_000)))
        self.assertGreater(categories['National Park Service land'].area, 0)
        self.assertGreater(categories['U.S. Forest Service land'].area, 0)
        self.assertEqual(categories['Other federal land'].area,
                         categories['National Park Service land'].area)

    def test_hydro_cache_rejects_empty_input(self):
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.geojsonl') as cache:
            cache.write('\n')
            cache.flush()
            with self.assertRaisesRegex(ValueError, 'hydro cache is empty'):
                self.module.load_hydro(__import__('pathlib').Path(cache.name))


if __name__ == '__main__':
    unittest.main()
