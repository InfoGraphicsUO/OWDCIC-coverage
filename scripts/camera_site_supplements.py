"""fills incomplete installation rows from reviewed local/network source references

the original CSV stays untouched. digitized ids resolve against the current local
data, with archived API/PGE coordinates as the fallback. separate provider records
stay separate even at a shared tower because their observer heights can differ
"""
import csv
import json
import re
from datetime import datetime
from pathlib import Path


# built by scripts/data-builders/build-envirovision-sites.py from ODF's geodatabase
EXTERNAL_PROVIDERS = ('envirovision',)
# each Pano owner's public viewer; its station pages live under /station/<id>
PANO_VIEWERS = {
    'Portland General Electric': 'https://portlandgeneral.wildfirewatch.com/',
    'Pacific Power': 'https://pacificpower.wildfirewatch.com/',
    'Washington DNR': 'https://wadnr.wildfirewatch.com/',
    'Puget Sound Energy': 'https://pse.wildfirewatch.com/',
    'Avista Utilities': 'https://avista.wildfirewatch.com/',
}
# Avista's Pano AI station export, kept separate from the installation sheet
AVISTA_STATIONS = 'Avista Station Camera Heights(Query result).csv'
PROVIDER_LABELS = {'alertwest': 'ALERTWest', 'pano': 'Pano AI', 'envirovision': 'EnviroVision'}
# counts in this doc sit between <!-- name --> and <!-- /name --> and are rewritten on every build
STATUS_DOC = Path(__file__).resolve().parent.parent / 'cameras-without-viewsheds.md'


def supplement_sites(by_provider, text, converter):
    data = Path(__file__).resolve().parent.parent / "data"
    rows = {r[0].strip(): r for r in csv.reader(text.splitlines()) if r and r[0].strip()}
    digitized = {f['properties']['id']: f for f in json.loads((data / 'digitized-camera-sources.geojson').read_text())['features']}
    counties = converter.load_counties(converter.DEFAULT_COUNTIES)
    supplements = json.loads((data / 'camera-site-supplements.json').read_text())
    add_avista_stations(by_provider['pano'], data / AVISTA_STATIONS, supplements, counties, converter)

    # rows held out of the map until the sheet is clarified
    excluded = {(r['provider'], r['sheetName']) for r in supplements.get('excluded', [])}

    for provider, collection in by_provider.items():
        collection['features'] = [f for f in collection['features'] if (provider, f['properties']['name']) not in excluded]

    # live sites ALERTWest keeps out of its API, so the map draws their markers from this file
    for record in supplements.get('outsideApi', []):
        site = next((f for f in by_provider[record['provider']]['features'] if f['properties']['name'] == record['sheetName']), None)
        if site is None:
            raise ValueError(f"Unknown outsideApi site: {record['sheetName']}")
        site['properties']['outsideApi'] = True
        # the live API supplies no county for these, so the file carries it
        site['properties'].update(county=record['county'], state=record['state'])

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
        # collapse aliases of the same provider/site, not neighboring towers (match is by name or within 1 m)
        existing = next((f for f in features if f['properties']['name'] in (record['name'], record.get('sheetName')) or
                         converter.distance_m(*point, *f['geometry']['coordinates']) < 1), None)

        if existing:
            old = existing['properties']
            if old['name'] == record.get('sheetName'):
                # the sheet now locates this row; the reviewed name and point still win
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

    # hand-collected viewer pages; rows without a link keep the panel's general viewer link
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

    # a height alone does not mean published coverage exists, so queue only missing
    # or stale models and keep unresolved observer heights out of runnable files
    blocked = []
    # providers built outside the sheet keep their own site file; only its queue state is refreshed
    external = {}
    published, queued, published_dates = {}, {}, []

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
        published[provider] = 0

        if manifest.get('generated_utc'):
            published_dates.append(manifest['generated_utc'])

        for source_id, feature in enumerate(collection['features'], start=1):
            props = feature['properties']
            view_id = props.get('viewshedId') or converter.slugify(props['name'])
            entry = entries.get(view_id)
            complete = bool(entry and entry['status'] == 'complete' and
                            entry['height_ft'] == props['cameraHeightFt'] and
                            [entry['longitude'], entry['latitude']] == feature['geometry']['coordinates'])

            if complete:
                published[provider] += 1
                continue

            props['viewshedStatus'] = 'pending'
            reason = props.get('viewshedReview') or ('Missing camera observer height' if props['cameraHeightFt'] is None else None)

            if reason:
                blocked.append({'provider': provider, 'name': props['name'], 'reason': reason})
            else:
                # sourceId keeps the site's position in the full file when the queue is merged
                ready.append({**feature, 'properties': {**props, 'sourceId': source_id}})

        converter.write_geojson(data / f'{provider}-sites-needing-viewsheds.geojson', {'type': 'FeatureCollection', 'features': ready})
        queued[provider] = len(ready)

    for provider, collection in external.items():
        converter.write_geojson(data / f'{provider}-sites.geojson', collection)

    # sheet rows with no usable location never become features, so list them here
    blocked += [{'provider': r['provider'], 'name': r['sheetName'], 'reason': r['reason']} for r in supplements.get('unmapped', [])]
    (data / 'camera-viewsheds-blocked.json').write_text(json.dumps(blocked, indent=2) + '\n', encoding='utf-8')
    update_status_doc(published, queued, len(blocked), max(published_dates, default=None))


def add_avista_stations(collection, path, supplements, counties, converter):
    """appends Avista's stations after the sheet's Pano sites so earlier sourceIds stay put"""
    if not path.exists():
        return

    # Idaho stations sit outside the county polygons, so the file carries their county
    outside = {r['name']: r for r in supplements.get('avistaOutsideRegion', [])}
    names = {f['properties']['name'] for f in collection['features']}

    for row in csv.DictReader(path.read_text(encoding='utf-8-sig').splitlines()):
        name = row['Name'].strip()
        if name in names:
            raise ValueError(f"Avista station duplicates a Pano site: {name}")

        point = [float(row['Long']), float(row['Lat'])]
        props = {
            'name': name,
            'aliases': [],
            # the export derives feet from meters to ten decimals
            'cameraHeightFt': round(float(row['HeightFt']), 2),
            'viewshedId': 'pano-' + converter.slugify(name),
            'provider': 'pano',
            'owner': 'Avista Utilities',
            'panoStationId': int(row['ID']),
        }
        county = converter.county_at(point, counties)
        if county:
            props.update(county=county['name'], state=county['state'])
        elif name in outside:
            props.update(county=outside[name]['county'], state=outside[name]['state'])

        collection['features'].append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': point}, 'properties': props})


def update_status_doc(published, queued, blocked_count, published_utc):
    if not STATUS_DOC.exists():
        return

    # the newest publish date, so rebuilding without new viewsheds leaves the doc unchanged
    updated = f"Updated {format_date(published_utc)}. " if published_utc else ''
    ready = [f"{count} {PROVIDER_LABELS.get(provider, provider)}" for provider, count in queued.items() if count]
    values = {
        'published-counts': updated + join_words([
            f"{published[provider]} {PROVIDER_LABELS.get(provider, provider)}" for provider in published
        ]) + ' sites have published viewsheds.',
        'ready-count': f"Ready to run: {join_words(ready)} {plural(sum(queued.values()))}" if ready else 'Ready to run: none',
        'blocked-count': f"Blocked: {blocked_count} {plural(blocked_count)}",
    }

    text = STATUS_DOC.read_text(encoding='utf-8')
    for name, value in values.items():
        text = re.sub(rf'(<!-- {name} -->).*?(<!-- /{name} -->)', lambda match: match[1] + value + match[2], text, flags=re.S)
    STATUS_DOC.write_text(text, encoding='utf-8')


def format_date(utc):
    date = datetime.fromisoformat(utc.replace('Z', '+00:00'))
    return f"{date:%B} {date.day}, {date.year}"


def join_words(items):
    return items[0] if len(items) < 2 else ', '.join(items[:-1]) + (',' if len(items) > 2 else '') + ' and ' + items[-1]


def plural(count):
    return 'site' if count == 1 else 'sites'
