mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a';

const DEFAULT_VIEW = Object.freeze({
  center: Object.freeze([-120.55, 45.5]),
  zoom: 5.4,
});

const SATELLITE_ID = 'mapbox-satellite-basemap';
const DEFAULT_BASEMAP = 'outdoors';
const basemapChangeListeners = [];

const MAP_BOUNDS = [
  [-135, 38],
  [-106, 53],
];

export const mapReady = initializeMap();

export function onBasemapChange(listener) {
  basemapChangeListeners.push(listener);
  listener(selectedBasemap());
}

function selectedBasemap() {
  const checked = document.querySelector(
    '#basemap-picker input[name="basemap"]:checked'
  );
  return checked?.value ?? DEFAULT_BASEMAP;
}

async function initializeMap() {
  // Browsers may restore the last radio-button value after a reload. The map
  // itself always starts with the default style, so reset the control before
  // any listeners use it to set viewshed symbology.
  resetBasemapPicker();

  const style = await loadMapStyle();
  removeDuplicateTerrainDem(style);
  enableContourLineMetrics(style);
  addSatelliteBasemap(style);

  const map = new mapboxgl.Map({
    container: 'map',
    style: null,
    projection: 'mercator',
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    minZoom: 5,
    // maxZoom: 12,
    maxBounds: MAP_BOUNDS,
    attributionControl: false,
    performanceMetricsCollection: false,
  });

  map.on('load', () => {
    map.addSource('mapbox-dem', {
        'type': 'raster-dem',
        'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
        'tileSize': 512,
        'maxzoom': 14
    });
    map.setTerrain({ 
        'source': 'mapbox-dem', 
        'exaggeration': [
          'interpolate', ['exponential', 0.5],
          ['zoom'], 
          5, 0.2,
          12, 1.6
        ]
    });
    map.setFog({
      range: [1, 5], // first is the number where fog starts to become more opaque, second is full opaque
    })
  });


  // full style install can emit errors before initialization finishes
  map.on('error', handleMapError);
  map.setStyle(style, { diff: false });
  map.addControl(
    new mapboxgl.NavigationControl({ showCompass: true, showZoom: true }),
    'top-left'
  );
  map.addControl(new HomeControl(), 'top-left');
  map.addControl(new mapboxgl.AttributionControl({
    customAttribution: '<a href="https://infographics.uoregon.edu/" target="_blank" rel="noopener noreferrer">UO InfoGraphics Lab</a> | <a href="https://ohaz.uoregon.edu/" target="_blank" rel="noopener noreferrer">OHAZ</a>'
  }));
  initZoomViewer(map);
  map.once('load', () => initBasemapPicker(map));

  return map;
}

function initZoomViewer(map) {
  const viewer = document.getElementById('zoom-viewer');
  if (!viewer) throw new Error('Zoom viewer #zoom-viewer is missing');

  const updateZoom = () => {
    viewer.textContent = `zoom: ${map.getZoom().toFixed(1)}`;
  };

  updateZoom();
  map.on('zoom', updateZoom);
}

class HomeControl {
  onAdd(map) {
    this.map = map;

    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

    const button = document.createElement('button');
    button.className = 'mapboxgl-ctrl-home';
    button.type = 'button';
    button.title = 'Reset to the default map extent';
    button.setAttribute('aria-label', button.title);

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-earth-americas';
    icon.setAttribute('aria-hidden', 'true');
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

  // Explicitly establish the startup state as well as the input state. This
  // keeps the control and the rendered basemap in sync even when the browser
  // restores form values during a reload.
  resetBasemapPicker();
  map.setLayoutProperty(SATELLITE_ID, 'visibility', 'none');

  picker.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'basemap') return;

    map.setLayoutProperty(
      SATELLITE_ID,
      'visibility',
      input.value === 'satellite' ? 'visible' : 'none'
    );

    for (const listener of basemapChangeListeners) listener(input.value);
  });
}

function resetBasemapPicker() {
  const defaultInput = document.querySelector(
    `#basemap-picker input[name="basemap"][value="${DEFAULT_BASEMAP}"]`
  );
  if (defaultInput) defaultInput.checked = true;
}

// satellite is a topmost base-style layer; application layers load above
function addSatelliteBasemap(style) {
  style.sources ||= {};
  style.layers ||= [];
  style.sources[SATELLITE_ID] = {
    type: 'raster',
    url: 'mapbox://mapbox.satellite',
    tileSize: 256,
  };
  style.layers.push({
    id: SATELLITE_ID,
    type: 'raster',
    source: SATELLITE_ID,
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
  const isEmptyVectorTile =
    error?.status === 404 &&
    typeof error?.url === 'string' &&
    error.url.includes('.vector.pbf');

  // ignore confirmed worker noise while surfacing actionable errors
  if (isStaleWorkerTransfer || isKnownStyleImageDecodeNoise || isEmptyVectorTile) {
    return;
  }

  console.error('mapbox error:', error);
}

// fetch style as JSON so duplicate terrain sources can be repaired
async function loadMapStyle() {
  const encodedToken = encodeURIComponent(mapboxgl.accessToken);
  const styleUrl = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}?access_token=${encodedToken}`;
  const response = await fetch(styleUrl);

  if (!response.ok) {
    throw new Error(`Mapbox style HTTP ${response.status}`);
  }

  return response.json();
}

function enableContourLineMetrics(style) {
  const contourSource = style.sources?.['mapbox://mapbox.mapbox-terrain-v2-contour'];
  if (contourSource?.type === 'vector') {
    contourSource.lineMetrics = true;
  }
}

// remove redundant terrain DEM while preserving any hillshade that shares it
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
