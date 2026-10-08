"""Fill incomplete installation rows from reviewed local/network source references.

The original CSV stays untouched. Digitized ids resolve against the current local
data; archived API/PGE coordinates are the fallback. Separate provider records
remain separate even at a shared tower because their observer heights can differ.
"""
import csv
import json
from pathlib import Path


def supplement_sites(by_provider, text, converter):
    data = Path(__file__).resolve().parent.parent / "data"
    rows = {r[0].strip(): r for r in csv.reader(text.splitlines()) if r and r[0].strip()}
    digitized = {f['properties']['id']: f for f in json.loads((data / 'digitized-camera-sources.geojson').read_text())['features']}
    counties = converter.load_counties(converter.DEFAULT_COUNTIES)
    supplements = json.loads((data / 'camera-site-supplements.json').read_text())
    for record in supplements['sites']:
        provider = record['provider']
        row = rows.get(record.get('sheetName'))
        height = converter.to_finite_number(row[4]) if row else None
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
        existing = next((f for f in features if f['properties']['name'] == record['name'] or
                         converter.distance_m(*point, *f['geometry']['coordinates']) < 1), None)
        if existing:
            old = existing['properties']
            if old.get('cameraHeightFt') not in (None, height) and height is not None:
                raise ValueError(f"Conflicting heights at {record['name']}")
            old['aliases'] = sorted(set(old.get('aliases', []) + props['aliases'] + [record['name']]) - {old['name']})
            if old.get('cameraHeightFt') is None:
                old['cameraHeightFt'] = height
            continue
        features.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': point}, 'properties': props})

    # A height alone does not mean published coverage exists. Queue only missing
    # or stale models, and keep unresolved observer heights out of runnable files.
    blocked = []
    for provider, collection in by_provider.items():
        manifest = json.loads((data / f'{provider}-viewshed-manifest.json').read_text())
        entries = {e['viewshed_id']: e for e in manifest['viewsheds']}
        ready = []
        for feature in collection['features']:
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
                ready.append(feature)
        converter.write_geojson(data / f'{provider}-sites-needing-viewsheds.geojson', {'type': 'FeatureCollection', 'features': ready})
    blocked.append({'provider': 'alertwest', 'name': 'Gold Hill', 'reason': 'Missing coordinates and camera observer height'})
    (data / 'camera-viewsheds-blocked.json').write_text(json.dumps(blocked, indent=2) + '\n', encoding='utf-8')
