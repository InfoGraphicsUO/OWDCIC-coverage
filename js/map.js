import { restoreMarkerIcons } from './marker-icons.js?v=20260922simple1';
import { registerOutsideHatch } from './states-highlight.js?v=20260922simple1';

mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

// style id stays separate from the tokenized request URL
const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a';
const SIMPLE_MAPBOX_STYLE = 'infographics/cmud7fy6n000a01rghxd37aiz';

// center arrays use longitude first, then latitude
const DEFAULT_VIEW = Object.freeze({
  center: Object.freeze([-120.55, 45.5]),
  zoom: 5.4,
});

const SATELLITE_ID = 'mapbox-satellite-basemap';
const DEFAULT_BASEMAP = 'outdoors';
const BASEMAP_STYLE_IDS = Object.freeze({
  outdoors: MAPBOX_STYLE,
  simple: SIMPLE_MAPBOX_STYLE,
});
// listeners receive the startup selection and every later picker change
const basemapChangeListeners = [];
let activeBasemap = DEFAULT_BASEMAP;
let activeBaseStyle = DEFAULT_BASEMAP;
let activeBaseLayerIds = new Set();
let activeBaseSourceIds = new Set();
let basemapRequest = 0;
let basemapStylePending = false;

export const MAP_HOME_EVENT = 'apphome';
const NARROW_LAYOUT_QUERY = '(max-width: 900px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const MAP_BOUNDS = [
  [-135, 38],
  [-106, 53],
];

// layer setup waits on this shared map promise
export const mapReady = initializeMap();

// subscribe to basemap changes and receive the current value right away
export function onBasemapChange(listener) {
  basemapChangeListeners.push(listener);
  // apply the current mode now so late layers get matching colors immediately
  listener(selectedBasemap());
}

// returns zero for reduced motion, otherwise keeps the duration in ms
export function motionDuration(ms) {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : ms;
}

// returns CSS pixel padding to clear the sidebar and results panel at each breakpoint
export function mapPanelPadding(map) {
  const container = map.getContainer();
  const sidebar = document.getElementById('control-sidebar');
  const results = document.getElementById('results-panel');
  const railWidth = sidebar?.querySelector('.control-rail')?.getBoundingClientRect().width ?? 0;
  const bodyWidth = sidebar?.querySelector('.control-shell__body')?.getBoundingClientRect().width ?? 0;
  const panelGap = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--panel-gap')
  ) || 0;
  const shellWidth = railWidth + panelGap +
    (sidebar?.classList.contains('is-collapsed') ? 0 : bodyWidth);
  // hidden panels should not reserve space in the camera viewport
  const resultsVisible = Boolean(
    results && !results.hidden && results.getAttribute('aria-hidden') !== 'true'
  );
  // each desktop panel may use at most two-fifths of the map width
  const widthCap = container.clientWidth * 0.4;
  // reserve 120px of map height when the viewport allows it
  const heightCap = Math.max(32, container.clientHeight - 120);

  if (!window.matchMedia(NARROW_LAYOUT_QUERY).matches) {
    // desktop panels occupy opposite sides of the map
    const resultsWidth = resultsVisible ? results.getBoundingClientRect().width : 0;
    return {
      top: 48,
      bottom: 48,
      left: Math.min(shellWidth + 28, widthCap),
      right: Math.min(resultsWidth + 28, widthCap),
    };
  }

  // mobile panels stack along the bottom and left edges
  const resultsHeight = resultsVisible ? results.getBoundingClientRect().height : 0;
  return {
    top: 24,
    right: 24,
    bottom: resultsHeight
      ? Math.min(resultsHeight + 16, heightCap)
      : 32,
    // the narrow layout gives the sidebar a tighter width budget
    left: Math.max(24, Math.min(shellWidth + 16, container.clientWidth * 0.35)),
  };
}

function selectedBasemap() {
  const checked = document.querySelector(
    '#basemap-picker input[name="basemap"]:checked'
  );
  // the style itself starts outdoors even when the picker is absent
  return checked?.value ?? DEFAULT_BASEMAP;
}

async function initializeMap() {
  // browser-restored radio state can disagree with the default style
  // reset it before listeners use the value for viewshed symbology
  resetBasemapPicker();

  // edit the style JSON before Mapbox installs its sources and layers
  const style = prepareBasemapStyle(await loadMapStyle(DEFAULT_BASEMAP));
  recordBaseStyle(style);

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
    // map exports read pixels back from this canvas
    preserveDrawingBuffer: true,
    performanceMetricsCollection: false,
  });

  // elevation and fog wait for the map load event because the DEM source is map-owned
  // terrain uses a separate DEM source so its zoom exaggeration can be tuned
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
          // fade relief in at regional zooms and strengthen it on close views
          'interpolate', ['exponential', 0.5],
          ['zoom'], 
          5, 0.2,
          12, 1.6
        ]
    });
    map.setFog({
      range: [1, 5], // first value starts opacity, second reaches full opacity
    })
  });


  // attach the style error listener before asking Mapbox to install the JSON
  // style installation can emit errors while the map is still initializing
  map.on('error', handleMapError);
  map.on('style.load', () => {
    registerOutsideHatch(map);
    restoreMarkerIcons(map).catch((error) => {
      console.error('Failed to restore map marker icons:', error);
    });
  });
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
  map.once('load', () => {
    initBasemapPicker(map);
    initControlShellSync(map);
    // account for the panels before the first view is drawn
    map.jumpTo({
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom,
      padding: mapPanelPadding(map),
    });
  });

  return map;
}

function initControlShellSync(map) {
  const sidebar = document.getElementById('control-sidebar');
  if (!sidebar) return;

  const refreshPadding = () => {
    // padding changes can interrupt an active drag or camera animation
    if (!map.isMoving()) {
      map.setPadding(mapPanelPadding(map));
    }
  };

  // wait for collapse and tab layout changes before measuring panel widths
  sidebar.querySelector('.control-shell__collapse')?.addEventListener('click', () => {
    requestAnimationFrame(refreshPadding);
  });
  for (const tab of sidebar.querySelectorAll('[data-control-tab]')) {
    tab.addEventListener('click', () => requestAnimationFrame(refreshPadding));
  }
}

function initZoomViewer(map) {
  const viewer = document.getElementById('zoom-viewer');
  if (!viewer) throw new Error('Zoom viewer #zoom-viewer is missing');

  const updateZoom = () => {
    // keep one decimal place so small wheel steps remain visible
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
    // Mapbox may remove the control when rebuilding its UI
    this.container?.remove();
    this.map = undefined;
  }
}

function resetMapView(map) {
  // listeners clear the active filter before the camera returns home
  map.fire(MAP_HOME_EVENT);

  map.easeTo({
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    bearing: 0,
    pitch: 0,
    duration: motionDuration(700),
    padding: mapPanelPadding(map),
  });
}

function initBasemapPicker(map) {
  const picker = document.getElementById('basemap-picker');
  if (!picker) throw new Error('Basemap picker #basemap-picker is missing');

  // reset browser-restored input state to match the style loaded at startup
  resetBasemapPicker();
  // satellite imagery is an overlay; outdoors stays supplied by the base style
  map.setLayoutProperty(SATELLITE_ID, 'visibility', 'none');

  picker.addEventListener('change', (event) => {
    const input = event.target;
    // ignore bubbled events from unrelated inputs or unavailable basemaps
    if (!(input instanceof HTMLInputElement) || input.name !== 'basemap') return;
    if (input.disabled || !['outdoors', 'satellite', 'simple'].includes(input.value)) return;

    void changeBasemap(map, picker, input.value);
  });
}

async function changeBasemap(map, picker, basemap) {
  const request = ++basemapRequest;
  const styleName = basemap === 'satellite' ? DEFAULT_BASEMAP : basemap;

  if (styleName === activeBaseStyle && !basemapStylePending) {
    activeBasemap = basemap;
    setSatelliteVisibility(map, basemap);
    notifyBasemapChange(basemap);
    return;
  }

  try {
    const style = prepareBasemapStyle(await loadMapStyle(styleName));
    if (request !== basemapRequest) return;

    const nextBaseLayerIds = new Set(
      style.layers.map(({ id }) => id).filter((id) => id !== SATELLITE_ID)
    );
    const nextBaseSourceIds = new Set(
      Object.keys(style.sources).filter((id) => id !== SATELLITE_ID)
    );
    preserveApplicationLayers(map, style);

    map.once('style.load', () => {
      if (request !== basemapRequest) return;

      basemapStylePending = false;
      activeBasemap = basemap;
      setSatelliteVisibility(map, basemap);
      notifyBasemapChange(basemap);
    });
    activeBaseStyle = styleName;
    activeBaseLayerIds = nextBaseLayerIds;
    activeBaseSourceIds = nextBaseSourceIds;
    basemapStylePending = true;
    map.setStyle(style, { diff: false });
  } catch (error) {
    if (request !== basemapRequest) return;
    basemapStylePending = false;
    const activeInput = picker.querySelector(
      `input[name="basemap"][value="${activeBasemap}"]`
    );
    if (activeInput) activeInput.checked = true;
    console.error('Failed to load basemap:', error);
  }
}

function setSatelliteVisibility(map, basemap) {
  map.setLayoutProperty(
    SATELLITE_ID,
    'visibility',
    basemap === 'satellite' ? 'visible' : 'none'
  );
}

function notifyBasemapChange(basemap) {
  for (const listener of basemapChangeListeners) listener(basemap);
}

function resetBasemapPicker() {
  const defaultInput = document.querySelector(
    `#basemap-picker input[name="basemap"][value="${DEFAULT_BASEMAP}"]`
  );
  if (defaultInput) defaultInput.checked = true;
}

// satellite is a topmost base-style layer; application layers load above
function addSatelliteBasemap(style) {
  // the fetched style may omit these containers in a future style revision
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

function prepareBasemapStyle(style) {
  removeDuplicateTerrainDem(style);
  enableContourLineMetrics(style);
  // the app keeps the same projection when the selected style changes
  style.projection = { name: 'mercator' };
  addSatelliteBasemap(style);
  return style;
}

function recordBaseStyle(style) {
  activeBaseLayerIds = new Set(
    (style.layers || []).map(({ id }) => id).filter((id) => id !== SATELLITE_ID)
  );
  activeBaseSourceIds = new Set(
    Object.keys(style.sources || {}).filter((id) => id !== SATELLITE_ID)
  );
}

function preserveApplicationLayers(map, style) {
  const currentStyle = map.getStyle();
  if (!currentStyle) return;

  style.sources ||= {};
  style.layers ||= [];
  for (const [id, source] of Object.entries(currentStyle.sources || {})) {
    if (id === SATELLITE_ID || activeBaseSourceIds.has(id) || style.sources[id]) continue;
    style.sources[id] = source;
  }

  const nextLayerIds = new Set(style.layers.map(({ id }) => id));
  const applicationLayers = (currentStyle.layers || []).filter(
    ({ id }) => id !== SATELLITE_ID && !activeBaseLayerIds.has(id) && !nextLayerIds.has(id)
  );
  style.layers.push(...applicationLayers);
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
async function loadMapStyle(basemap) {
  // request JSON rather than a style URL so sources can be deduplicated first
  const encodedToken = encodeURIComponent(mapboxgl.accessToken);
  const styleUrl = `https://api.mapbox.com/styles/v1/${BASEMAP_STYLE_IDS[basemap]}?access_token=${encodedToken}`;
  const response = await fetch(styleUrl);

  if (!response.ok) {
    throw new Error(`Mapbox style HTTP ${response.status}`);
  }

  return response.json();
}

function enableContourLineMetrics(style) {
  const contourSource = style.sources?.['mapbox://mapbox.mapbox-terrain-v2-contour'];
  // line-gradient paint needs per-segment distance from the vector source
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
