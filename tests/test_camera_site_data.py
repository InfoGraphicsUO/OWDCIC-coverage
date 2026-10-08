"""Checks the supplemented source data and the GDAL handoff contract."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))


def read(name):
    return json.loads((ROOT / 'data' / name).read_text())


class CameraSiteDataTests(unittest.TestCase):
    def test_digitized_priority_and_unique_provider_points(self):
        digitized = {f['properties']['id']: f['geometry'] for f in read('digitized-camera-sources.geojson')['features']}
        for provider, count in [('alertwest', 86), ('pano', 34)]:
            features = read(f'{provider}-sites.geojson')['features']
            self.assertEqual(len(features), count)
            self.assertEqual(len({tuple(f['geometry']['coordinates']) for f in features}), count)
            for f in features:
                if f['properties'].get('digitizedId'):
                    self.assertEqual(f['geometry'], digitized[f['properties']['digitizedId']])

    def test_existing_models_preserved(self):
        for provider in ['alertwest', 'pano']:
            sites = {f['properties']['name']: f for f in read(f'{provider}-sites.geojson')['features']}
            for entry in read(f'{provider}-viewshed-manifest.json')['viewsheds']:
                f = sites[entry['site_name']]
                self.assertEqual(f['geometry']['coordinates'], [entry['longitude'], entry['latitude']])
                if entry['status'] == 'complete':
                    self.assertEqual(f['properties']['cameraHeightFt'], entry['height_ft'])

    def test_new_models_published_and_queue_cleared(self):
        entries = {e['site_name']: e for e in read('alertwest-viewshed-manifest.json')['viewsheds']}
        for name, height in [('Phoenix Water Tank', 25), ('Mt Defiance', 95), ('Halfway', 56.75), ('Jim Creek Butte', 32.8),
                             ('Satus', 32.8), ('Elephant', 10), ('Two Rivers', 130), ('Round Mountain Chelan', 80)]:
            self.assertEqual((entries[name]['status'], entries[name]['height_ft']), ('complete', height))
        for provider in ['alertwest', 'pano']:
            self.assertEqual(read(f'{provider}-sites-needing-viewsheds.geojson')['features'], [])
        blocked = {r['name'] for r in read('camera-viewsheds-blocked.json')}
        self.assertTrue({'Natapoc Ridge', 'Natapoc Ridge North', 'Gold Hill'} <= blocked)
        self.assertNotIn('Phoenix Water Tank', blocked)


if __name__ == '__main__':
    unittest.main()
