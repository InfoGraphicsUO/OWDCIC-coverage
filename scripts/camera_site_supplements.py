"""Fill incomplete installation rows from reviewed local/network source references.

The original CSV stays untouched. Digitized ids resolve against the current local
data; archived API/PGE coordinates are the fallback. Separate provider records
remain separate even at a shared tower because their observer heights can differ.
"""
import csv
import json
from pathlib import Path


# Built by scripts/data-builders/build-envirovision-sites.py from ODF's geodatabase.
EXTERNAL_PROVIDERS = ('envirovision',)
# each Pano owner's public viewer; its station pages live under /station/<id>
PANO_VIEWERS = {
    'Portland General Electric': 'https://portlandgeneral.wildfirewatch.com/',
    'Pacific Power': 'https://pacificpower.wildfirewatch.com/',
    'Washington DNR': 'https://wadnr.wildfirewatch.com/',
}


def supplement_sites(by_provider, text, converter):
    data = Path(__file__).resolve().parent.parent / "data"
    rows = {r[0].strip(): r for r in csv.reader(text.splitlines()) if r and r[0].strip()}
    digitized = {f['properties']['id']: f for f in json.loads((data / 'digitized-camera-sources.geojson').read_text())['features']}
    counties = converter.load_counties(converter.DEFAULT_COUNTIES)
    supplements = json.loads((data / 'camera-site-supplements.json').read_text())
    # Rows held out of the map until the sheet is clarified.
    excluded = {(r['provider'], r['sheetName']) for r in supplements.get('excluded', [])}

    for provider, collection in by_provider.items():
        collection['features'] = [f for f in collection['features'] if (provider, f['properties']['name']) not in excluded]

    for record in supplements['sites']:
        provider = record['provider']
        row = rows.get(record.get('sheetName'))
        height = converter.to_height_ft(row[4]) if row else None
        props = {k: v for k, v in record.items() if k not in ('coordinates', 'sheetName', 'digitizedId')}
        props['cameraHeightFt'] = height
        props['viewshedId'] = ('' if provider == 'alertwest' else 'pano-') + converter.slugify(record['name'])

        if 'digitizedId' in record:
            feature = digitized[record['digitizedId']]
            if feature['properties']['operator'] not in converter.DIGITIZED_OPERATORS[provider]:
                raise ValueError(f"Provider mismatch: {record['name']}")

            point = feature['geometry']['coordinates']
            props.update(locationSource='digitized', digitizedId=record['digitizedId'], source='data/digitized-camera-sources.geojson')
        else:
            point = record['coordinates']

        if provider == 'alertwest':
            props['alertWestLive'] = False
        else:
            county = converter.county_at(point, counties)
            if county:
                props.update(county=county['name'], state=county['state'])

        features = by_provider[provider]['features']
        # Collapse aliases of the same provider/site, not neighboring towers.
        existing = next((f for f in features if f['properties']['name'] in (record['name'], record.get('sheetName')) or
                         converter.distance_m(*point, *f['geometry']['coordinates']) < 1), None)

        if existing:
            old = existing['properties']
            if old['name'] == record.get('sheetName'):
                # The sheet now locates this row; the reviewed name and point still win.
                if existing['geometry']['coordinates'] != point:
                    old.setdefault('reportedCoordinates', existing['geometry']['coordinates'])
                    existing['geometry']['coordinates'] = point

                sheet_name = old['name']
                old.update({k: v for k, v in props.items() if k not in ('aliases', 'cameraHeightFt', 'alertWestLive')})

                if sheet_name != old['name']:
                    old['aliases'] = old.get('aliases', []) + [sheet_name]

            if old.get('cameraHeightFt') not in (None, height) and height is not None:
                raise ValueError(f"Conflicting heights at {record['name']}")

            old['aliases'] = sorted(set(old.get('aliases', []) + props['aliases'] + [record['name']]) - {old['name']})

            if old.get('cameraHeightFt') is None:
                old['cameraHeightFt'] = height

            continue

        features.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': point}, 'properties': props})

    # Hand-collected viewer pages; rows without a link keep the panel's general viewer link.
    links_path = data / 'pano-camera-links.csv'
    if links_path.exists():

        pano = {}
        for feature in by_provider['pano']['features']:
            properties = feature['properties']
            pano[properties['name']] = properties

        links_text = links_path.read_text(encoding='utf-8-sig')
        rows = csv.DictReader(links_text.splitlines())

        for row in rows:

            name = (row.get('name') or '').strip()
            link = (row.get('link') or '').strip()

            if not link:
                continue

            if name not in pano:
                raise ValueError(f"Unknown Pano site in {links_path.name}: {name}")

            station_url = PANO_VIEWERS[pano[name]['owner']] + 'station/'
            if not link.startswith(station_url):
                raise ValueError(f"Expected a {station_url} link for {name}: {link}")

            pano[name]['feed'] = link

    # A height alone does not mean published coverage exists. Queue only missing
    # or stale models, and keep unresolved observer heights out of runnable files.
    blocked = []
    # Providers built outside the sheet keep their own site file; only its queue state is refreshed.
    external = {}

    for provider in EXTERNAL_PROVIDERS:
        path = data / f'{provider}-sites.geojson'
        if path.exists():
            external[provider] = json.loads(path.read_text())
            for feature in external[provider]['features']:
                feature['properties'].pop('viewshedStatus', None)

    for provider, collection in {**by_provider, **external}.items():
        manifest_path = data / f'{provider}-viewshed-manifest.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'viewsheds': []}
        entries = {e['viewshed_id']: e for e in manifest['viewsheds']}
        ready = []

        for source_id, feature in enumerate(collection['features'], start=1):
            props = feature['properties']
            view_id = props.get('viewshedId') or converter.slugify(props['name'])
            entry = entries.get(view_id)
            complete = bool(entry and entry['status'] == 'complete' and
                            entry['height_ft'] == props['cameraHeightFt'] and
                            [entry['longitude'], entry['latitude']] == feature['geometry']['coordinates'])

            if complete:
                continue

            props['viewshedStatus'] = 'pending'
            reason = props.get('viewshedReview') or ('Missing camera observer height' if props['cameraHeightFt'] is None else None)

            if reason:
                blocked.append({'provider': provider, 'name': props['name'], 'reason': reason})
            else:
                # sourceId keeps the site's position in the full file when the queue is merged
                ready.append({**feature, 'properties': {**props, 'sourceId': source_id}})

        converter.write_geojson(data / f'{provider}-sites-needing-viewsheds.geojson', {'type': 'FeatureCollection', 'features': ready})

    for provider, collection in external.items():
        converter.write_geojson(data / f'{provider}-sites.geojson', collection)

    # Sheet rows with no usable location never become features, so list them here.
    blocked += [{'provider': r['provider'], 'name': r['sheetName'], 'reason': r['reason']} for r in supplements.get('unmapped', [])]
    (data / 'camera-viewsheds-blocked.json').write_text(json.dumps(blocked, indent=2) + '\n', encoding='utf-8')
