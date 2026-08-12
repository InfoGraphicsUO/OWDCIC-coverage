mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a'; // mapbox outdoors preset
const mapReady = initializeMap();

async function initializeMap() {
  const style = await loadMapStyle();
  removeDuplicateTerrainDem(style);

  const map = new mapboxgl.Map({
    container: 'map',
    style: null,
    projection: 'mercator',
    center: [-120.558, 43.933],
    zoom: 7,
    minZoom: 6.5,
    maxBounds: [ // oregon bounds
      [-128.72734, 40.01772],
      [-113.24871, 49.00722],
    ],
  });

  // register before setstyle so no console error spam from mapbox
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

  if (isStaleWorkerTransfer) return;

  console.error('mapbox error:', error);
}

async function loadMapStyle() {
  // fetch style as json so invalid source definitions can be corrected
  const styleUrl = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}?access_token=${encodeURIComponent(mapboxgl.accessToken)}`;
  const response = await fetch(styleUrl);

  if (!response.ok) {
    throw new Error(`Mapbox style HTTP ${response.status}`);
  }

  return response.json();
}

function removeDuplicateTerrainDem(style) {
  // detect when terrain and hillshade use the same dem tiles
  const terrainSourceId = style.terrain?.source;
  const terrainSource = style.sources?.[terrainSourceId];
  if (!terrainSourceId || terrainSource?.type !== 'raster-dem') return;

  const hasDuplicateDem = Object.entries(style.sources).some(
    ([sourceId, source]) =>
      sourceId !== terrainSourceId &&
      source.type === terrainSource.type &&
      source.url === terrainSource.url &&
      source.tileSize === terrainSource.tileSize
  );

  if (!hasDuplicateDem) return;

  // keep hillshade and remove the duplicate 3d terrain worker path
  delete style.terrain;

  const terrainSourceIsUsed = (style.layers || []).some(
    (layer) => layer.source === terrainSourceId
  );
  if (!terrainSourceIsUsed) delete style.sources[terrainSourceId];
}
