"""checks the supplemented source data and the GDAL handoff contract

the first class holds rules every data update must keep, with counts taken from the
data itself; the rest pin facts about particular sites that past updates fixed
"""
import csv
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from camera_providers import PROVIDERS, viewshed_prefix  # noqa: E402


def read(name):
    return json.loads((ROOT / 'data' / name).read_text())


def sites(provider):
    return read(f'live/{provider}-sites.geojson')['features']


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)

    return module


runner = load_script('gdal_camera_viewsheds', 'gdal-camera-viewsheds.py')


def viewshed_id(feature):
    """the id the viewshed runner gives a site; ALERTWest sites take theirs from the name"""
    properties = feature['properties']
    return runner.slugify(str(properties.get('viewshedId') or properties['name']))


def published(provider):
    return {e['viewshed_id']: e for e in read(f'live/{provider}-viewshed-manifest.json')['viewsheds'] if e['status'] == 'complete'}


def load_converter():
    return load_script('csv_to_geojson', 'csv-to-geojson.py')


class DataUpdateContractTests(unittest.TestCase):
    """fails when an update is only partly done, such as a site added but not modeled"""

    def test_every_site_is_published_or_listed_as_blocked(self):
        blocked = {(r['provider'], r['name']) for r in read('source/camera-viewsheds-blocked.json')}

        for provider in PROVIDERS:
            ids = published(provider)
            queue = read(f'source/{provider}-sites-needing-viewsheds.geojson')['features']
            # a Live site run empties the queue, so a queued site means the run has not happened
            self.assertEqual([f['properties']['name'] for f in queue], [], f'{provider} sites still need viewsheds')

            for feature in sites(provider):
                properties = feature['properties']
                with self.subTest(provider=provider, site=properties['name']):
                    if (provider, properties['name']) in blocked:
                        continue

                    entry = ids.get(viewshed_id(feature))
                    self.assertIsNotNone(entry, 'no published viewshed and not listed as blocked')
                    # the viewshed was modeled from this point and height
                    self.assertEqual(feature['geometry']['coordinates'], [entry['longitude'], entry['latitude']])
                    self.assertEqual(properties['cameraHeightFt'], entry['height_ft'])

    def test_every_published_viewshed_belongs_to_a_site(self):
        for provider in PROVIDERS:
            site_ids = {viewshed_id(f) for f in sites(provider)}
            self.assertEqual(set(published(provider)) - site_ids, set(), provider)

    def test_viewshed_ids_are_unique_across_providers(self):
        seen = set()

        for provider in PROVIDERS:
            ids = [viewshed_id(f) for f in sites(provider)]
            self.assertEqual(len(ids), len(set(ids)), provider)
            self.assertFalse(seen & set(ids), provider)
            self.assertTrue(all(i.startswith(viewshed_prefix(provider)) for i in ids), provider)
            seen |= set(ids)

    def test_every_envirovision_camera_is_in_a_site(self):
        with (ROOT / 'data/source/envirovision-cameras.csv').open(newline='', encoding='utf-8') as file:
            cameras = list(csv.DictReader(file))

        self.assertEqual(sum(f['properties']['cameraCount'] for f in sites('envirovision')), len(cameras))
        self.assertEqual({f['properties']['name'] for f in sites('envirovision')}, {row['site'] for row in cameras})

    def test_envirovision_sites_sharing_an_alertwest_tower_are_within_150_m(self):
        converter = load_converter()
        towers = [f['geometry']['coordinates'] for f in sites('alertwest')]

        for feature in sites('envirovision'):
            lon, lat = feature['geometry']['coordinates']
            nearest = min(converter.distance_m(lon, lat, *tower) for tower in towers)
            with self.subTest(site=feature['properties']['name']):
                self.assertEqual(bool(feature['properties'].get('sharesAlertWestSite')), nearest <= 150)


class CameraSiteDataTests(unittest.TestCase):
    def test_digitized_priority_and_unique_provider_points(self):
        digitized = {f['properties']['id']: f['geometry'] for f in read('live/digitized-camera-sources.geojson')['features']}
        for provider in PROVIDERS:
            features = sites(provider)
            self.assertEqual(len({tuple(f['geometry']['coordinates']) for f in features}), len(features))
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
        # WA DNR heights are written with a foot mark in the sheet
        converter = load_converter()
        self.assertEqual((converter.to_height_ft("270'"), converter.to_height_ft('64.99')), (270, 64.99))
        alertwest = {f['properties']['name']: f['properties'] for f in read('live/alertwest-sites.geojson')['features']}
        self.assertTrue(alertwest['Gold Hill']['cameraHeightEstimated'])
        # live sites ALERTWest keeps out of its API, so the map draws their markers itself
        self.assertEqual({n for n, p in alertwest.items() if p.get('outsideApi')}, {'Bear Mountain', 'Callahan Ridge'})

        modeled = {e['site_name'] for provider in ['alertwest', 'pano']
                   for e in read(f'live/{provider}-viewshed-manifest.json')['viewsheds'] if e['status'] == 'complete'}
        self.assertTrue({'Gold Hill', 'Dry Mountain', 'Sycan Substation', 'Takilma', 'Midnight Gulch', 'Anderson', 'McDonald Mountain', 'Natapoc Ridge', 'Natapoc Ridge North'} <= modeled)

    def test_avista_stations(self):
        avista = {f['properties']['name']: f for f in read('live/pano-sites.geojson')['features']
                  if f['properties'].get('owner') == 'Avista Utilities'}
        # Washington stations plus the Idaho ones that see well into Washington
        self.assertFalse({'Gold Mountain', 'St Maries', 'Orofino', 'Clearwater', 'Grangeville',
                          'Gold Cup Mountain', 'Maryanna', 'Sander Grade'} & set(avista))
        self.assertEqual(avista['Layton Hill']['properties']['viewshedId'], 'pano-layton-hill')
        self.assertEqual(avista['Hoodoo Mountain']['properties']['county'], 'Bonner')
        # Lewiston is missing from Avista's public viewer, so it keeps the front page
        self.assertEqual({n for n, f in avista.items() if 'feed' not in f['properties']}, {'Lewiston'})

    def test_envirovision_sites(self):
        sites = {f['properties']['name']: f for f in read('live/envirovision-sites.geojson')['features']}
        # the point geometry wins over ODF's Longitude column, which lacks its minus sign here
        self.assertEqual(sites['Weston']['geometry']['coordinates'], [-118.37586, 45.800075])
        self.assertEqual(sites['Weston']['properties']['aliases'], ['Weston High', 'Weston Low'])
        self.assertTrue({'Elk Mountain (Bridge)', 'Elk Mountain (Wallowa)'} <= set(sites))

        for name, feature in sites.items():
            properties = feature['properties']
            with self.subTest(site=name):
                # a site is modeled from its tallest camera
                self.assertEqual(properties['cameraHeightFt'], max(properties.get('cameraHeightsFt') or [properties['cameraHeightFt']]))
                # 60 ft is ODF's planning default
                if properties.get('cameraHeightEstimated'):
                    self.assertEqual(properties['cameraHeightFt'], 60)


class CameraProviderRegistryTests(unittest.TestCase):
    def test_every_pano_site_carries_its_owners_viewer(self):
        from camera_providers import PANO_OWNERS

        for feature in read('live/pano-sites.geojson')['features']:
            properties = feature['properties']
            owner = PANO_OWNERS[properties['owner']]
            self.assertEqual((properties['viewerUrl'], properties['viewerName']), (owner['viewerUrl'], owner['viewerName']))

    def test_sheet_table_for_an_unlisted_owner_stops_the_build(self):
        converter = load_converter()
        sheet ='\n'.join([
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
