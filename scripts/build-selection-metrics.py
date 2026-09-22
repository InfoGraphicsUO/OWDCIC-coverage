#!/usr/bin/env python3
"""Precompute OR/WA land coverage and exclusive land designation shares.

Run with the QGIS bundled Python/GDAL runtime. Source downloads are cached in
outputs/source-cache so repeat builds use the same Census hydro snapshot.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from osgeo import ogr
from pyproj import Transformer
from shapely import (STRtree, area, disjoint_subset_union_all, from_wkb,
                     intersection, is_empty, make_valid, union_all)
from shapely.errors import GEOSException
from shapely.geometry import shape, mapping
from shapely.ops import transform
from shapely.validation import explain_validity

ROOT = Path(__file__).resolve().parents[1]
DIVISIONS = ROOT / 'data/divisions'
VIEWSHEDS = ROOT / 'outputs/gdal_viewsheds/mapbox/camera_viewsheds_web_epsg5070.gpkg'
MASK = ROOT / 'data/pacific-northwest-land-mask.geojson'
HYDRO_CACHE = ROOT / 'outputs/source-cache/census-areal-hydro-2025.geojsonl'
PADUS_FEE_CACHE = ROOT / 'outputs/source-cache/padus-4.1-or-wa-fee-5070.geojsonl'
CAMERA_OUT = ROOT / 'data/camera-coverage.json'
HYDRO_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1'
ENVELOPE = '-124.8,41.8,-116.3,49.1'
TYPES = ('state', 'county', 'house', 'us-house', 'senate', 'utility',
         'national-forest', 'national-park', 'federal-land', 'tribal-land')
EXPECTED_COUNTS = {
    'state': 2, 'county': 75, 'house': 109, 'us-house': 16, 'senate': 79,
    'utility': 3, 'national-forest': 23, 'national-park': 14,
    'federal-land': 7, 'tribal-land': 66,
}
TO_5070 = Transformer.from_crs(4326, 5070, always_xy=True).transform
UNAVAILABLE_COVERAGE = 'Coverage unavailable'
SIMPLIFY_TOLERANCE_M = 2.0
MAX_SIMPLIFY_AREA_CHANGE = 0.0005
PADUS_FEE_URL = ('https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/'
                 'Fee_Managers_PADUS/FeatureServer/0')
FEE_LABELS = {
    'TRIB': 'Tribal fee land',
    'STAT': 'State land',
    'LOC': 'Local government land',
    'DIST': 'Local government land',
    'NGO': 'Nonprofit open space',
    'PVT': 'Mapped private open space',
}


def padus_fee_label(properties):
    owner_type = properties['Own_Type']
    if owner_type == 'FED':
        return ('National Park Service land' if properties.get('Own_Name') == 'NPS'
                else 'U.S. Forest Service land' if properties.get('Own_Name') == 'USFS'
                else 'Other federal land')
    return FEE_LABELS.get(owner_type)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


class CategoryIndex:
    """Spatial index for exact, selection-local category intersections."""

    def __init__(self, geometries):
        self.geometries = []
        for geometry in geometries:
            if geometry is None or geometry.is_empty:
                continue
            simplified = geometry.simplify(SIMPLIFY_TOLERANCE_M,
                                           preserve_topology=True)
            area = geometry.area
            change = abs(simplified.area - area) / area if area else 1.0
            self.geometries.append(
                simplified if simplified.is_valid and change <= MAX_SIMPLIFY_AREA_CHANGE
                else geometry)
        self.tree = STRtree(self.geometries) if self.geometries else None

    def intersection(self, selection):
        if self.tree is None or selection.is_empty:
            return None
        indexes = self.tree.query(selection, predicate='intersects')
        if not len(indexes):
            return None
        candidates = [self.geometries[int(i)] for i in indexes]
        pieces = intersection(selection, candidates)
        pieces = pieces[(~is_empty(pieces)) & (area(pieces) > 0)]
        return disjoint_subset_union_all(pieces) if len(pieces) else None


def project(geometry):
    result = transform(TO_5070, polygonal(shape(geometry)))
    return result if result.is_valid else polygonal(make_valid(result))


def polygonal(geometry):
    if geometry.is_valid and geometry.geom_type in ('Polygon', 'MultiPolygon'):
        return geometry
    repaired = make_valid(geometry) if not geometry.is_valid else geometry
    if repaired.geom_type in ('Polygon', 'MultiPolygon'):
        return repaired
    parts = [part for part in getattr(repaired, 'geoms', ())
             if part.geom_type in ('Polygon', 'MultiPolygon')]
    if not parts:
        raise ValueError('geometry has no polygonal component')
    return union_all(parts)


def repair_feature_geometry(feature):
    source = shape(feature['geometry'])
    identifier = feature.get('id')
    if source.is_empty or source.area <= 0:
        raise ValueError(f'{identifier} geometry has no area')
    candidate = source if source.is_valid else polygonal(source)
    if candidate.is_empty or candidate.area <= 0:
        raise ValueError(f'{identifier} geometry has no area')
    encoded = mapping(candidate)
    roundtrip = shape(encoded)
    if not roundtrip.is_valid:
        candidate = polygonal(roundtrip)
        encoded = mapping(candidate)
        roundtrip = shape(encoded)
    if (roundtrip.geom_type not in ('Polygon', 'MultiPolygon')
            or not roundtrip.is_valid or roundtrip.is_empty or roundtrip.area <= 0):
        raise ValueError(
            f'{identifier} remains invalid after repair: {explain_validity(roundtrip)}')
    if encoded != feature['geometry']:
        feature['geometry'] = encoded
        feature['bbox'] = list(candidate.bounds)


def assert_valid_polygon(feature):
    geometry = shape(feature['geometry'])
    if (feature['geometry']['type'] not in ('Polygon', 'MultiPolygon')
            or geometry.geom_type not in ('Polygon', 'MultiPolygon')
            or not geometry.is_valid or geometry.is_empty or geometry.area <= 0):
        raise ValueError(
            f'{feature.get("id")} is not a valid positive-area polygon: '
            f'{explain_validity(geometry)}')


def fetch_hydro(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix('.partial')
    offset = 0
    with pending.open('w') as output:
        while True:
            params = dict(where='1=1', geometry=ENVELOPE,
                          geometryType='esriGeometryEnvelope', inSR='4326',
                          spatialRel='esriSpatialRelIntersects', outFields='OBJECTID',
                          orderByFields='OBJECTID',
                          returnGeometry='true', outSR='5070', geometryPrecision='0',
                          resultOffset=offset, resultRecordCount=1000, f='geojson')
            url = HYDRO_URL + '/query?' + urlencode(params)
            with urlopen(url, timeout=180) as response:
                data = json.load(response)
            if 'error' in data:
                raise RuntimeError(f'Census hydro query failed: {data["error"]}')
            features = data.get('features', [])
            if not features:
                break
            for feature in features:
                output.write(json.dumps(feature['geometry'], separators=(',', ':')) + '\n')
            offset += len(features)
            print(f'water polygons: {offset}', flush=True)
            if len(features) < 1000:
                break
    pending.replace(path)


def load_hydro(path: Path):
    if not path.exists():
        fetch_hydro(path)
    water = []
    with path.open() as source:
        for line in source:
            if not line.strip():
                continue
            geometry = shape(json.loads(line))
            if geometry.is_empty or geometry.area <= 0:
                continue
            repaired = geometry if geometry.is_valid else make_valid(geometry)
            water.append(polygonal(repaired))
    if not water:
        raise ValueError(f'hydro cache is empty or has no polygonal area: {path}')
    print(f'unioning {len(water)} water polygons', flush=True)
    return union_all(water)


def load_viewsheds(path: Path):
    dataset = ogr.Open(str(path))
    if dataset is None:
        raise FileNotFoundError(path)
    coverage_layer = dataset.GetLayerByName('camera_viewshed_coverage')
    if coverage_layer is None or coverage_layer.GetFeatureCount() != 1:
        raise ValueError('camera coverage layer must contain one dissolved feature')
    spatial_reference = coverage_layer.GetSpatialRef()
    if spatial_reference is None or spatial_reference.GetAuthorityCode(None) != '5070':
        raise ValueError('camera coverage layer must use EPSG:5070')
    coverage_feature = coverage_layer.GetNextFeature()
    if coverage_feature is None or coverage_feature.GetGeometryRef() is None:
        raise ValueError('camera coverage layer has no geometry')
    coverage = from_wkb(bytes(coverage_feature.GetGeometryRef().ExportToWkb()))
    individual = {}
    layer = dataset.GetLayerByName('camera_viewsheds')
    if layer is None:
        raise ValueError('camera viewshed layer is missing')
    for feature in layer:
        identifier = feature.GetField('viewshed_id')
        geometry_ref = feature.GetGeometryRef()
        if not identifier or geometry_ref is None or geometry_ref.IsEmpty():
            raise ValueError('camera viewshed has no ID or geometry')
        individual[identifier] = from_wkb(bytes(geometry_ref.ExportToWkb()))
    if len(individual) != layer.GetFeatureCount():
        raise ValueError('camera viewshed IDs must be unique')
    return dataset, coverage, individual


def load_category(path: Path, land):
    if not path.exists():
        return None
    features = json.loads(path.read_text())['features']
    geometries = [project(f['geometry']).intersection(land) for f in features]
    geometries = [g for g in geometries if not g.is_empty]
    return union_all(geometries) if geometries else None


def load_federal_categories(path: Path, land):
    features = json.loads(path.read_text())['features']
    grouped = {'National Park Service land': [],
               'U.S. Forest Service land': [], 'Other federal land': []}
    for feature in features:
        name = feature['properties']['name']
        # The source service also includes DOD and some OTHF proclamation
        # boundaries; fee-only versions of other agencies come from PAD-US Fee.
        if name in ('U.S. Department of Defense', 'Other federal fee manager'):
            continue
        label = ('National Park Service land' if name == 'National Park Service'
                 else 'U.S. Forest Service land' if name == 'U.S. Forest Service'
                 else 'Other federal land')
        grouped[label].append(project(feature['geometry']).intersection(land))
    return [(label, union_all(geometries)) for label, geometries in grouped.items()]


def load_padus_fee_categories(path: Path):
    if not path.exists():
        raise FileNotFoundError(f'{path}; run scripts/fetch-padus-fee.py first')
    labels = ('National Park Service land', 'U.S. Forest Service land',
              'Other federal land', *dict.fromkeys(FEE_LABELS.values()))
    grouped = {label: [] for label in labels}
    counts = {label: 0 for label in grouped}
    dropped = []
    with path.open() as stream:
        for line in stream:
            feature = json.loads(line)
            label = padus_fee_label(feature['properties'])
            if label is None:
                continue
            if feature['geometry'] is None:
                if feature['properties']['Own_Name'] != 'BLM':
                    raise ValueError(f"unexpected null PAD-US fee geometry: {feature['properties']['OBJECTID']}")
                dropped.append(feature['properties']['OBJECTID'])
                continue
            geometry = shape(feature['geometry'])
            if geometry.is_empty or geometry.area <= 0:
                dropped.append(feature['properties']['OBJECTID'])
                continue
            if not geometry.is_valid:
                try:
                    geometry = polygonal(make_valid(geometry))
                except (GEOSException, ValueError):
                    geometry = geometry.buffer(0)
            if geometry.is_empty or geometry.area <= 0:
                dropped.append(feature['properties']['OBJECTID'])
                continue
            grouped[label].append(geometry)
            counts[label] += 1
    print('PAD-US fee parcels by category:', counts, flush=True)
    if dropped:
        print('dropped zero-area PAD-US fee parcels:', dropped, flush=True)
    return [(label, CategoryIndex(geometries))
            for label, geometries in grouped.items() if geometries]


def area_sqkm(area_m2):
    value = round(area_m2 / 1e6, 3)
    if area_m2 > 0 and value == 0:
        return 0.001
    return value


def mix_for(geometry, total, designation):
    if total <= 0:
        return []
    rows = []
    claimed = []
    for label, category in designation:
        if category is None:
            continue
        raw_share = (category.intersection(geometry)
                 if isinstance(category, CategoryIndex)
                 else geometry.intersection(category))
        if raw_share is None or raw_share.is_empty:
            continue
        share = raw_share
        for earlier in claimed:
            if share.is_empty:
                break
            if share.intersects(earlier):
                share = share.difference(earlier)
        claimed.append(raw_share)
        if share.is_empty:
            continue
        area = max(0.0, share.area)
        if area:
            rows.append((label, area))
    rows.append(('Other/unclassified', max(0.0, total - sum(area for _, area in rows))))
    # Derive the remainder from rounded prior shares so printed figures total 100%.
    result = [{'label': label, 'percentage': round(area / total * 100, 2),
               'areaSqKm': area_sqkm(area)} for label, area in rows[:-1]]
    result.append({'label': 'Other/unclassified',
                   'percentage': round(100 - sum(row['percentage'] for row in result), 2),
                   'areaSqKm': area_sqkm(rows[-1][1])})
    return result


def coverage_metrics(selection, dissolved_coverage):
    area = selection.area
    if not math.isfinite(area) or area <= 0:
        raise ValueError('selected land area must be positive and finite')
    overlap = selection.intersection(dissolved_coverage)
    if not overlap.is_valid:
        overlap = make_valid(overlap)
    covered = min(area, max(0.0, overlap.area))
    return {
        'landAreaSqKm': area_sqkm(area),
        'cameraViewshedAreaSqKm': area_sqkm(covered) if covered else 0.0,
        'cameraViewshedCoveragePct': round(covered / area * 100, 2),
    }


def run(args):
    viewshed_dataset, coverage, individual = load_viewsheds(args.viewsheds)
    if viewshed_dataset is None:
        raise FileNotFoundError(args.viewsheds)
    print('loaded viewsheds:', len(individual), flush=True)
    mask = json.loads(args.mask.read_text())['features'][0]['geometry']
    coastal_land = project(mask)
    state_features = json.loads((DIVISIONS / 'state.geojson').read_text())['features']
    orwa = union_all([project(feature['geometry']) for feature in state_features])
    water = load_hydro(args.hydro_cache)
    land = coastal_land.intersection(orwa).difference(water)
    state_land = orwa.difference(water)
    if land.is_empty or land.area <= 0:
        raise RuntimeError('regional land footprint is empty')
    print('land footprint km²:', round(land.area / 1e6), flush=True)
    print('loading tribal reservation and trust boundaries', flush=True)
    tribal_area = load_category(DIVISIONS / 'tribal-land.geojson', state_land)
    print('loading federal fee ownership', flush=True)
    federal = dict(load_federal_categories(DIVISIONS / 'federal-land.geojson', state_land))
    print('loading PAD-US fee ownership', flush=True)
    fee_by_label = dict(load_padus_fee_categories(args.padus_fee_cache))
    for label in ('National Park Service land', 'U.S. Forest Service land',
                  'Other federal land'):
        federal[label] = CategoryIndex(
            [federal[label], *fee_by_label[label].geometries])
    designation_layers = [
        ('Tribal reservation/trust area', CategoryIndex([tribal_area])),
        ('Tribal fee land', fee_by_label['Tribal fee land']),
        *federal.items(),
        *((label, fee_by_label[label]) for label in (
            'State land', 'Local government land', 'Nonprofit open space',
            'Mapped private open space')),
    ]
    designation = designation_layers
    designation_sources = {
        'tribalArea': json.loads((DIVISIONS / 'tribal-land.geojson').read_text())['metadata']['source'],
        'federalFee': json.loads((DIVISIONS / 'federal-land.geojson').read_text())['metadata']['source'],
        'otherFee': PADUS_FEE_URL,
    }
    designation_note = ('Tribal reservation/trust area is a jurisdictional boundary. '
                        'All other named categories are mapped fee parcels; '
                        'Other/unclassified includes unmapped private land and source gaps.')
    inputs = {'coastalMaskSha256': digest(args.mask),
              'hydroSha256': digest(args.hydro_cache),
              'viewshedsSha256': digest(args.viewsheds),
              'padusFeeSha256': digest(args.padus_fee_cache)}
    kinds = tuple(args.only) if args.only else TYPES
    for kind in kinds:
        path = DIVISIONS / f'{kind}.geojson'
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        if not data['features']:
            continue
        retained = []
        skipped = []
        for i, feature in enumerate(data['features']):
            repair_feature_geometry(feature)
            assert_valid_polygon(feature)
            polygon = project(feature['geometry'])
            selected = polygon.intersection(land)
            area = selected.area
            if not math.isfinite(area) or area <= 0:
                # Generalized country coastlines can miss true OR/WA land by a few
                # hundred meters; keep those records against state land minus hydro.
                selected = polygon.intersection(state_land)
                area = selected.area
            if not math.isfinite(area) or area <= 0:
                if kind in ('national-forest', 'national-park', 'federal-land', 'tribal-land'):
                    skipped.append({
                        'id': feature['id'],
                        'name': feature.get('properties', {}).get('name'),
                        'reason': 'no land overlap with OR/WA coastal mask minus Census hydrography',
                    })
                    continue
                raise ValueError(f'{kind}:{feature["id"]} has no land area')
            p = feature['properties']
            p.update(coverage_metrics(selected, coverage))
            p['landMix'] = mix_for(selected, area, designation)
            retained.append(feature)
            if i % 25 == 0:
                print(kind, i + 1, '/', len(data['features']), flush=True)
        if skipped:
            print(f'{kind} skipped empty-land features: {skipped}', flush=True)
            data.setdefault('metadata', {})['excludedEmptyLandFeatures'] = skipped
        expected = EXPECTED_COUNTS.get(kind)
        if expected is not None and len(retained) != expected:
            raise RuntimeError(
                f'{kind}: expected {expected} features, retained {len(retained)}'
                + (f', skipped {skipped}' if skipped else ''))
        data['features'] = retained
        data.setdefault('metadata', {}).update({
            'schemaVersion': 1, 'metricsStatus': 'complete',
            'landFootprint': 'regional coastal mask minus Census areal hydrography',
            'hydroVintage': '2025-01-01', 'areaCrs': 'EPSG:5070',
            'overlapHandling': 'displayed dissolved camera viewshed coverage',
            'designationPriority': [label for label, _ in designation],
            'designationSources': designation_sources,
            'designationNote': designation_note,
            'designationGeometrySimplificationM': SIMPLIFY_TOLERANCE_M,
            'maxAcceptedSimplificationAreaChangePct': MAX_SIMPLIFY_AREA_CHANGE * 100,
            'inputSha256': inputs,
        })
        rendered = json.dumps(data, ensure_ascii=False, allow_nan=False,
                              separators=(',', ':')) + '\n'
        path.write_text(rendered)
        if kind == 'county':
            (DIVISIONS / 'counties.geojson').write_text(rendered)
        print(kind, 'complete', len(retained), flush=True)
    camera_data = json.loads(CAMERA_OUT.read_text()) if CAMERA_OUT.exists() else {'viewsheds': {}}
    viewsheds = camera_data.setdefault('viewsheds', {})
    for identifier, geometry in individual.items():
        selection = geometry.intersection(land)
        area = selection.area
        if not math.isfinite(area) or area <= 0:
            selection = geometry.intersection(state_land)
            area = selection.area
        result = viewsheds.setdefault(identifier, {})
        result.update({
            'landAreaSqKm': area_sqkm(area) if area > 0 else 0.0,
            'landMix': mix_for(selection, area, designation) if area > 0 else [],
            'coverageAvailable': True,
            'status': 'complete',
        })
        result.pop('coverageMessage', None)
    unavailable = []
    for identifier, result in viewsheds.items():
        if identifier in individual:
            continue
        result['coverageAvailable'] = False
        result['landAreaSqKm'] = None
        result['landMix'] = []
        result['coverageMessage'] = UNAVAILABLE_COVERAGE
        result.setdefault('status', 'unavailable')
        unavailable.append(identifier)
    camera_meta = {
        'schemaVersion': 1, 'areaCrs': 'EPSG:5070',
        'denominator': 'individual viewshed land footprint',
        'hydroVintage': '2025-01-01', 'inputSha256': inputs,
        'designationPriority': [label for label, _ in designation],
        'designationSources': designation_sources,
        'designationNote': designation_note,
        'designationGeometrySimplificationM': SIMPLIFY_TOLERANCE_M,
        'maxAcceptedSimplificationAreaChangePct': MAX_SIMPLIFY_AREA_CHANGE * 100,
        'coverageAvailableCount': len(individual),
        'unavailableViewsheds': sorted(unavailable),
    }
    camera_data['metadata'] = camera_meta
    pending = camera_data.get('coverageMetadata')
    if isinstance(pending, dict):
        pending.update(camera_meta)
        pending['status'] = 'complete'
        pending['note'] = (
            'Cameras without an individual viewshed stay Coverage unavailable; '
            'missing coverage is never stored as 0%.')
    CAMERA_OUT.write_text(json.dumps(camera_data, ensure_ascii=False,
                                     allow_nan=False, separators=(',', ':')) + '\n')
    if len(viewsheds) != 75:
        raise RuntimeError(f'expected 75 camera IDs, found {len(viewsheds)}')
    if len(individual) != 74:
        raise RuntimeError(f'expected 74 individual viewsheds, found {len(individual)}')
    print('camera viewsheds:', len(individual), 'unavailable:', unavailable, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--viewsheds', type=Path, default=VIEWSHEDS)
    parser.add_argument('--mask', type=Path, default=MASK)
    parser.add_argument('--hydro-cache', type=Path, default=HYDRO_CACHE)
    parser.add_argument('--padus-fee-cache', type=Path, default=PADUS_FEE_CACHE)
    parser.add_argument('--only', nargs='*', choices=TYPES,
                        help='limit division types; camera metrics still run')
    run(parser.parse_args())


if __name__ == '__main__':
    main()
