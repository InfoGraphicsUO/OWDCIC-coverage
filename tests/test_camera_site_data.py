"""checks the supplemented source data and the GDAL handoff contract"""
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
        for provider, count in [('alertwest', 88), ('pano', 106), ('envirovision', 87)]:
            features = read(f'{provider}-sites.geojson')['features']
            self.assertEqual(len(features), count)
            self.assertEqual(len({tuple(f['geometry']['coordinates']) for f in features}), count)
            for f in features:
                if f['properties'].get('digitizedId'):
                    self.assertEqual(f['geometry'], digitized[f['properties']['digitizedId']])

    def test_existing_models_preserved(self):
        for provider in ['alertwest', 'pano', 'envirovision']:
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

        blocked = {r['name'] for r in read('camera-viewsheds-blocked.json')}
        self.assertFalse({'Natapoc Ridge', 'Natapoc Ridge North', 'Anderson'} & blocked)
        self.assertNotIn('Midnight Gulch', blocked)
        self.assertNotIn('Phoenix Water Tank', blocked)

    def test_october_sheet_additions(self):
        pano = {f['properties']['name']: f['properties'] for f in read('pano-sites.geojson')['features']}
        self.assertNotIn('Clearwater Wind Farm', pano)
        self.assertEqual({p.get('owner') for p in pano.values()},
                         {'Portland General Electric', 'Pacific Power', 'Washington DNR', 'Puget Sound Energy', 'Avista Utilities'})
        # WA DNR heights are written with a foot mark in the sheet
        self.assertEqual(pano['Capitol Peak']['cameraHeightFt'], 270)
        self.assertEqual((pano['Mullan Substation']['cameraHeightFt'], pano['Round Butte']['cameraHeightFt']), (64.99, 81.99))
        alertwest = {f['properties']['name']: f['properties'] for f in read('alertwest-sites.geojson')['features']}
        self.assertEqual(alertwest['Monument Mountain']['cameraHeightFt'], 43.33)
        self.assertTrue(alertwest['Gold Hill']['cameraHeightEstimated'])
        # live sites ALERTWest keeps out of its API, so the map draws their markers itself
        self.assertEqual({n for n, p in alertwest.items() if p.get('outsideApi')}, {'Bear Mountain', 'Callahan Ridge'})

        # every site with a height and location is modeled, so nothing waits in the GDAL queue
        for provider in ['alertwest', 'pano']:
            self.assertEqual(read(f'{provider}-sites-needing-viewsheds.geojson')['features'], [])

        modeled = {e['site_name'] for provider in ['alertwest', 'pano']
                   for e in read(f'{provider}-viewshed-manifest.json')['viewsheds'] if e['status'] == 'complete'}
        self.assertTrue({'Gold Hill', 'Dry Mountain', 'Sycan Substation', 'Takilma', 'Midnight Gulch', 'Anderson', 'McDonald Mountain', 'Natapoc Ridge', 'Natapoc Ridge North'} <= modeled)

    def test_avista_stations(self):
        avista = {f['properties']['name']: f for f in read('pano-sites.geojson')['features']
                  if f['properties'].get('owner') == 'Avista Utilities'}
        # Washington stations plus the Idaho ones that see well into Washington
        self.assertEqual(len(avista), 15)
        self.assertFalse({'Gold Mountain', 'St Maries', 'Orofino', 'Clearwater', 'Grangeville',
                          'Gold Cup Mountain', 'Maryanna', 'Sander Grade'} & set(avista))
        self.assertEqual(sum(f['properties']['state'] == 'ID' for f in avista.values()), 2)
        self.assertEqual(avista['Lilienthal Mountain']['properties']['cameraHeightFt'], 199)
        self.assertEqual(avista['Layton Hill']['properties']['viewshedId'], 'pano-layton-hill')
        self.assertEqual(avista['Hoodoo Mountain']['properties']['county'], 'Bonner')
        # Lewiston is missing from Avista's public viewer, so it keeps the front page
        self.assertEqual({n for n, f in avista.items() if 'feed' not in f['properties']}, {'Lewiston'})

    def test_envirovision_sites(self):
        sites = {f['properties']['name']: f for f in read('envirovision-sites.geojson')['features']}
        self.assertEqual(sum(f['properties']['cameraCount'] for f in sites.values()), 125)
        self.assertEqual(len({f['properties']['viewshedId'] for f in sites.values()}), 87)
        # the point geometry wins over ODF's Longitude column, which lacks its minus sign here
        self.assertEqual(sites['Weston']['geometry']['coordinates'], [-118.37586, 45.800075])
        self.assertEqual(sites['Weston']['properties']['aliases'], ['Weston High', 'Weston Low'])
        # a site is modeled from its tallest camera
        self.assertEqual(sites['Little Grayback']['properties']['cameraHeightFt'], 164)
        self.assertEqual(sites['Little Grayback']['properties']['cameraHeightsFt'], [98, 164])
        # 60 ft is ODF's planning default
        self.assertEqual(sum(bool(f['properties'].get('cameraHeightEstimated')) for f in sites.values()), 7)
        self.assertTrue({'Elk Mountain (Bridge)', 'Elk Mountain (Wallowa)'} <= set(sites))
        self.assertEqual(sum(bool(f['properties'].get('sharesAlertWestSite')) for f in sites.values()), 5)
        self.assertEqual(read('envirovision-sites-needing-viewsheds.geojson')['features'], [])
        self.assertEqual({e['status'] for e in read('envirovision-viewshed-manifest.json')['viewsheds']}, {'complete'})


if __name__ == '__main__':
    unittest.main()
