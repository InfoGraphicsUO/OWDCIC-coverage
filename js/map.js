mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

// Mapbox account/style slug for the Outdoors-based map theme
const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a';

// padded southwest and northeast corners keep navigation near Oregon
// coordinates stay in Mapbox [longitude, latitude] order
const MAP_BOUNDS = [
  [-128.72734, 40.01772],
  [-113.24871, 49.00722],
];

// shared initialization lets downstream modules reuse the same map instance
export const mapReady = initializeMap();

// builds the map from a repaired copy of the hosted style
async function initializeMap() {
  // repair source conflicts before Mapbox sends the style to its workers
  const style = await loadMapStyle();
  removeDuplicateTerrainDem(style);

  // delay style processing until the error handler is attached below
  const map = new mapboxgl.Map({
    container: 'map',
    style: null,
    projection: 'mercator',
    center: [-120.558, 43.933],
    zoom: 7,
    minZoom: 6.5,
    maxBounds: MAP_BOUNDS,
  });

  // full style install can emit errors before initialization finishes
  map.on('error', handleMapError);
  map.setStyle(style, { diff: false });
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  return map;
}

function handleMapError(event) {
  const error = event.error;
  const isStaleWorkerTransfer =
    error?.name === 'InvalidStateError' &&
    error.message?.includes('no longer, usable');

  // ignore Mapbox stale worker-transfer noise but surface every other error
  if (isStaleWorkerTransfer) return;

  console.error('mapbox error:', error);
}

// fetches the style as JSON so duplicate terrain sources can be repaired
async function loadMapStyle() {
  const encodedToken = encodeURIComponent(mapboxgl.accessToken);
  const styleUrl = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}?access_token=${encodedToken}`;
  const response = await fetch(styleUrl);

  if (!response.ok) {
    throw new Error(`Mapbox style HTTP ${response.status}`);
  }

  return response.json();
}

// removes a redundant terrain DEM while preserving any hillshade that shares it
function removeDuplicateTerrainDem(style) {
  const terrainSourceId = style.terrain?.source;
  const terrainSource = style.sources?.[terrainSourceId];
  if (!terrainSourceId || terrainSource?.type !== 'raster-dem') return;

  // matching URL and tile size identify another source for the same DEM tiles
  const hasDuplicateDem = Object.entries(style.sources).some(
    ([sourceId, source]) =>
      sourceId !== terrainSourceId &&
      source.type === terrainSource.type &&
      source.url === terrainSource.url &&
      source.tileSize === terrainSource.tileSize
  );

  if (!hasDuplicateDem) return;

  // keep the duplicate source available for hillshade layers
  delete style.terrain;

  // source can go too when no ordinary layer still references it
  const terrainSourceIsUsed = (style.layers || []).some(
    (layer) => layer.source === terrainSourceId
  );

  if (!terrainSourceIsUsed) delete style.sources[terrainSourceId];
}
