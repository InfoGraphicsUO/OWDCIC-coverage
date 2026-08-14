mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

// Mapbox account/style slug for the Outdoors-based map theme
const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a';

const DEFAULT_VIEW = Object.freeze({
  center: Object.freeze([-120.558, 44.133]),
  zoom: 6.5,
});

const SATELLITE_SOURCE_ID = 'mapbox-satellite-basemap';
const SATELLITE_LAYER_ID = 'mapbox-satellite-basemap';

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
  addSatelliteBasemap(style);

  // delay style processing until the error handler is attached below
  const map = new mapboxgl.Map({
    container: 'map',
    style: null,
    projection: 'mercator',
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    minZoom: 6,
    maxBounds: MAP_BOUNDS,
    attributionControl: false,
    performanceMetricsCollection: false,
  });

  // full style install can emit errors before initialization finishes
  map.on('error', handleMapError);
  map.setStyle(style, { diff: false });
  map.addControl(
    new mapboxgl.NavigationControl({ showCompass: false, showZoom: true }),
    'top-left'
  );
  map.addControl(new HomeControl(), 'top-left');
  map.addControl(new mapboxgl.AttributionControl({
    customAttribution: '<a href="https://infographics.uoregon.edu/">UO InfoGraphics Lab</a> | <a href="https://ohaz.uoregon.edu/">OHAZ</a>'
  }));
  map.once('load', () => initBasemapPicker(map));

  return map;
}

class HomeControl {
  onAdd(map) {
    this.map = map;

    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

    const button = document.createElement('button');
    button.className = 'mapboxgl-ctrl-home';
    button.type = 'button';
    button.title = 'Reset to the default Oregon extent';
    button.setAttribute('aria-label', button.title);

    const icon = document.createElement('img');
    icon.src = 'img/oregon.svg';
    icon.alt = '';
    button.append(icon);
    button.addEventListener('click', () => resetMapView(map));

    container.append(button);
    this.container = container;
    return container;
  }

  onRemove() {
    this.container?.remove();
    this.map = undefined;
  }
}

function resetMapView(map) {
  map.easeTo({
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    bearing: 0,
    pitch: 0,
    duration: 700,
  });
}

function initBasemapPicker(map) {
  const picker = document.getElementById('basemap-picker');
  if (!picker) throw new Error('Basemap picker #basemap-picker is missing');

  picker.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'basemap') return;

    map.setLayoutProperty(
      SATELLITE_LAYER_ID,
      'visibility',
      input.value === 'satellite' ? 'visible' : 'none'
    );
  });
}

// satellite is a topmost base-style layer; application layers load above it
function addSatelliteBasemap(style) {
  style.sources ||= {};
  style.layers ||= [];
  style.sources[SATELLITE_SOURCE_ID] = {
    type: 'raster',
    url: 'mapbox://mapbox.satellite',
    tileSize: 256,
  };
  style.layers.push({
    id: SATELLITE_LAYER_ID,
    type: 'raster',
    source: SATELLITE_SOURCE_ID,
    layout: { visibility: 'none' },
  });
}

function handleMapError(event) {
  const error = event.error;
  const isStaleWorkerTransfer =
    error?.name === 'InvalidStateError' &&
    error.message?.includes('no longer, usable');
  const isKnownStyleImageDecodeNoise =
    error instanceof DOMException &&
    error.message === 'The image could not be decoded';

  // ignore confirmed worker noise while continuing to surface actionable errors
  if (isStaleWorkerTransfer || isKnownStyleImageDecodeNoise) return;

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
