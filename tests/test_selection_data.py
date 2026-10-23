"""validates the shipped map selection products as a set"""
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
KINDS = ('state', 'county', 'house', 'us-house', 'senate', 'utility',
         'national-forest', 'national-park', 'federal-land', 'tribal-land',
         'odf-protection-district')


EXPECTED_COUNTS = {
    'state': 2, 'county': 75, 'house': 109, 'us-house': 16, 'senate': 79,
    'utility': 3, 'national-forest': 26, 'national-park': 14,
    'federal-land': 8, 'tribal-land': 66, 'odf-protection-district': 13,
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

    def test_all_odf_districts_combines_every_district(self):
        data = json.loads((ROOT / 'data/divisions/odf-protection-district.geojson').read_text())
        combined = [f for f in data['features'] if 'memberDivisionIds' in f['properties']]
        self.assertEqual([f['properties']['name'] for f in combined], ['All ODF districts'])
        members = [f for f in data['features'] if f not in combined]
        self.assertEqual(combined[0]['properties']['memberDivisionIds'], [f['id'] for f in members])

        # districts do not overlap, so the union measures the same land as their sum
        for key in ('landAreaSqKm', 'cameraViewshedAreaSqKm'):
            self.assertAlmostEqual(combined[0]['properties'][key],
                                   sum(f['properties'][key] for f in members), delta=0.1)

    def test_all_national_forests_combines_every_forest(self):
        data = json.loads((ROOT / 'data/divisions/national-forest.geojson').read_text())
        combined = [f for f in data['features'] if 'memberDivisionIds' in f['properties']]
        self.assertEqual([f['properties']['name'] for f in combined],
                         ['All National Forests', 'Oregon National Forests', 'Washington National Forests'])
        members = [f for f in data['features']
                   if f not in combined and 'partOfDivisionId' not in f['properties']]
        self.assertEqual(sorted(combined[0]['properties']['memberDivisionIds']),
                         sorted(f['id'] for f in members))

        # forest boundaries barely overlap, so the union is close to their sum
        for key in ('landAreaSqKm', 'cameraViewshedAreaSqKm'):
            total = sum(f['properties'][key] for f in members)
            self.assertLessEqual(combined[0]['properties'][key], total)
            self.assertGreater(combined[0]['properties'][key], total * 0.99)

    def test_state_national_forests_split_forests_at_the_state_line(self):
        data = json.loads((ROOT / 'data/divisions/national-forest.geojson').read_text())
        features = {f['id']: f['properties'] for f in data['features']}
        everything, oregon, washington = (features[f'national-forest:{key}'] for key in ('all', 'or', 'wa'))
        portions = [p for p in features.values() if 'partOfDivisionId' in p]

        # only forests that cross the line are split, and each split forest has one portion per state
        self.assertEqual(sorted(p['name'] for p in portions), [
            'Columbia River Gorge National Scenic Area (Oregon portion)',
            'Columbia River Gorge National Scenic Area (Washington portion)',
            'Umatilla National Forest (Oregon portion)',
            'Umatilla National Forest (Washington portion)',
        ])
        split = {p['partOfDivisionId'] for p in portions}
        for state in (oregon, washington):
            members = [features[i] for i in state['memberDivisionIds']]
            self.assertFalse(split & set(state['memberDivisionIds']), 'a split forest joins a state as its portion')
            self.assertTrue(all(m.get('partOfDivisionId') is None or m['state'] == state['state'] for m in members))

        # no forest land counts toward both states, so the states add up to all forests
        for key in ('landAreaSqKm', 'cameraViewshedAreaSqKm'):
            self.assertAlmostEqual(oregon[key] + washington[key], everything[key], delta=everything[key] * 0.005)

    def test_national_forest_is_clipped_to_the_project_boundary(self):
        data = json.loads((ROOT / 'data/divisions/national-forest.geojson').read_text())
        names = {feature['properties']['name'] for feature in data['features']}
        self.assertIn('Malheur National Forest', names)
        self.assertIn('Gifford Pinchot National Forest', names)
        # units with next to nothing inside OR/WA are dropped, not kept as slivers
        outside = {row['name'] for row in data['metadata']['excludedOutsideBoundaryFeatures']}

        for name in ('Nez Perce-Clearwater National Forest', 'Humboldt-Toiyabe National Forest',
                     'Payette National Forest', 'Six Rivers National Forest', 'Modoc National Forest'):
            self.assertIn(name, outside)
            self.assertNotIn(name, names)

        # what is kept lies inside the project boundary
        west, south, east, north = -124.85, 41.99, -116.46, 49.01

        for feature in data['features']:
            minx, miny, maxx, maxy = feature['bbox']
            self.assertGreaterEqual(minx, west)
            self.assertGreaterEqual(miny, south)
            self.assertLessEqual(maxx, east)
            self.assertLessEqual(maxy, north)

    def test_tribal_land_keeps_hoh_reservation(self):
        data = json.loads((ROOT / 'data/divisions/tribal-land.geojson').read_text())
        names = {feature['properties']['name'] for feature in data['features']}
        self.assertIn('Hoh Indian Reservation', names)
        self.assertEqual(len(data['features']), 66)

    def test_cameras_are_not_reported_as_zero_when_viewshed_is_missing(self):
        data = json.loads((ROOT / 'data/camera-coverage.json').read_text())
        # 88 ALERTWest + 108 Pano AI + 87 EnviroVision viewsheds; none is currently missing coverage
        self.assertEqual(len(data['viewsheds']), 283)
        self.assertEqual(data['metadata']['areaCrs'], 'EPSG:5070')
        self.assertEqual(data['metadata']['denominator'], 'individual viewshed land footprint')
        available = [key for key, result in data['viewsheds'].items() if result['coverageAvailable']]
        unavailable = [key for key, result in data['viewsheds'].items() if not result['coverageAvailable']]
        self.assertEqual(len(available), 283)
        self.assertEqual(sum(key.startswith('pano-') for key in available), 108)
        self.assertEqual(len(unavailable), 0)

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

    def test_map_copies_match_the_full_divisions(self):
        # scripts/data-builders/build-map-divisions.py must rerun after any division or metrics build
        options = json.loads((ROOT / 'data/map-divisions/options.json').read_text())
        for kind in KINDS:
            with self.subTest(kind=kind):
                full = json.loads((ROOT / f'data/divisions/{kind}.geojson').read_text())['features']
                copy = json.loads((ROOT / f'data/map-divisions/{kind}.geojson').read_text())['features']
                self.assertEqual([(f['id'], f['properties']) for f in copy],
                                 [(f['id'], f['properties']) for f in full])
                self.assertEqual([entry['divisionId'] for entry in options[kind]],
                                 [f['properties']['divisionId'] for f in full])


if __name__ == '__main__':
    unittest.main()
