"""Checks the supplemented source data and the GDAL handoff contract."""
import importlib.util
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

    def test_gdal_can_load_ready_queue(self):
        spec = importlib.util.spec_from_file_location('camera_viewsheds', ROOT / 'scripts/gdal-camera-viewsheds.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        sites = module.load_sites(ROOT / 'data/alertwest-sites-needing-viewsheds.geojson')
        self.assertEqual({s.name for s in sites}, {'Phoenix Water Tank', 'Mt Defiance', 'Halfway', 'Jim Creek Butte', 'Satus', 'Elephant', 'Two Rivers', 'Round Mountain Chelan'})
        phoenix = next(s for s in sites if s.name == 'Phoenix Water Tank')
        self.assertEqual(phoenix.height_ft, 25)
        self.assertEqual(phoenix.height_m, 7.62)
        self.assertTrue(all(s.height_ft > 0 for s in sites))
        self.assertEqual(read('pano-sites-needing-viewsheds.geojson')['features'], [])
        blocked = {r['name'] for r in read('camera-viewsheds-blocked.json')}
        self.assertTrue({'Natapoc Ridge', 'Natapoc Ridge North', 'Gold Hill'} <= blocked)
        self.assertNotIn('Phoenix Water Tank', blocked)


if __name__ == '__main__':
    unittest.main()
