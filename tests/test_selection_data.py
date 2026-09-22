"""Validate the shipped map selection products as a set."""
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
KINDS = ('state', 'county', 'house', 'us-house', 'senate', 'utility',
         'national-forest', 'national-park', 'federal-land', 'tribal-land')


EXPECTED_COUNTS = {
    'state': 2, 'county': 75, 'house': 109, 'us-house': 16, 'senate': 79,
    'utility': 3, 'national-forest': 23, 'national-park': 14,
    'federal-land': 7, 'tribal-land': 66,
}

try:
    from shapely.geometry import shape
except ImportError:
    shape = None


class SelectionDataTests(unittest.TestCase):
    def test_all_categories_have_named_valid_complete_features(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                data = json.loads((ROOT / f'data/divisions/{kind}.geojson').read_text())
                self.assertTrue(data['features'])
                self.assertEqual(len(data['features']), EXPECTED_COUNTS[kind])
                meta = data['metadata']
                self.assertEqual(meta['schemaVersion'], 1)
                self.assertTrue(meta['source'])
                self.assertTrue(meta['sourceSha256'])
                self.assertTrue(meta.get('vintage'))
                self.assertEqual(meta['metricsStatus'], 'complete')
                self.assertEqual(
                    meta['landFootprint'],
                    'regional coastal mask minus Census areal hydrography',
                )
                self.assertEqual(meta['hydroVintage'], '2025-01-01')
                self.assertEqual(meta['areaCrs'], 'EPSG:5070')
                hashes = meta['inputSha256']
                self.assertTrue(hashes['coastalMaskSha256'])
                self.assertTrue(hashes['hydroSha256'])
                self.assertTrue(hashes['viewshedsSha256'])
                self.assertTrue(hashes['padusFeeSha256'])
                self.assertIn('mapped fee parcels', meta['designationNote'])
                ids = set()
                for feature in data['features']:
                    props = feature['properties']
                    self.assertEqual(feature['id'], props['divisionId'])
                    self.assertTrue(feature['id'].startswith(kind + ':'))
                    self.assertNotIn(feature['id'], ids)
                    ids.add(feature['id'])
                    self.assertTrue(props['name'])
                    self.assertIn(feature['geometry']['type'], ('Polygon', 'MultiPolygon'))
                    west, south, east, north = feature['bbox']
                    self.assertLess(west, east)
                    self.assertLess(south, north)
                    area = props['landAreaSqKm']
                    covered = props['cameraViewshedAreaSqKm']
                    percent = props['cameraViewshedCoveragePct']
                    self.assertTrue(all(math.isfinite(v) for v in (area, covered, percent)))
                    self.assertGreater(area, 0)
                    self.assertGreaterEqual(covered, 0)
                    self.assertLessEqual(covered, area + 0.001)
                    self.assertGreaterEqual(percent, 0)
                    self.assertLessEqual(percent, 100)
                    shares = props['landMix']
                    self.assertEqual(shares[-1]['label'], 'Other/unclassified')
                    self.assertAlmostEqual(sum(row['percentage'] for row in shares), 100, places=1)

    def test_expected_oregon_washington_options(self):
        state = json.loads((ROOT / 'data/divisions/state.geojson').read_text())
        self.assertEqual({f['properties']['name'] for f in state['features']},
                         {'Oregon', 'Washington'})
        categories = set(state['metadata']['designationPriority'])
        self.assertTrue({'State land', 'Local government land',
                         'Nonprofit open space', 'Mapped private open space',
                         'National Park Service land', 'U.S. Forest Service land'
                         } <= categories)
        self.assertNotIn('National Forest', categories)
        self.assertNotIn('National Park', categories)
        utility = json.loads((ROOT / 'data/divisions/utility.geojson').read_text())
        names = {f['properties']['name'] for f in utility['features']}
        self.assertTrue(any('Portland General Electric' in name for name in names))
        self.assertTrue(any('Pacific Power' in name for name in names))
        self.assertTrue(any('Eugene Water' in name for name in names))
        for feature in utility['features']:
            self.assertIn('Approximate', feature['properties']['boundaryQualifier'])
        meta = utility['metadata']
        self.assertIn('Oregon', meta['coverageNote'])
        self.assertIn('Washington', meta['coverageNote'])
        self.assertNotIn('exact', meta['coverageNote'].lower())

    def test_national_forest_drops_idaho_only_unit(self):
        data = json.loads((ROOT / 'data/divisions/national-forest.geojson').read_text())
        names = {feature['properties']['name'] for feature in data['features']}
        self.assertNotIn('Nez Perce-Clearwater National Forest', names)
        self.assertIn('Malheur National Forest', names)
        self.assertIn('Gifford Pinchot National Forest', names)
        excluded = data['metadata'].get('excludedEmptyLandFeatures') or []
        self.assertTrue(any('Nez Perce-Clearwater' in str(row) for row in excluded))

    def test_tribal_land_keeps_hoh_reservation(self):
        data = json.loads((ROOT / 'data/divisions/tribal-land.geojson').read_text())
        names = {feature['properties']['name'] for feature in data['features']}
        self.assertIn('Hoh Indian Reservation', names)
        self.assertEqual(len(data['features']), 66)

    def test_cameras_are_not_reported_as_zero_when_viewshed_is_missing(self):
        data = json.loads((ROOT / 'data/camera-coverage.json').read_text())
        self.assertEqual(len(data['viewsheds']), 75)
        self.assertEqual(data['metadata']['areaCrs'], 'EPSG:5070')
        self.assertEqual(data['metadata']['denominator'], 'individual viewshed land footprint')
        available = [key for key, result in data['viewsheds'].items() if result['coverageAvailable']]
        unavailable = [key for key, result in data['viewsheds'].items() if not result['coverageAvailable']]
        self.assertEqual(len(available), 74)
        self.assertEqual(len(unavailable), 1)
        for result in data['viewsheds'].values():
            if result['coverageAvailable']:
                self.assertGreaterEqual(result['landAreaSqKm'], 0)
                self.assertNotEqual(result.get('coverageMessage'), 'Coverage unavailable')
                self.assertAlmostEqual(sum(x['percentage'] for x in result['landMix']), 100, places=1)
            else:
                self.assertIsNone(result['landAreaSqKm'])
                self.assertEqual(result['landMix'], [])
                self.assertEqual(result['coverageMessage'], 'Coverage unavailable')
                self.assertNotEqual(result.get('cameraViewshedCoveragePct'), 0)

    @unittest.skipIf(shape is None, 'QGIS Shapely runtime not available')
    def test_written_polygons_are_valid(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                data = json.loads((ROOT / f'data/divisions/{kind}.geojson').read_text())
                for feature in data['features']:
                    geometry = shape(feature['geometry'])
                    self.assertIn(geometry.geom_type, ('Polygon', 'MultiPolygon'))
                    self.assertTrue(geometry.is_valid, feature['id'])
                    self.assertFalse(geometry.is_empty)
                    self.assertGreater(geometry.area, 0)


if __name__ == '__main__':
    unittest.main()
