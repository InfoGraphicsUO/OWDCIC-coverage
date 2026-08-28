import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import { DATA_URLS, LAYER_IDS, emptyFeatureCollection } from './config.js';

const OUTSIDE_HATCH_IMAGE_ID = 'outside-region-hatch';
const HATCH_SIZE = 32;
const HATCH_SPACING = 16;
const HATCH_LINE_WIDTH = 2;
const SHARED_EDGE_TOLERANCE = 0.003;
const SHARED_EDGE_MIN_DIRECTION_COSINE = 0.9;

// states that intersect or sit immediately around the map's constrained bounds
const WESTERN_STATE_FIPS = Object.freeze([
  '04', '06', '08', '16', '30', '32', '41', '49', '53', '56',
]);
const REGION_STATE_FIPS = new Set(['41', '53']);

// fetches light Census boundaries for the two-state region rendering
export async function loadRegionFocusData() {
  const [boundary, countries] = await Promise.all([
    fetchArcGISGeoJSON(DATA_URLS.censusStateBoundaries, {
      where: `STATE IN (${WESTERN_STATE_FIPS.map((fips) => `'${fips}'`).join(',')})`,
      outFields: 'STATE,GEOID',
      orderByFields: 'OID',
      // 5 decimal places plus 0.002 degree offset trim statewide payload
      geometryPrecision: '5',
      maxAllowableOffset: '0.002',
    }),
    fetchArcGISGeoJSON(DATA_URLS.worldCountries, {
      where: "ISO='CA'",
      outFields: 'ISO',
      orderByFields: 'FID',
      geometryPrecision: '5',
      maxAllowableOffset: '0.002',
    }),
  ]);

  return buildRegionFocusData(boundary, countries);
}

// adds the outside-region hatch and combined outline above the basemap
export function addRegionFocusLayers(map) {
  registerOutsideHatch(map);

  map.addSource(LAYER_IDS.regionFocusSource, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });

  // basemap symbols and models below vanish outside Oregon and Washington
  map.addLayer({
    id: LAYER_IDS.outsideRegionClip,
    type: 'clip',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    layout: {
      'clip-layer-types': ['symbol', 'model'],
    },
  });

  // no slot keeps the hatch above imported highway shields
  map.addLayer({
    id: LAYER_IDS.outsideRegionFill,
    type: 'fill',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    paint: {
      'fill-pattern': OUTSIDE_HATCH_IMAGE_ID,
      'fill-opacity': 0.62,
      'fill-antialias': false,
    },
  });

  map.addLayer({
    id: LAYER_IDS.regionOutline,
    type: 'line',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outline'],
    paint: {
      'line-color': '#2f2e2e',
      // screen-pixel width gets a modest boost while zooming
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5, 3,
        9, 5.5,
        13, 7,
      ],
      'line-opacity': 0.68,
      'line-emissive-strength': 0.65,
    },
  });
}

// creates a seamless bitmap pattern without muting the basemap between lines
function registerOutsideHatch(map) {
  if (map.hasImage(OUTSIDE_HATCH_IMAGE_ID)) return;

  const data = new Uint8Array(HATCH_SIZE * HATCH_SIZE * 4);

  for (let y = 0; y < HATCH_SIZE; y += 1) {
    for (let x = 0; x < HATCH_SIZE; x += 1) {
      if ((x + y) % HATCH_SPACING >= HATCH_LINE_WIDTH) continue;

      const offset = (y * HATCH_SIZE + x) * 4;
      data[offset] = 95;
      data[offset + 1] = 98;
      data[offset + 2] = 102;
      data[offset + 3] = 255;
    }
  }

  map.addImage(
    OUTSIDE_HATCH_IMAGE_ID,
    { width: HATCH_SIZE, height: HATCH_SIZE, data },
    { pixelRatio: 2 }
  );
}

// marks neighboring states for hatching and keeps only the region's exterior line
export function buildRegionFocusData(boundary, countries = emptyFeatureCollection()) {
  const stateFeatures = (boundary.features || []).filter((feature) =>
    ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  );
  const regionStates = stateFeatures.filter((feature) =>
    REGION_STATE_FIPS.has(stateFips(feature))
  );

  if (regionStates.length !== REGION_STATE_FIPS.size) {
    throw new Error('Oregon or Washington boundary geometry is missing');
  }

  const outsideStates = stateFeatures
    .filter((feature) => !REGION_STATE_FIPS.has(stateFips(feature)))
    .map((feature) => withKind(feature, 'outside'));
  const outsideCountries = (countries.features || [])
    .filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))
    .map((feature) => withKind(feature, 'outside'));

  return {
    type: 'FeatureCollection',
    features: [
      ...outsideStates,
      ...outsideCountries,
      ...regionStates.map((feature) => withKind(feature, 'region')),
      {
        type: 'Feature',
        properties: { kind: 'outline' },
        geometry: exteriorBoundary(regionStates),
      },
    ],
  };
}

function stateFips(feature) {
  return feature.properties?.STATE || feature.properties?.GEOID;
}

// Census state polygons may split and simplify the same shared edge differently
function exteriorBoundary(features) {
  const ringsByFeature = features.map(featureRings);
  const segmentsByFeature = ringsByFeature.map((rings) =>
    rings.flatMap((ring) => ringSegments(ring))
  );

  return {
    type: 'MultiLineString',
    coordinates: ringsByFeature.flatMap((rings, featureIndex) =>
      rings.flatMap((ring) =>
        exteriorRingParts(ring, featureIndex, segmentsByFeature)
      )
    ),
  };
}

function featureRings(feature) {
  const coordinates = feature.geometry.coordinates || [];
  return feature.geometry.type === 'Polygon' ? coordinates : coordinates.flat();
}

function ringSegments(ring) {
  return ring.slice(0, -1).map((start, index) => [start, ring[index + 1]]);
}

function exteriorRingParts(ring, featureIndex, segmentsByFeature) {
  if (ring.length < 2) return [];

  const exterior = ring.slice(0, -1).map((start, index) =>
    !isSharedEdge(start, ring[index + 1], featureIndex, segmentsByFeature)
  );
  const firstInternal = exterior.indexOf(false);

  // closed island or coastline ring has no shared state-border segment
  if (firstInternal === -1) return [ring];

  const parts = [];
  let part = [];

  // start after an internal segment to keep the wraparound run together
  for (let step = 1; step <= exterior.length; step += 1) {
    const index = (firstInternal + step) % exterior.length;

    if (exterior[index]) {
      if (part.length === 0) part.push(ring[index]);
      part.push(ring[index + 1]);
    } else if (part.length > 1) {
      parts.push(part);
      part = [];
    }
  }

  if (part.length > 1) parts.push(part);
  return parts;
}

function isSharedEdge(start, end, featureIndex, segmentsByFeature) {
  const midpoint = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
  ];

  return segmentsByFeature.some((segments, otherFeatureIndex) =>
    otherFeatureIndex !== featureIndex && segments.some(([otherStart, otherEnd]) =>
      pointFallsAlongSegment(midpoint, otherStart, otherEnd) &&
      segmentsAreAligned(start, end, otherStart, otherEnd)
    )
  );
}

function pointFallsAlongSegment(point, start, end) {
  const tolerance = SHARED_EDGE_TOLERANCE;
  if (
    point[0] < Math.min(start[0], end[0]) - tolerance ||
    point[0] > Math.max(start[0], end[0]) + tolerance ||
    point[1] < Math.min(start[1], end[1]) - tolerance ||
    point[1] > Math.max(start[1], end[1]) + tolerance
  ) {
    return false;
  }

  const segmentX = end[0] - start[0];
  const segmentY = end[1] - start[1];
  const lengthSquared = segmentX ** 2 + segmentY ** 2;
  if (lengthSquared === 0) return false;

  const projection = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * segmentX + (point[1] - start[1]) * segmentY) /
      lengthSquared
  ));
  const nearestX = start[0] + projection * segmentX;
  const nearestY = start[1] + projection * segmentY;

  return (point[0] - nearestX) ** 2 + (point[1] - nearestY) ** 2 <= tolerance ** 2;
}

function segmentsAreAligned(start, end, otherStart, otherEnd) {
  const segmentX = end[0] - start[0];
  const segmentY = end[1] - start[1];
  const otherX = otherEnd[0] - otherStart[0];
  const otherY = otherEnd[1] - otherStart[1];
  const dotProduct = segmentX * otherX + segmentY * otherY;
  const lengthProductSquared =
    (segmentX ** 2 + segmentY ** 2) * (otherX ** 2 + otherY ** 2);

  return dotProduct ** 2 >=
    lengthProductSquared * SHARED_EDGE_MIN_DIRECTION_COSINE ** 2;
}

function withKind(feature, kind) {
  return {
    ...feature,
    properties: { ...feature.properties, kind },
  };
}
