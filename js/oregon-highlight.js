import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import { DATA_URLS, LAYER_IDS, emptyFeatureCollection } from './config.js';

// Mercator stops at 85 degrees so mask stays inside projection limits
const WORLD_RING = Object.freeze([
  Object.freeze([-180, -85]),
  Object.freeze([180, -85]),
  Object.freeze([180, 85]),
  Object.freeze([-180, 85]),
  Object.freeze([-180, -85]),
]);

// fetches a light Census boundary for statewide rendering
export async function loadOregonFocusData() {
  const boundary = await fetchArcGISGeoJSON(DATA_URLS.censusOregonBoundary, {
    where: "STATE='41'",
    outFields: 'GEOID',
    orderByFields: 'OID',
    // 5 decimal places plus 0.002 degree offset trim statewide payload
    geometryPrecision: '5',
    maxAllowableOffset: '0.002',
  });

  return buildOregonFocusData(boundary);
}

// adds clip gray mask and outline above loaded basemap
export function addOregonFocusLayers(map) {
  map.addSource(LAYER_IDS.oregonFocusSource, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });

  // basemap symbols and models below vanish outside Oregon
  map.addLayer({
    id: LAYER_IDS.outsideOregonClip,
    type: 'clip',
    source: LAYER_IDS.oregonFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    layout: {
      'clip-layer-types': ['symbol', 'model'],
    },
  });

  // no slot keeps gray above imported highway shields
  map.addLayer({
    id: LAYER_IDS.outsideOregonFill,
    type: 'fill',
    source: LAYER_IDS.oregonFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    paint: {
      'fill-color': '#a8adb4',
      'fill-opacity': 0.42,
      'fill-emissive-strength': 0.4,
    },
  });

  map.addLayer({
    id: LAYER_IDS.oregonOutline,
    type: 'line',
    source: LAYER_IDS.oregonFocusSource,
    filter: ['==', ['get', 'kind'], 'oregon'],
    paint: {
      'line-color': '#2f7d4b',
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

// builds outside mask and state outline from Census geometry
export function buildOregonFocusData(boundary) {
  const geometry = boundary.features?.find((feature) =>
    ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  )?.geometry;

  if (!geometry) {
    throw new Error('Oregon boundary geometry is missing');
  }

  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates;

  // each Oregon exterior becomes a clockwise hole in world mask
  const oregonHoles = polygons
    .map((polygon) => polygon[0])
    .filter((ring) => Array.isArray(ring) && ring.length >= 4)
    .map((ring) => orientRing(ring, true));

  if (oregonHoles.length === 0) {
    throw new Error('Oregon boundary has no usable exterior rings');
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'outside' },
        geometry: {
          type: 'Polygon',
          coordinates: [WORLD_RING, ...oregonHoles],
        },
      },
      {
        type: 'Feature',
        properties: { kind: 'oregon' },
        geometry,
      },
    ],
  };
}

function orientRing(ring, clockwise) {
  // copied coordinates leave shared boundary response untouched
  const orientedRing = ring.map((coordinate) => [...coordinate]);
  const isClockwise = signedRingArea(orientedRing) < 0;

  return isClockwise === clockwise ? orientedRing : orientedRing.reverse();
}

function signedRingArea(ring) {
  // shoelace area sign gives winding in longitude-latitude space
  let twiceArea = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }

  return twiceArea / 2;
}
