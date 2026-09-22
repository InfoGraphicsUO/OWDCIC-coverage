#!/usr/bin/env python3
"""Cache Oregon and Washington PAD-US 4.1 fee parcels in EPSG:5070."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = ('https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/'
       'Fee_Managers_PADUS/FeatureServer/0/query')
WHERE = "State_Nm IN ('OR','WA') AND FeatClass='Fee'"
FIELDS = 'OBJECTID,State_Nm,Own_Type,Own_Name,Mang_Type,Mang_Name,Unit_Nm'
OUTPUT = ROOT / 'outputs/source-cache/padus-4.1-or-wa-fee-5070.geojsonl'


def query(params):
    body = urlencode({'f': 'geojson', **params}).encode()
    for attempt in range(5):
        try:
            with urlopen(Request(URL, body), timeout=180) as response:
                result = json.load(response)
            if 'error' in result:
                raise RuntimeError(result['error'])
            return result
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    ids = query({'where': WHERE, 'returnIdsOnly': 'true', 'f': 'json'})['objectIds']
    if not ids:
        raise RuntimeError('PAD-US returned no Oregon/Washington fee parcels')
    ids = sorted(ids)
    pending = args.output.with_suffix('.partial')
    seen = set()
    with pending.open('w') as stream:
        for start in range(0, len(ids), 100):
            batch = ids[start:start + 100]
            data = query({'objectIds': ','.join(map(str, batch)),
                          'outFields': FIELDS, 'returnGeometry': 'true',
                          'outSR': '5070', 'geometryPrecision': '1'})
            if data.get('crs', {}).get('properties', {}).get('name') != 'EPSG:5070':
                raise RuntimeError('PAD-US returned an unexpected CRS')
            for feature in data['features']:
                identifier = feature['properties']['OBJECTID']
                if identifier in seen:
                    raise RuntimeError(f'duplicate PAD-US OBJECTID {identifier}')
                seen.add(identifier)
                stream.write(json.dumps(feature, separators=(',', ':')) + '\n')
            if len(seen) % 1000 == 0 or start + 100 >= len(ids):
                print(f'cached {len(seen)} / {len(ids)} fee parcels', flush=True)
    if seen != set(ids):
        raise RuntimeError(f'PAD-US download is incomplete: {len(seen)} / {len(ids)}')
    pending.replace(args.output)
    print(args.output, flush=True)


if __name__ == '__main__':
    main()
