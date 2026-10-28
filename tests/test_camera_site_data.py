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
        digitized = {f['properties']['id']: f['geometry'] for f in read('live/digitized-camera-sources.geojson')['features']}
        for provider, count in [('alertwest', 88), ('pano', 106), ('envirovision', 88)]:
            features = read(f'live/{provider}-sites.geojson')['features']
            self.assertEqual(len(features), count)
            self.assertEqual(len({tuple(f['geometry']['coordinates']) for f in features}), count)
            for f in features:
                if f['properties'].get('digitizedId'):
                    self.assertEqual(f['geometry'], digitized[f['properties']['digitizedId']])

    def test_existing_models_preserved(self):
        for provider in ['alertwest', 'pano', 'envirovision']:
            sites = {f['properties']['name']: f for f in read(f'live/{provider}-sites.geojson')['features']}
            for entry in read(f'live/{provider}-viewshed-manifest.json')['viewsheds']:
                f = sites[entry['site_name']]
                self.assertEqual(f['geometry']['coordinates'], [entry['longitude'], entry['latitude']])
                if entry['status'] == 'complete':
                    self.assertEqual(f['properties']['cameraHeightFt'], entry['height_ft'])

    def test_new_models_published_and_queue_cleared(self):
        entries = {e['site_name']: e for e in read('live/alertwest-viewshed-manifest.json')['viewsheds']}

        for name, height in [('Phoenix Water Tank', 25), ('Mt Defiance', 95), ('Halfway', 56.75), ('Jim Creek Butte', 32.8),
                             ('Satus', 32.8), ('Elephant', 10), ('Two Rivers', 130), ('Round Mountain Chelan', 80)]:
            self.assertEqual((entries[name]['status'], entries[name]['height_ft']), ('complete', height))

        blocked = {r['name'] for r in read('source/camera-viewsheds-blocked.json')}
        self.assertFalse({'Natapoc Ridge', 'Natapoc Ridge North', 'Anderson'} & blocked)
        self.assertNotIn('Midnight Gulch', blocked)
        self.assertNotIn('Phoenix Water Tank', blocked)

    def test_october_sheet_additions(self):
        pano = {f['properties']['name']: f['properties'] for f in read('live/pano-sites.geojson')['features']}
        self.assertNotIn('Clearwater Wind Farm', pano)
        self.assertEqual({p.get('owner') for p in pano.values()},
                         {'Portland General Electric', 'Pacific Power', 'Washington DNR', 'Puget Sound Energy', 'Avista Utilities'})
        # WA DNR heights are written with a foot mark in the sheet
        self.assertEqual(pano['Capitol Peak']['cameraHeightFt'], 270)
        self.assertEqual((pano['Mullan Substation']['cameraHeightFt'], pano['Round Butte']['cameraHeightFt']), (64.99, 81.99))
        alertwest = {f['properties']['name']: f['properties'] for f in read('live/alertwest-sites.geojson')['features']}
        self.assertEqual(alertwest['Monument Mountain']['cameraHeightFt'], 43.33)
        self.assertTrue(alertwest['Gold Hill']['cameraHeightEstimated'])
        # live sites ALERTWest keeps out of its API, so the map draws their markers itself
        self.assertEqual({n for n, p in alertwest.items() if p.get('outsideApi')}, {'Bear Mountain', 'Callahan Ridge'})

        # every site with a height and location is modeled, so nothing waits in the GDAL queue
        for provider in ['alertwest', 'pano']:
            self.assertEqual(read(f'source/{provider}-sites-needing-viewsheds.geojson')['features'], [])

        modeled = {e['site_name'] for provider in ['alertwest', 'pano']
                   for e in read(f'live/{provider}-viewshed-manifest.json')['viewsheds'] if e['status'] == 'complete'}
        self.assertTrue({'Gold Hill', 'Dry Mountain', 'Sycan Substation', 'Takilma', 'Midnight Gulch', 'Anderson', 'McDonald Mountain', 'Natapoc Ridge', 'Natapoc Ridge North'} <= modeled)

    def test_avista_stations(self):
        avista = {f['properties']['name']: f for f in read('live/pano-sites.geojson')['features']
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
        sites = {f['properties']['name']: f for f in read('live/envirovision-sites.geojson')['features']}
        self.assertEqual(sum(f['properties']['cameraCount'] for f in sites.values()), 126)
        self.assertEqual(len({f['properties']['viewshedId'] for f in sites.values()}), 88)
        # the point geometry wins over ODF's Longitude column, which lacks its minus sign here
        self.assertEqual(sites['Weston']['geometry']['coordinates'], [-118.37586, 45.800075])
        self.assertEqual(sites['Weston']['properties']['aliases'], ['Weston High', 'Weston Low'])
        # a site is modeled from its tallest camera
        self.assertEqual(sites['Soda Mountain']['properties']['cameraHeightFt'], 131)
        self.assertEqual(sites['Soda Mountain']['properties']['cameraHeightsFt'], [98, 131])
        # added by ODF's October 27 CSV export, which also corrected Weston's height
        self.assertEqual(sites['Warner Canyon']['properties']['cameraHeightFt'], 54)
        self.assertEqual(sites['Weston']['properties']['cameraHeightFt'], 185)
        # 60 ft is ODF's planning default
        self.assertEqual(sum(bool(f['properties'].get('cameraHeightEstimated')) for f in sites.values()), 5)
        self.assertTrue({'Elk Mountain (Bridge)', 'Elk Mountain (Wallowa)'} <= set(sites))
        self.assertEqual(sum(bool(f['properties'].get('sharesAlertWestSite')) for f in sites.values()), 5)
        self.assertEqual(read('source/envirovision-sites-needing-viewsheds.geojson')['features'], [])
        self.assertEqual({e['status'] for e in read('live/envirovision-viewshed-manifest.json')['viewsheds']}, {'complete'})


class CameraProviderRegistryTests(unittest.TestCase):
    def test_every_pano_site_carries_its_owners_viewer(self):
        from camera_providers import PANO_OWNERS

        for feature in read('live/pano-sites.geojson')['features']:
            properties = feature['properties']
            owner = PANO_OWNERS[properties['owner']]
            self.assertEqual((properties['viewerUrl'], properties['viewerName']), (owner['viewerUrl'], owner['viewerName']))

    def test_sheet_table_for_an_unlisted_owner_stops_the_build(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location('csv_to_geojson', ROOT / 'scripts/csv-to-geojson.py')
        converter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(converter)
        sheet = '\n'.join([
            'Site Name,Latitude,Longitude,Elevation,Camera Height (ft)',
            'Example Butte,45.0,-121.0,,50',
            '',
            'Example Electric pano.ai sites,,,,',
            'Example Peak,45.5,-121.5,,60',
        ])

        with self.assertRaisesRegex(ValueError, 'Example Electric pano.ai sites.*camera-providers.json'):
            converter.sites_csv_to_geojson(sheet)

    def test_every_provider_has_a_published_manifest(self):
        from camera_providers import PROVIDERS

        for provider in PROVIDERS:
            self.assertTrue((ROOT / f'data/live/{provider}-viewshed-manifest.json').is_file(), provider)


if __name__ == '__main__':
    unittest.main()
