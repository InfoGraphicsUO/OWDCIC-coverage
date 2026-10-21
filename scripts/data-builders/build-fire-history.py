#!/usr/bin/env python3
"""builds the fire perimeter and ignition GeoJSON drawn by the web map's Fire history layer

perimeters come from the Interagency Fire Perimeter History service through
2019, where its Oregon and Washington records end, and from the full WFIGS
perimeter service from 2020 on. ignitions are WFIGS incident locations, which
start in 2014. only wildfires inside Oregon or Washington are kept
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SERVICES = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services'
HISTORY_URL = f'{SERVICES}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query'
PERIMETERS_URL = f'{SERVICES}/WFIGS_Interagency_Perimeters/FeatureServer/0/query'
INCIDENTS_URL = f'{SERVICES}/WFIGS_Incident_Locations/FeatureServer/0/query'

DEFAULT_PERIMETERS = PROJECT_ROOT / 'data/fire-history-perimeters.geojson'
DEFAULT_IGNITIONS = PROJECT_ROOT / 'data/fire-history-ignitions.geojson'
REGION_FOCUS = PROJECT_ROOT / 'data/region-focus.geojson'
# Oregon and Washington state FIPS codes in region-focus.geojson
STATE_IDS = ('41', '53')

FIRST_YEAR = 2016
# the history service's Oregon and Washington perimeters stop after this year
LAST_HISTORY_YEAR = 2019
# smaller fires are mostly spot fires that would bury the map, and only WFIGS
# maps them, so keeping them would make fire activity look like it jumped in 2020
MIN_ACRES = 100

# matches REGION_DATA_BOUNDS in js/config.js
REGION_BOUNDS = (-124.85, 41.99, -116.4, 49.01)
# degrees; about 100 m of simplification and 10 m of precision keeps the file small
MAX_OFFSET = '0.001'
PRECISION = '4'
PAGE_SIZE = 500


def query(url: str, params: dict) -> dict:
    body = urlencode({'f': 'geojson', **params}).encode()
    # the service drops requests now and then, so retry with 1, 2, 4, 8 s waits
    for attempt in range(5):
        try:
            with urlopen(Request(url, body), timeout=180) as response:
                result = json.load(response)
            if 'error' in result:
                raise RuntimeError(result['error'])
            return result
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError('unreachable')


def fetch_all(url: str, where: str, fields: list[str], polygons: bool) -> list[dict]:
    params = {
        'where': where,
        'outFields': ','.join(fields),
        'returnGeometry': 'true',
        'outSR': '4326',
        'geometry': ','.join(map(str, REGION_BOUNDS)),
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'orderByFields': 'OBJECTID',
        'resultRecordCount': str(PAGE_SIZE),
    }
    if polygons:
        params |= {'maxAllowableOffset': MAX_OFFSET, 'geometryPrecision': PRECISION}
    else:
        params['geometryPrecision'] = '5'

    features: list[dict] = []
    while True:
        page = query(url, {**params, 'resultOffset': str(len(features))})['features']
        features.extend(page)
        if len(page) < PAGE_SIZE:
            return features


def load_states() -> list[list[list[list[float]]]]:
    """returns each Oregon and Washington polygon as a list of rings"""

    region = json.loads(REGION_FOCUS.read_text())
    polygons = []
    for feature in region['features']:
        if feature['properties'].get('STATE') not in STATE_IDS:
            continue
        geometry = feature['geometry']
        coords = geometry['coordinates']
        polygons.extend([coords] if geometry['type'] == 'Polygon' else coords)
    return polygons


def point_in_rings(x: float, y: float, rings: list[list[list[float]]]) -> bool:
    # even-odd ray casting, so holes count as outside
    inside = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def in_states(points: list[list[float]], states: list) -> bool:
    return any(point_in_rings(x, y, rings) for x, y in points for rings in states)


def outer_points(geometry: dict) -> list[list[float]]:
    coords = geometry['coordinates']
    polygons = [coords] if geometry['type'] == 'Polygon' else coords
    return [point for polygon in polygons for point in polygon[0]]


def year_of(milliseconds: int | None) -> int | None:
    if milliseconds is None:
        return None
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).year


def date_of(milliseconds: int | None) -> str | None:
    if milliseconds is None:
        return None
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).strftime('%Y-%m-%d')


def round_acres(acres) -> float | None:
    return None if acres is None else round(float(acres), 1)


def keep_largest(features: list[dict], key) -> list[dict]:
    """keeps one perimeter per fire, the largest, since services repeat updated ones"""

    best: dict = {}
    for feature in features:
        identifier = key(feature) or id(feature)
        current = best.get(identifier)
        if current is None or (feature['properties']['acres'] or 0) > (current['properties']['acres'] or 0):
            best[identifier] = feature
    return list(best.values())


def history_perimeters(states: list) -> list[dict]:
    raw = fetch_all(
        HISTORY_URL,
        f"FIRE_YEAR_INT >= {FIRST_YEAR} AND FIRE_YEAR_INT <= {LAST_HISTORY_YEAR}"
        f" AND FEATURE_CA LIKE 'Wildfire%' AND GIS_ACRES >= {MIN_ACRES}",
        ['INCIDENT', 'GIS_ACRES', 'FIRE_YEAR_INT', 'UNQE_FIRE_ID', 'IRWINID'],
        polygons=True,
    )
    features = []
    for feature in raw:
        props = feature['properties']
        if not feature.get('geometry') or not in_states(outer_points(feature['geometry']), states):
            continue
        features.append({
            'type': 'Feature',
            'properties': {
                'year': props['FIRE_YEAR_INT'],
                'name': (props['INCIDENT'] or '').strip().title() or None,
                'acres': round_acres(props['GIS_ACRES']),
                'id': props['IRWINID'] or props['UNQE_FIRE_ID'],
            },
            'geometry': feature['geometry'],
        })
    return keep_largest(features, lambda feature: feature['properties']['id'])


def wfigs_perimeters(states: list) -> list[dict]:
    first = f"{LAST_HISTORY_YEAR + 1}-01-01"
    raw = fetch_all(
        PERIMETERS_URL,
        f"attr_IncidentTypeCategory = 'WF' AND attr_FireDiscoveryDateTime >= DATE '{first}'"
        f" AND poly_GISAcres >= {MIN_ACRES}",
        ['poly_IncidentName', 'attr_IncidentName', 'poly_GISAcres',
         'attr_FireDiscoveryDateTime', 'attr_IrwinID'],
        polygons=True,
    )
    features = []
    for feature in raw:
        props = feature['properties']
        if not feature.get('geometry') or not in_states(outer_points(feature['geometry']), states):
            continue
        features.append({
            'type': 'Feature',
            'properties': {
                'year': year_of(props['attr_FireDiscoveryDateTime']),
                'name': (props['attr_IncidentName'] or props['poly_IncidentName'] or '').strip().title() or None,
                'acres': round_acres(props['poly_GISAcres']),
                'id': props['attr_IrwinID'],
            },
            'geometry': feature['geometry'],
        })
    return keep_largest(features, lambda feature: feature['properties']['id'])


def ignitions(states: list) -> list[dict]:
    raw = fetch_all(
        INCIDENTS_URL,
        f"IncidentTypeCategory = 'WF' AND FireDiscoveryDateTime >= DATE '{FIRST_YEAR}-01-01'"
        f" AND IncidentSize >= {MIN_ACRES}",
        ['IncidentName', 'IncidentSize', 'FireDiscoveryDateTime', 'FireCauseGeneral', 'FireCause'],
        polygons=False,
    )
    features = []
    for feature in raw:
        props = feature['properties']
        geometry = feature.get('geometry')
        if not geometry or not in_states([geometry['coordinates']], states):
            continue
        features.append({
            'type': 'Feature',
            'properties': {
                'year': year_of(props['FireDiscoveryDateTime']),
                'name': (props['IncidentName'] or '').strip().title() or None,
                'acres': round_acres(props['IncidentSize']),
                'date': date_of(props['FireDiscoveryDateTime']),
                'cause': props['FireCauseGeneral'] or props['FireCause'],
            },
            'geometry': geometry,
        })
    return features


def write(path: Path, features: list[dict]) -> None:
    # the year order lets the map draw older fires underneath newer ones
    features.sort(key=lambda feature: (feature['properties']['year'] or 0))
    for feature in features:
        feature['properties'].pop('id', None)
    collection = {'type': 'FeatureCollection', 'features': features}
    path.write_text(json.dumps(collection, separators=(',', ':')) + '\n')
    years = sorted({feature['properties']['year'] for feature in features})
    print(f'{path.relative_to(PROJECT_ROOT)}: {len(features)} features, '
          f'{years[0]}-{years[-1]}, {path.stat().st_size / 1e6:.1f} MB', flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--perimeters', type=Path, default=DEFAULT_PERIMETERS)
    parser.add_argument('--ignitions', type=Path, default=DEFAULT_IGNITIONS)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    states = load_states()
    write(args.perimeters, history_perimeters(states) + wfigs_perimeters(states))
    write(args.ignitions, ignitions(states))


if __name__ == '__main__':
    main()
