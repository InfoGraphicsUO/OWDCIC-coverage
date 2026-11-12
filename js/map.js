import { restoreMarkerIcons } from './marker-icons.js';
import { registerOutsideHatch } from './states-highlight.js';
import { REGION_DATA_BOUNDS } from './config.js';
import { bindSettingsButton, onSettingChange, SETTINGS_ENABLED } from './settings.js';
import { SHEET_CHANGE_EVENT, bindResultsSheet, isPhoneLayout, sheetHeight } from './bottom-sheet.js';

mapboxgl.accessToken =
  'pk.eyJ1IjoiaW5mb2dyYXBoaWNzIiwiYSI6ImNqaTR0eHhnODBjeTUzdmx0N3U2dWU5NW8ifQ.fVbTCmIrqILIzv5QGtVJ2Q';

// style id stays separate from the tokenized request URL
const MAPBOX_STYLE = 'infographics/cmspb7yx9000s01px89hr8i1a';
const SIMPLE_MAPBOX_STYLE = 'infographics/cmud7fy6n000a01rghxd37aiz';
const SATELLITE_ID = 'mapbox-satellite-basemap';
// on satellite, city, town, and state names redraw in the medium weight Standard gives larger cities
const SATELLITE_PLACE_LABEL_ID = 'satellite-place-labels';
const SATELLITE_STATE_LABEL_ID = 'satellite-state-labels';
// forest and park names redraw in the same look
const SATELLITE_POI_LABEL_ID = 'satellite-poi-labels';
// mountain peaks redraw from the outdoors style's own peak layer
const OUTDOORS_PEAK_LABEL_ID = 'natural-label-peak';
const SATELLITE_PEAK_LABEL_ID = 'satellite-peak-labels';
// Standard config that satellite overrides on the outdoors style
const SATELLITE_BASEMAP_CONFIG = Object.freeze({
  // the label copies above replace these
  showPlaceLabels: false,
  showPointOfInterestLabels: false,
  // flat building footprints and their outlines take their opacity from this color
  colorBuildings: 'hsla(0, 0%, 0%, 0)',
});
// the outdoors style's own values for those keys while satellite overrides them
let savedBasemapConfig = null;
// the satellite imagery and every label layer drawn only on it
const SATELLITE_LAYER_IDS = Object.freeze([
  SATELLITE_ID,
  SATELLITE_PEAK_LABEL_ID,
  SATELLITE_POI_LABEL_ID,
  SATELLITE_PLACE_LABEL_ID,
  SATELLITE_STATE_LABEL_ID,
]);
// the outdoors style's park icon with its gray bubble cut away, saved at 2x pixel density
const SATELLITE_PARK_ICON_ID = 'satellite-park-icon';
const SATELLITE_PARK_ICON_URL = 'img/satellite-park.png';
// the park icon download, shared by every style that needs the image added
let satelliteParkIconLoad;
// a white dot with a black ring, matching the white names with a black halo
const SATELLITE_PLACE_DOT_ID = 'satellite-place-dot';
// css pixels
const SATELLITE_PLACE_DOT_SIZE = 7;
const SATELLITE_PLACE_DOT_RING = 1.5;

// center arrays use longitude first, then latitude
const DEFAULT_VIEW = Object.freeze({
  center: Object.freeze([-120.55, 45.5]),
  zoom: 5.4,
});

// highway shields replace Mapbox Standard's, which cannot be thinned
const HIGHWAY_SHIELD_ID = 'highway-shields';
const HIGHWAY_SHIELD_MIN_ZOOM = 7;
// below this zoom streets v8 puts route numbers on shield points instead of road lines
const HIGHWAY_SHIELD_LINE_ZOOM = 11;
// zoom, then pixels between repeated shields along one road, from the line zoom up
const HIGHWAY_SHIELD_SPACING = Object.freeze([11, 1000, 15, 1800]);
// zoom, then extra pixels around each shield that nearby shields cannot overlap
const HIGHWAY_SHIELD_PADDING = Object.freeze([
  7, 10,
  8, 25,
  9, 40,
  10, 55,
  11, 75,
  12, 100,
  15, 125,
]);
// streets v8 shield types to draw, listed in collision priority order
const HIGHWAY_SHIELD_TYPES = Object.freeze([
  'us-interstate',
  'us-interstate-duplex',
  'us-interstate-business',
  'us-interstate-truck',
  'us-highway',
  'us-highway-duplex',
  'us-highway-alternate',
  'us-highway-business',
  'us-highway-bypass',
  'us-highway-truck',
  'us-state-oregon',
  'us-state-washington',
  // generic shields for forest, county, and other numbered service roads
  'default',
  'rectangle-white',
  'rectangle-yellow',
  'rectangle-green',
  'rectangle-blue',
  'rectangle-red',
  'circle-white',
  'us-bia',
]);
// white names with a soft black halo, shared by every label drawn on satellite
const SATELLITE_LABEL_PAINT = Object.freeze({
  'text-color': '#ffffff',
  'text-halo-color': '#000000',
  'text-halo-blur': 1,
});
// street names return with Standard's road labels turned off for the shields
const STREET_LABEL_ID = 'street-labels';
// dark names on map basemaps, and the shared satellite look on satellite
const STREET_LABEL_PAINT = Object.freeze({
  map: Object.freeze({
    'text-color': 'hsl(0, 0%, 25%)',
    'text-halo-color': 'hsl(0, 0%, 100%)',
    'text-halo-blur': 0,
  }),
  satellite: SATELLITE_LABEL_PAINT,
});
// zoom, then streets v8 road classes that start getting names there and stay named above it
// paths and tracks keep path-track-labels
const STREET_LABEL_CLASSES_BY_ZOOM = Object.freeze([
  [12, ['motorway', 'trunk', 'primary', 'secondary']],
  [13, ['tertiary']],
  [14, ['street', 'street_limited']],
]);
const DEFAULT_BASEMAP = 'outdoors';
const BASEMAP_IDS = Object.freeze(['outdoors', 'satellite', 'simple']);
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

// set once the picker is bound so programmatic changes follow the picker path
let basemapPicker;
let basemapMap;

export const MAP_HOME_EVENT = 'apphome';
const NARROW_LAYOUT_QUERY = '(max-width: 900px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const MAP_BOUNDS = [
  [-135, 38],
  [-106, 53],
];
// phones frame selections above a tall results panel, which needs room to pan further south
const PHONE_MAP_BOUNDS = [
  [-140, 28],
  [-100, 55],
];

// layer setup waits on this shared map promise
export const mapReady = initializeMap();

// subscribe to basemap changes and receive the current value right away
export function onBasemapChange(listener) {
  basemapChangeListeners.push(listener);
  // apply the current mode now so late layers get matching colors immediately
  listener(selectedBasemap());
}

// basemap currently drawn on the map, which lags the picker while a style loads
export function getBasemap() {
  return activeBasemap;
}

// switch basemap through the picker so the radio, style, and listeners stay in sync
// resolves false for unknown ids; waits for the map and picker when called early
export async function setBasemap(basemap) {
  if (!BASEMAP_IDS.includes(basemap)) return false;
  await mapReady;
  // the picker binds on map load, which can follow the ready promise
  if (!basemapPicker && !(await waitForBasemapPicker())) return false;
  if (basemap === activeBasemap && !basemapStylePending) return true;

  const input = basemapPicker.querySelector(`input[name="basemap"][value="${basemap}"]`);
  if (!input || input.disabled) return false;
  input.checked = true;
  await changeBasemap(basemapMap, basemapPicker, basemap);
  return true;
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

  // phone panels stack up from the tab bar under the banner pill
  if (isPhoneLayout()) {
    const banner = document.querySelector('.site-banner');
    const rail = sidebar?.querySelector('.control-rail');
    const top = (banner?.getBoundingClientRect().bottom ?? 0) + 24;
    // on its side the phone stacks the panels in a column on the left instead
    if (container.clientWidth > container.clientHeight) {
      return { top, right: 24, bottom: 24, left: (rail?.offsetWidth ?? 0) + 24 };
    }
    const tabBarHeight = rail?.offsetHeight ?? 0;
    const resultsHeight = resultsVisible ? results.offsetHeight : 0;
    const sheet = sidebar ? sheetHeight(sidebar) : 0;
    return {
      top,
      right: 24,
      bottom: Math.min(tabBarHeight + Math.max(sheet, resultsHeight) + 24, heightCap),
      left: 24,
    };
  }

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

// resolves true once initBasemapPicker has run, false if the map never loads
function waitForBasemapPicker() {
  return new Promise((resolve) => {
    mapReady.then((map) => {
      if (basemapPicker) return resolve(true);
      map.once('load', () => resolve(Boolean(basemapPicker)));
    });
  });
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
  const style = prepareBasemapStyle(await loadMapStyle(DEFAULT_BASEMAP), DEFAULT_BASEMAP);
  recordBaseStyle(style);

  const map = new mapboxgl.Map({
    container: 'map',
    style: null,
    projection: 'mercator',
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    // phones zoom out further so a whole state fits between the banner pill and the sheets
    minZoom: isPhoneLayout() ? 4 : 5,
    // maxZoom: 12,
    maxBounds: isPhoneLayout() ? PHONE_MAP_BOUNDS : MAP_BOUNDS,
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

    // tiles and labels past full fog are skipped, so a near fog cuts steep-pitch tile loads
    map.setFog({
      range: [0, 1.5], // first value starts opacity, second reaches full opacity
      'horizon-blend': 0.1,
    })
  });

  // attach the style error listener before asking Mapbox to install the JSON
  // style installation can emit errors while the map is still initializing
  map.on('error', handleMapError);
  map.on('style.load', () => {
    registerOutsideHatch(map);
    registerSatellitePlaceDot(map);
    registerSatelliteParkIcon(map);
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
  initLocationSearch(map);
  if (SETTINGS_ENABLED) map.addControl(new SettingsControl(), 'top-left');

  map.addControl(new mapboxgl.AttributionControl({
    // phones keep the credits behind the (i) so they fit beside the logo
    compact: isPhoneLayout() || undefined,
    customAttribution: '<a href="https://infographics.uoregon.edu/" target="_blank" rel="noopener noreferrer">UO InfoGraphics Lab</a> | <a href="https://ohaz.uoregon.edu/" target="_blank" rel="noopener noreferrer">OHAZ</a>'
  }));
  initZoomViewer(map);

  map.once('load', () => {
    initBasemapPicker(map);
    // account for the panels before the first view is drawn; phones fit the region instead
    if (!isPhoneLayout()) {
      map.jumpTo({
        center: DEFAULT_VIEW.center,
        zoom: DEFAULT_VIEW.zoom,
        padding: mapPanelPadding(map),
      });
    }
    initControlShellSync(map);
  });

  return map;
}

function initControlShellSync(map) {
  const sidebar = document.getElementById('control-sidebar');
  if (!sidebar) return;

  const refreshPadding = () => {
    // padding changes can interrupt an active drag or camera animation, so wait for it to end
    if (map.isMoving()) {
      map.once('moveend', () => requestAnimationFrame(refreshPadding));
      return;
    }
    // on phones the sheets move a lot, so the map glides to its new middle instead of jumping
    if (isPhoneLayout()) map.easeTo({ padding: mapPanelPadding(map), duration: motionDuration(250) });
    else map.setPadding(mapPanelPadding(map));
  };

  // phones open on the whole region, framed between the banner pill and the tab bar
  if (isPhoneLayout()) map.fitBounds(REGION_DATA_BOUNDS, { padding: mapPanelPadding(map), duration: 0 });

  // turning a phone swaps its panels between the bottom and a left column
  map.on('resize', () => requestAnimationFrame(refreshPadding));

  // a tap on the map hands it the screen, hiding a phone's sheet
  map.on('click', () => {
    if (isPhoneLayout() && !sidebar.classList.contains('is-collapsed')) {
      sidebar._controlShellApi?.collapse();
      requestAnimationFrame(refreshPadding);
    }
  });

  // wait for collapse and tab layout changes before measuring panel widths
  sidebar.querySelector('.control-shell__collapse')?.addEventListener('click', () => {
    requestAnimationFrame(refreshPadding);
  });

  for (const tab of sidebar.querySelectorAll('[data-control-tab]')) {
    tab.addEventListener('click', () => requestAnimationFrame(refreshPadding));
  }
  sidebar.addEventListener(SHEET_CHANGE_EVENT, refreshPadding);

  const results = document.getElementById('results-panel');
  if (results) {
    bindResultsSheet(results);
    results.addEventListener(SHEET_CHANGE_EVENT, () => requestAnimationFrame(refreshPadding));
    // results grow as their figures arrive and vanish when closed, so the framing follows their size
    let pending = false;
    new ResizeObserver(() => {
      if (!isPhoneLayout() || pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        refreshPadding();
      });
    }).observe(results);
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
  onSettingChange('showZoomLevel', (show) => { viewer.hidden = !show; });
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

class SettingsControl {
  onAdd() {
    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

    const button = document.createElement('button');
    button.className = 'mapboxgl-ctrl-settings';
    button.type = 'button';
    button.title = 'Map settings';
    button.setAttribute('aria-label', button.title);

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-gear';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    bindSettingsButton(button);

    container.append(button);
    this.container = container;
    return container;
  }

  onRemove() {
    this.container?.remove();
  }
}

function initLocationSearch(map) {
  const searchBox = new MapboxSearchBox();
  searchBox.accessToken = mapboxgl.accessToken;
  searchBox.placeholder = 'Zoom to a location...';
  searchBox.options = {
    types: 'region,place,locality',
    proximity: DEFAULT_VIEW.center,
    country: 'US',
    // southwest then northeast corners of the Oregon and Washington data area
    bbox: REGION_DATA_BOUNDS.flat(),
  };
  searchBox.marker = false;
  searchBox.mapboxgl = mapboxgl;
  searchBox.theme = {
    variables: {
      fontFamily: 'inherit',
      // custom properties cross the shadow root, so the dropdown follows the global overlay opacity
      colorBackground: 'var(--overlay-dark-bg)',
      colorText: '#ffffff',
      colorBackgroundHover: 'var(--overlay-dark-bg-hover)',
      colorBackgroundActive: 'var(--overlay-dark-bg-hover)',
      borderRadius: '10px',
    },
    // the dropdown renders in a shadow root, so its chrome is set here instead of in map.css
    cssText: `
      [class*="--MapboxSearch"] { --width: 300px !important; }
      [class*="--Results"] {
        box-sizing: border-box;
        width: 100% !important;
        margin-top: 6px;
        border: 1px solid rgba(255, 255, 255, .18);
        border-radius: 10px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, .22);
        overflow: hidden;
      }
      [class$="--Results"] {
        -webkit-backdrop-filter: var(--overlay-backdrop);
        backdrop-filter: var(--overlay-backdrop);
      }
      [class*="--ResultsList"], [class*="--ResultsAttribution"] {
        border: 0; border-radius: 0; box-shadow: none; background: transparent;
      }
      [class*="--ResultsAttribution"] { border-top: 1px solid rgba(255, 255, 255, .18); }
    `,
  };

  const container = document.createElement('div');
  container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group location-search';

  const button = document.createElement('button');
  button.className = 'location-search__toggle';
  button.type = 'button';
  button.title = 'Zoom to a location';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-magnifying-glass';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);

  const setExpanded = (expanded) => {
    container.classList.toggle('is-expanded', expanded);
    button.setAttribute('aria-expanded', String(expanded));
    if (expanded) container.querySelector('input')?.focus();
  };

  button.addEventListener('click', () => {
    setExpanded(!container.classList.contains('is-expanded'));
  });
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setExpanded(false);
  });

  container.append(searchBox.onAdd(map), button);
  map.addControl({ onAdd: () => container, onRemove: () => container.remove() }, 'top-left');

  searchBox.addEventListener('retrieve', (event) => {
    setExpanded(false);
    const feature = event.detail?.features?.[0];
    if (!feature) return;
    const [west, south, east, north] = feature.properties?.bbox ?? [];
    const options = { padding: mapPanelPadding(map), duration: motionDuration(700) };

    if (west === undefined) {
      map.easeTo({ ...options, center: feature.geometry.coordinates, zoom: 9 });
    } else {
      map.fitBounds([[west, south], [east, north]], { ...options, maxZoom: 11 });
    }
  });
}

function resetMapView(map) {
  // listeners clear the active filter before the camera returns home
  map.fire(MAP_HOME_EVENT);

  const padding = mapPanelPadding(map);
  // a phone's home is the whole region, since the desktop view doesn't fit its screen
  if (isPhoneLayout()) {
    map.fitBounds(REGION_DATA_BOUNDS, { padding, bearing: 0, pitch: 0, duration: motionDuration(700) });
    return;
  }

  map.easeTo({
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    bearing: 0,
    pitch: 0,
    duration: motionDuration(700),
    padding,
  });
}

function initBasemapPicker(map) {
  const picker = document.getElementById('basemap-picker');
  if (!picker) throw new Error('Basemap picker #basemap-picker is missing');

  basemapPicker = picker;
  basemapMap = map;
  // reset browser-restored input state to match the style loaded at startup
  resetBasemapPicker();
  updateBasemapPreview(selectedBasemap());

  // satellite imagery is an overlay; outdoors stays supplied by the base style
  map.setLayoutProperty(SATELLITE_ID, 'visibility', 'none');

  picker.addEventListener('change', (event) => {
    const input = event.target;
    // ignore bubbled events from unrelated inputs or unavailable basemaps
    if (!(input instanceof HTMLInputElement) || input.name !== 'basemap') return;
    if (input.disabled || !BASEMAP_IDS.includes(input.value)) return;

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
    const style = prepareBasemapStyle(await loadMapStyle(styleName), styleName);
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
  const visibility = basemap === 'satellite' ? 'visible' : 'none';
  for (const layerId of SATELLITE_LAYER_IDS) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visibility);
  }
  // street names stay on every basemap and only change color
  if (map.getLayer(STREET_LABEL_ID)) {
    const paint = STREET_LABEL_PAINT[basemap === 'satellite' ? 'satellite' : 'map'];
    for (const [property, value] of Object.entries(paint)) {
      map.setPaintProperty(STREET_LABEL_ID, property, value);
    }
  }
  // highway shields stay off satellite, where street names alone label the roads
  if (map.getLayer(HIGHWAY_SHIELD_ID)) {
    map.setLayoutProperty(HIGHWAY_SHIELD_ID, 'visibility', basemap === 'satellite' ? 'none' : 'visible');
  }
  setSatelliteBasemapConfig(map, basemap === 'satellite');
}

// Standard's own labels would show in the old style wherever a copy is crowded out
// leaving satellite restores the style's own values rather than assuming them
function setSatelliteBasemapConfig(map, satellite) {
  // satellite draws on the outdoors style, so the simple basemap is never changed
  // a newly loaded style starts from its own values
  if (activeBaseStyle !== DEFAULT_BASEMAP) {
    savedBasemapConfig = null;
    return;
  }

  if (satellite && !savedBasemapConfig) {
    savedBasemapConfig = {};
    for (const [key, value] of Object.entries(SATELLITE_BASEMAP_CONFIG)) {
      savedBasemapConfig[key] = map.getConfigProperty('basemap', key);
      map.setConfigProperty('basemap', key, value);
    }
  } else if (!satellite && savedBasemapConfig) {
    for (const [key, value] of Object.entries(savedBasemapConfig)) {
      map.setConfigProperty('basemap', key, value);
    }
    savedBasemapConfig = null;
  }
}

function notifyBasemapChange(basemap) {
  updateBasemapPreview(basemap);
  for (const listener of basemapChangeListeners) listener(basemap);
}

function updateBasemapPreview(basemap) {
  const button = document.getElementById('control-tab-basemap');
  if (button) button.dataset.basemap = basemap;
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

function prepareBasemapStyle(style, styleName) {
  removeDuplicateTerrainDem(style);
  enableContourLineMetrics(style);
  // the app keeps the same projection when the selected style changes
  style.projection = { name: 'mercator' };
  // satellite only ever draws on the outdoors style
  if (styleName === DEFAULT_BASEMAP) {
    addSatelliteBasemap(style);
    addSatellitePlaceLabels(style);
  }
  replaceRoadLabels(style);
  hide3dObjects(style);
  return style;
}

// Standard draws small towns in a thin regular weight that gets lost on satellite imagery
// this copy of all its city and town labels uses Portland's medium weight throughout
// Standard's own place labels are switched off on satellite, so these are the only ones
// covering cities too lets symbolrank keep big cities ahead of nearby towns
function addSatellitePlaceLabels(style) {
  if (style.sources?.composite?.url !== 'mapbox://mapbox.mapbox-streets-v8') return;

  const rank = ['get', 'symbolrank'];
  const places = {
    id: SATELLITE_PLACE_LABEL_ID,
    type: 'symbol',
    source: 'composite',
    'source-layer': 'place_label',
    maxzoom: 15,
    // Standard's city and town filters combined, which zoomed in keep only small places
    filter: ['all',
      ['==', ['get', 'class'], 'settlement'],
      ['<=', ['get', 'filterrank'], 3],
      ['step', ['zoom'], true, 13, ['>=', rank, 11], 14, ['>=', rank, 15]],
    ],
    layout: {
      visibility: 'none',
      'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      'text-font': ['Roboto Medium', 'Arial Unicode MS Bold'],
      // Standard's city sizes for low ranks and town sizes for the rest
      'text-size': ['interpolate', ['cubic-bezier', 0.2, 0, 0.9, 1], ['zoom'],
        3, ['step', rank, 13, 6, 11, 9, 10],
        6, ['step', rank, 18, 6, 16, 7, 14, 9, 12, 12, 10],
        8, ['step', rank, 20, 9, 16, 10, 14, 12, 12, 15, 10],
        13, ['step', rank, 22, 9, 20, 12, 16, 15, 14],
        15, ['step', rank, 24, 9, 20, 12, 16, 15, 14]],
      'text-max-width': 7,
      'symbol-sort-key': rank,
      // below zoom 8 labels sit beside a place dot, then center on the place
      'icon-image': ['step', ['zoom'], SATELLITE_PLACE_DOT_ID, 8, ''],
      'text-anchor': ['step', ['zoom'], ['get', 'text_anchor'], 8, 'center'],
      'text-radial-offset': ['step', ['zoom'], 0.55, 8, 0],
    },
    paint: {
      ...SATELLITE_LABEL_PAINT,
      'text-halo-width': 1,
      // like Standard's labels, ignore the map lighting
      'text-emissive-strength': 1,
      'icon-emissive-strength': 1,
    },
  };

  const { visibility, 'text-field': name, 'text-font': font } = places.layout;

  // forests and parks also use the same look
  // Standard switches every point of interest off together, so only park-like places return
  const sizerank = ['get', 'sizerank'];
  // big places like national forests get no icon, as in Standard
  const hasTree = ['all', ['>=', sizerank, 5], ['==', ['get', 'maki'], 'park']];
  const pois = {
    ...places,
    id: SATELLITE_POI_LABEL_ID,
    'source-layer': 'poi_label',
    // Standard's zoom range, replacing the town labels' maxzoom from the spread
    minzoom: 6,
    maxzoom: 24,
    // Standard's park filter with the outdoors style's label density of 2
    // shops, food, lodging, and other places would add bare names with no icon to tell them apart
    filter: ['all',
      ['==', ['get', 'class'], 'park_like'],
      ['<=', ['get', 'filterrank'], ['+', ['step', ['zoom'], -2, 16, -1, 18, 0], 4, 2]],
    ],
    layout: {
      visibility,
      'text-field': name,
      'text-font': font,
      // big places like national forests get a larger name, as in Standard
      'text-size': ['step', sizerank, 18, 5, 13],
      // parks keep their tree, minus the style's gray bubble; other icons are left off
      'icon-image': ['case', hasTree, SATELLITE_PARK_ICON_ID, ''],
      'text-anchor': ['case', hasTree, 'top', 'center'],
      'text-offset': ['case', hasTree, ['literal', [0, 0.8]], ['literal', [0, 0]]],
    },
  };

  // state names reuse the same look in place of Standard's faded bold
  // points of interest go first and state names last, so the stacking matches Standard
  style.layers.push(pois, places, {
    ...places,
    id: SATELLITE_STATE_LABEL_ID,
    maxzoom: 9,
    filter: ['==', ['get', 'class'], 'state'],
    layout: {
      visibility,
      'text-field': name,
      'text-font': font,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.15,
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 9, 21],
    },
  });
  addSatellitePeakLabels(style, places.paint);
}

// the outdoors style's own peak names and mountain icons are dark, for a light map
// this copy keeps their filter, font, and elevations, recolored to match the other labels
function addSatellitePeakLabels(style, labelPaint) {
  const peaks = style.layers.find(({ id }) => id === OUTDOORS_PEAK_LABEL_ID);
  if (!peaks) return;

  // without the slot the copy sits above the original in the top slot, so it wins where they collide
  // and the dark originals stay hidden on satellite
  const { slot, ...unslotted } = peaks;
  const pointsOfInterestIndex = style.layers.findIndex(({ id }) => id === SATELLITE_POI_LABEL_ID);
  // placed under the point of interest copy, as Standard stacks natural features below them
  style.layers.splice(pointsOfInterestIndex, 0, {
    ...unslotted,
    id: SATELLITE_PEAK_LABEL_ID,
    layout: {
      ...peaks.layout,
      visibility: 'none',
      // the style's mountain icon takes a fill and an outline color, here matching the park tree
      'icon-image': ['image', 'mountain', { params: { 'color-1': '#000000', 'color-2': '#ffffff' } }],
    },
    // keeps the peaks' own text and icon opacity by zoom
    paint: { ...peaks.paint, ...labelPaint },
  });
}

// loads the bubble-free park tree once, then adds it to each new style
function registerSatelliteParkIcon(map) {
  satelliteParkIconLoad ??= new Promise((resolve, reject) => {
    map.loadImage(SATELLITE_PARK_ICON_URL, (error, image) => (error ? reject(error) : resolve(image)));
  });
  satelliteParkIconLoad
    .then((image) => {
      // a basemap switch may have already added it to the newer style
      if (!map.hasImage(SATELLITE_PARK_ICON_ID)) {
        map.addImage(SATELLITE_PARK_ICON_ID, image, { pixelRatio: 2 });
      }
    })
    .catch((error) => console.error('Failed to load satellite park icon:', error));
}

// draws the satellite place dot, which each new style needs added again
function registerSatellitePlaceDot(map) {
  if (map.hasImage(SATELLITE_PLACE_DOT_ID)) return;

  // drawn at double size so the dot stays sharp on high-density screens
  const pixelRatio = 2;
  const size = SATELLITE_PLACE_DOT_SIZE * pixelRatio;
  const ring = SATELLITE_PLACE_DOT_RING * pixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.beginPath();
  // the ring is centered on the circle's edge, so the radius leaves half of it inside the image
  context.arc(size / 2, size / 2, (size - ring) / 2, 0, Math.PI * 2);
  context.fillStyle = '#ffffff';
  context.fill();
  context.lineWidth = ring;
  context.strokeStyle = '#000000';
  context.stroke();

  map.addImage(SATELLITE_PLACE_DOT_ID, context.getImageData(0, 0, size, size), { pixelRatio });
}

// the imported Mapbox Standard style whose config toggles its built-in layers
function basemapImport(style) {
  return style.imports?.find(({ id }) => id === 'basemap');
}

// Standard's 3D buildings, trees, and landmarks cover houses from zoom 15
// with them off Standard draws flat building footprints instead, which satellite hides
function hide3dObjects(style) {
  const basemap = basemapImport(style);
  if (!basemap) return;
  basemap.config = { ...basemap.config, show3dObjects: false };
}

// styles with Standard road labels off, like the simple basemap, stay without them
function replaceRoadLabels(style) {
  const basemap = basemapImport(style);
  if (!basemap || basemap.config?.showRoadLabels === false) return;
  if (style.sources?.composite?.url !== 'mapbox://mapbox.mapbox-streets-v8') return;

  // Standard ties shields to street names, so both are redrawn here
  basemap.config = { ...basemap.config, showRoadLabels: false };

  // each zoom step names its own classes plus every class from the steps below
  const streetClasses = ['step', ['zoom'], false];
  let namedClasses = [];
  for (const [zoom, classes] of STREET_LABEL_CLASSES_BY_ZOOM) {
    namedClasses = [...namedClasses, ...classes];
    streetClasses.push(zoom, ['match', ['get', 'class'], namedClasses, true, false]);
  }

  style.layers.push({
    id: STREET_LABEL_ID,
    type: 'symbol',
    source: 'composite',
    'source-layer': 'road',
    slot: 'top',
    minzoom: STREET_LABEL_CLASSES_BY_ZOOM[0][0],
    filter: ['all', ['has', 'name'], streetClasses],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      'text-font': ['Roboto Medium', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 18, 14],
      'text-max-angle': 30,
    },
    paint: {
      ...STREET_LABEL_PAINT.map,
      'text-halo-width': 1,
    },
  });

  const reflen = ['to-string', ['get', 'reflen']];
  // like Standard, prefer the detailed shield_beta design over the generic shield
  const shield = ['coalesce', ['get', 'shield_beta'], ['get', 'shield']];
  style.layers.push({
    id: HIGHWAY_SHIELD_ID,
    type: 'symbol',
    source: 'composite',
    'source-layer': 'road',
    // the top slot keeps Standard's city names above shields, so names win where they collide
    slot: 'top',
    minzoom: HIGHWAY_SHIELD_MIN_ZOOM,
    filter: [
      'all',
      ['has', 'ref'],
      ['<=', ['get', 'reflen'], 6],
      ['match', shield, HIGHWAY_SHIELD_TYPES, true, false],
      ['step', ['zoom'], ['==', ['geometry-type'], 'Point'], HIGHWAY_SHIELD_LINE_ZOOM, true],
    ],
    layout: {
      'symbol-placement': ['step', ['zoom'], 'point', HIGHWAY_SHIELD_LINE_ZOOM, 'line'],
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], ...HIGHWAY_SHIELD_SPACING],
      'symbol-sort-key': ['index-of', shield, ['literal', HIGHWAY_SHIELD_TYPES]],
      // the style sprite names shields by type and ref length, e.g. us-interstate-2
      'icon-image': [
        'coalesce',
        ['image', ['concat', shield, '-', reflen]],
        ['image', ['concat', ['get', 'shield'], '-', reflen]],
        ['image', ['concat', 'default-', reflen]],
      ],
      'icon-rotation-alignment': 'viewport',
      'icon-padding': ['interpolate', ['linear'], ['zoom'], ...HIGHWAY_SHIELD_PADDING],
      'text-field': ['get', 'ref'],
      'text-font': ['Roboto Bold', 'Arial Unicode MS Regular'],
      'text-size': 9,
      'text-rotation-alignment': 'viewport',
    },
    paint: {
      // shield_beta designs carry their own text color
      'text-color': [
        'match',
        ['coalesce', ['get', 'shield_text_color_beta'], ['get', 'shield_text_color']],
        'white',
        '#ffffff',
        '#000000',
      ],
    },
  });
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
