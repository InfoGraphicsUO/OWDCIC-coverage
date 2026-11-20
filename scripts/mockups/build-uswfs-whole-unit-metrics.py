#!/usr/bin/env python3
"""coverage across each whole USWFS unit, for the issue #227 results panel mockups

The unit divisions only measure the BLM, USFWS, and NPS land inside each unit.
This measures the full unit boundary (wildland-fire-unit-outlines.geojson) the same
way build-selection-metrics.py measures a division: OR/WA land minus Census
hydrography, coverage from every provider's web viewsheds. "All USWFS units" is
the union of the units. Run with the QGIS python like build-selection-metrics.py.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from shapely import union_all

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('metrics', ROOT / 'scripts/build-selection-metrics.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)

OUTLINES = ROOT / 'data/live/wildland-fire-unit-outlines.geojson'
OUT = ROOT / 'data/live/wildland-fire-unit-whole-metrics.json'
ALL_ID = 'wildland-fire-unit:all'


def main():
    coverages, _, _ = metrics.load_all_viewsheds(metrics.VIEWSHEDS)
    mask = json.loads(metrics.MASK.read_text())['features'][0]['geometry']
    states = json.loads((metrics.DIVISIONS / 'state.geojson').read_text())['features']
    orwa = union_all([metrics.project(feature['geometry']) for feature in states])
    land = metrics.project(mask).intersection(orwa).difference(metrics.load_hydro(metrics.HYDRO_CACHE))

    units = {feature['properties']['divisionId']: metrics.project(feature['geometry'])
             for feature in json.loads(OUTLINES.read_text())['features']}
    units[ALL_ID] = union_all(list(units.values()))

    result = {}
    for division_id, polygon in sorted(units.items()):
        fields, providers = metrics.selection_coverage(polygon.intersection(land), coverages)
        result[division_id] = {**fields, 'providerCoverage': providers}
        print(division_id, fields, flush=True)

    OUT.write_text(json.dumps({
        'metadata': {
            'note': 'whole unit boundary coverage for the issue #227 mockups',
            'landFootprint': 'regional coastal mask minus Census areal hydrography',
            'areaCrs': 'EPSG:5070',
        },
        'units': result,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
