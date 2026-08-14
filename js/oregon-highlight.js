import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import { DATA_URLS, LAYER_IDS, emptyFeatureCollection } from './config.js';

const OUTSIDE_HATCH_IMAGE_ID = 'outside-oregon-hatch';
const HATCH_SIZE = 32;
const HATCH_SPACING = 16;
const HATCH_LINE_WIDTH = 2;

// states that intersect or sit immediately around the map's constrained bounds
const WESTERN_STATE_FIPS = Object.freeze([
  '04', '06', '08', '16', '30', '32', '41', '49', '53', '56',
]);

// fetches a light Census boundary for statewide rendering
export async function loadOregonFocusData() {
  const boundary = await fetchArcGISGeoJSON(DATA_URLS.censusOregonBoundary, {
    where: `STATE IN (${WESTERN_STATE_FIPS.map((fips) => `'${fips}'`).join(',')})`,
    outFields: 'STATE,GEOID',
    orderByFields: 'OID',
    // 5 decimal places plus 0.002 degree offset trim statewide payload
    geometryPrecision: '5',
    maxAllowableOffset: '0.002',
  });

  return buildOregonFocusData(boundary);
}

// adds the outside-Oregon hatch and state outline above the loaded basemap
export function addOregonFocusLayers(map) {
  registerOutsideHatch(map);

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

  // no slot keeps the hatch above imported highway shields
  map.addLayer({
    id: LAYER_IDS.outsideOregonFill,
    type: 'fill',
    source: LAYER_IDS.oregonFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    paint: {
      'fill-pattern': OUTSIDE_HATCH_IMAGE_ID,
      'fill-opacity': 0.62,
      'fill-antialias': false,
    },
  });

  map.addLayer({
    id: LAYER_IDS.oregonOutline,
    type: 'line',
    source: LAYER_IDS.oregonFocusSource,
    filter: ['==', ['get', 'kind'], 'oregon'],
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

// marks actual state polygons so the hatch stops cleanly at the coastline
export function buildOregonFocusData(boundary) {
  const stateFeatures = (boundary.features || []).filter((feature) =>
    ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  );
  const oregon = stateFeatures.find((feature) =>
    feature.properties?.STATE === '41' || feature.properties?.GEOID === '41'
  );

  if (!oregon) {
    throw new Error('Oregon boundary geometry is missing');
  }

  const outsideStates = stateFeatures
    .filter((feature) => feature !== oregon)
    .map((feature) => withKind(feature, 'outside'));

  return {
    type: 'FeatureCollection',
    features: [
      ...outsideStates,
      withKind(oregon, 'oregon'),
    ],
  };
}

function withKind(feature, kind) {
  return {
    ...feature,
    properties: { ...feature.properties, kind },
  };
}
