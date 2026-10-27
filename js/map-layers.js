import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  BURN_PROBABILITY_MIN,
  CAMERA_API,
  CAMERA_PROVIDER_COLORS,
  DATA_URLS,
  DIGITIZED_CAMERA_ICON_URLS,
  LAYER_IDS,
  LEGEND_LAYERS,
  MARKER_ICON_URLS,
  REGION_DATA_BOUNDS,
  emptyFeatureCollection,
  filterOptionIsVisible,
  filterOptionRank,
  layerPresetForFilter,
  unmatchedFilterOptions,
  visibleFilterTypes,
  nestedFilterParent,
  visibleLegendItems,
} from './config.js';
import { VISIBLE_FILTERS, VISIBLE_LAYERS } from './visible-content.js';
import {
  anchorOptionSlugs,
  anchorOptionValue,
  anchorSlug,
  anchorType,
  formatAnchor,
  parseAnchor,
} from './anchor-links.js';
import {
  addNumericProperty,
  attachViewshedIds,
  camerasToGeoJSON,
  countPointsInGeometry,
  filterGeoJSONByBounds,
  outsideApiSitesToCameras,
  providerSitesToCameras,
} from './geojson-transform.js';
import { initLegend } from './legend.js';
import { initFireHistoryTimeline } from './fire-history-timeline.js';
import { initFilterPanel } from './filter-panel.js';
import { initResultsPanel, loadPlotly } from './results-panel.js';
import { hideMapLoading } from './loading.js';
import {
  MAP_HOME_EVENT,
  getBasemap,
  mapPanelPadding,
  mapReady,
  motionDuration,
  onBasemapChange,
  setBasemap,
} from './map.js';
import {
  registerMarkerIcon,
  registerMarkerIconSizes,
  sizedIconId,
  watchMarkerIconDensity,
} from './marker-icons.js';
import {
  addRegionFocusLayers,
  loadRegionFocusData,
} from './states-highlight.js';
import { addHoverLayer, pointerCanHover } from './hover-info.js';
import { showFeaturePopup } from './popups.js';
import { getSetting, onSettingChange } from './settings.js';
import { initAbout } from './about.js';

const LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// stable ids let UI controls refer to layers without inspecting the style
const FIRE_ICON_ID = 'fire-marker';
const CAMERA_ICON_ID = 'camera-marker';
const PRIVATE_CAMERA_ICON_ID = 'private-camera-marker';
const PANO_CAMERA_ICON_ID = 'pano-camera-marker';
const ENVIROVISION_CAMERA_ICON_ID = 'envirovision-camera-marker';
const PRESCRIBED_ICON_ID = 'prescribed-marker';

const DIGITIZED_CAMERA_GROUP_LABEL = 'Digitized Camera Sources';
const DIGITIZED_CAMERA_UNLOCK_SEQUENCE = Object.freeze(['1', '2', '3', '4']); // key sequence reveals digitized camera layer
// all four keys must arrive within this many milliseconds
const DIGITIZED_CAMERA_UNLOCK_TIMEOUT_MS = 2_000;

const BOUNDARY_COLOR = '#494949';
const BOUNDARY_FILL_COLOR = '#929292';

// base fill and outline draw whole areas; portions only appear in a selection outline
const WHOLE_AREA_FILTER = ['!', ['has', 'partOfDivisionId']];

const SELECTED_BOUNDARY_COLOR = '#f8e109';

const PANO_OPERATOR = 'Pano AI';
const ENVIROVISION_OPERATOR = 'EnviroVision';

// every provider shares this fill unless the viewer turns on per-provider colors
// satellite imagery needs a light viewshed fill for contrast
const VIEWSHED_FILL_COLOR = Object.freeze({
  outdoors: '#F28D05',
  satellite: '#F4F1EA',
});

// layer list rows in the shared color show a sample viewshed instead of a flat swatch
const VIEWSHED_LEGEND_IMAGES = Object.freeze({
  outdoors: 'img/orange_portland_tower_viewshed.png',
  satellite: 'img/grey_portland_tower_viewshed.png',
});

const SEPARATE_VIEWSHED_COLORS_SETTING = 'separateViewshedColors';
const VIEWSHED_HIGHLIGHT_COLOR = '#ffee00';
const VIEWSHED_FILL_OPACITY = 0.5;
const VIEWSHED_HIGHLIGHT_OPACITY = 0.55;

const LOOKOUT_COLOR = '#8154BD';
const NATIONAL_FOREST_COLOR = '#3b7d4f';
const BLM_LAND_COLOR = '#f6d94a';
const BURN_PROBABILITY_COLOR = '#d7191c';
const TRANSMISSION_LINE_COLOR = '#c2188f';

// the timeline's year stands out in a dark red, apart from the brighter red of active fires
// and the orange viewsheds; earlier years fall back to a muted brown
const FIRE_HISTORY_COLOR = '#8f1d2c';
const FIRE_HISTORY_EARLIER_COLOR = '#7a6458';
const FIRE_HISTORY_FILL_OPACITY = 0.5;
const FIRE_HISTORY_EARLIER_FILL_OPACITY = 0.22;
const FIRE_HISTORY_EARLIER_IGNITION_OPACITY = 0.55;
// how long one year's fires take to fade out as the next year's fade in,
// short enough that dragging across several years still keeps up
const FIRE_HISTORY_FADE_MS = 600;
// ignition circles grow with final fire size, in px by acres
const FIRE_HISTORY_IGNITION_RADIUS = [
  'interpolate', ['linear'], ['coalesce', ['get', 'acres'], 0],
  100, 2.5,
  1_000, 4,
  100_000, 8,
];
// matches no feature until the timeline has a year
const NO_FIRE_YEAR = ['==', ['get', 'year'], -1];

// relative line widths by the source's VOLT_CLASS; DC and NOT AVAILABLE borrow another class's width
const TRANSMISSION_LINE_WIDTHS = Object.freeze({
  'UNDER 100': 0.8,
  '100-161': 1.4,
  '220-287': 2.2,
  '345': 3.2,
  '500': 4.4,
  'DC': 2.2,
  'NOT AVAILABLE': 0.8,
});

// the 1000 kV DC line to Nevada is drawn wider than every voltage class
const TRANSMISSION_LINE_TOP_VOLTAGE = 1000;
const TRANSMISSION_LINE_TOP_WIDTH = 7;
const TRANSMISSION_LINE_WIDTH = [
  'case',
  ['>=', ['to-number', ['get', 'VOLTAGE'], 0], TRANSMISSION_LINE_TOP_VOLTAGE],
  TRANSMISSION_LINE_TOP_WIDTH,
  [
    'match',
    ['get', 'VOLT_CLASS'],
    ...Object.entries(TRANSMISSION_LINE_WIDTHS).flat(),
    TRANSMISSION_LINE_WIDTHS['UNDER 100'],
  ],
];

const DIGITIZED_CAMERA_COLORS = Object.freeze({
  enviroVision: '#6eaa00',
  alertWest: '#a80000',
  pano: '#004ca9',
  joint: '#f8e109',
});

const NO_VIEWSHED_SELECTED = '__none__';

// each official provider is its own camera layer, viewshed tileset, and pair of legend rows
// later providers only need another entry here plus their config ids
const CAMERA_PROVIDERS = Object.freeze([
  Object.freeze({
    name: 'ALERTWest',
    color: CAMERA_PROVIDER_COLORS.alertWest,
    cameraLabel: LEGEND_LAYERS.alertWestCameras,
    cameraLayerId: LAYER_IDS.cameras,
    iconId: CAMERA_ICON_ID,
    iconUrl: MARKER_ICON_URLS.camera,
    // sites kept out of the API for landowner privacy show a slashed camera
    privateIconId: PRIVATE_CAMERA_ICON_ID,
    privateIconUrl: MARKER_ICON_URLS.privateCamera,
    viewshedLabel: LEGEND_LAYERS.alertWestViewsheds,
    viewshedTileset: DATA_URLS.cameraViewsheds,
    viewshedSourceId: LAYER_IDS.viewshedsSource,
    viewshedFillLayerId: LAYER_IDS.viewshedsFill,
    viewshedHighlightLayerId: LAYER_IDS.viewshedsHighlightFill,
    // provider colors apply only with the per-provider viewshed setting
    viewshedFillColor: VIEWSHED_FILL_COLOR,
  }),
  Object.freeze({
    name: PANO_OPERATOR,
    color: CAMERA_PROVIDER_COLORS.pano,
    cameraLabel: LEGEND_LAYERS.panoCameras,
    cameraLayerId: LAYER_IDS.panoCameras,
    iconId: PANO_CAMERA_ICON_ID,
    iconUrl: MARKER_ICON_URLS.panoCamera,
    viewshedLabel: LEGEND_LAYERS.panoViewsheds,
    viewshedTileset: DATA_URLS.panoCameraViewsheds,
    viewshedSourceId: LAYER_IDS.panoViewshedsSource,
    viewshedFillLayerId: LAYER_IDS.panoViewshedsFill,
    viewshedHighlightLayerId: LAYER_IDS.panoViewshedsHighlightFill,
    viewshedFillColor: Object.freeze({
      outdoors: CAMERA_PROVIDER_COLORS.pano,
      satellite: '#a9d4fb',
    }),
    viewshedLegendImage: 'img/blue_portland_tower_viewshed.png',
    sharedSiteIconOffset: Object.freeze([14, 0]),
  }),
  Object.freeze({
    name: ENVIROVISION_OPERATOR,
    color: CAMERA_PROVIDER_COLORS.enviroVision,
    cameraLabel: LEGEND_LAYERS.enviroVisionCameras,
    cameraLayerId: LAYER_IDS.enviroVisionCameras,
    iconId: ENVIROVISION_CAMERA_ICON_ID,
    iconUrl: MARKER_ICON_URLS.enviroVisionCamera,
    viewshedLabel: LEGEND_LAYERS.enviroVisionViewsheds,
    viewshedTileset: DATA_URLS.enviroVisionCameraViewsheds,
    viewshedSourceId: LAYER_IDS.enviroVisionViewshedsSource,
    viewshedFillLayerId: LAYER_IDS.enviroVisionViewshedsFill,
    viewshedHighlightLayerId: LAYER_IDS.enviroVisionViewshedsHighlightFill,
    viewshedFillColor: Object.freeze({
      outdoors: CAMERA_PROVIDER_COLORS.enviroVision,
      satellite: '#b5e3a8',
    }),
    viewshedLegendImage: 'img/green_portland_tower_viewshed.png',
    sharedSiteIconOffset: Object.freeze([-14, 0]),
  }),
]);

// providers whose cameras and viewshed ids come from a sites file in data/live/
const SITE_FILE_PROVIDERS = Object.freeze([
  Object.freeze({
    operator: PANO_OPERATOR,
    dataKey: 'panoSites',
    cameraLabel: LEGEND_LAYERS.panoCameras,
    cameraLayerId: LAYER_IDS.panoCameras,
    viewshedLabel: LEGEND_LAYERS.panoViewsheds,
    viewshedTileset: DATA_URLS.panoCameraViewsheds,
  }),
  Object.freeze({
    operator: ENVIROVISION_OPERATOR,
    dataKey: 'enviroVisionSites',
    cameraLabel: LEGEND_LAYERS.enviroVisionCameras,
    cameraLayerId: LAYER_IDS.enviroVisionCameras,
    viewshedLabel: LEGEND_LAYERS.enviroVisionViewsheds,
    viewshedTileset: DATA_URLS.enviroVisionCameraViewsheds,
  }),
]);

const CAMERA_LAYER_IDS = Object.freeze(
  CAMERA_PROVIDERS.map(({ cameraLayerId }) => cameraLayerId)
);

// markers on a shared ALERTWest site sit beside its marker instead of on top,
// each provider on its own side (sharedSiteIconOffset above)
const NO_DIVISION_SELECTED = '__none__';

// only the groups listed in js/visible-content.js reach the filter menu and the map
const FILTER_TYPES = Object.freeze(visibleFilterTypes(VISIBLE_FILTERS));
if (FILTER_TYPES.some(({ value, options }) => value === 'camera' && options)) {
  console.warn('The Camera filter group cannot list single options; showing all');
}

// cameras use point selection; every other type builds polygon layers
const DIVISION_TYPES = Object.freeze(FILTER_TYPES
  .filter(({ value }) => value !== 'camera')
  .map(({ value, label, options }) => {
    const prefix = `filter-${value}`;
    return Object.freeze({
      value,
      label,
      options,
      sourceId: `${prefix}-source`,
      labelSourceId: `${prefix}-label-source`,
      fillLayerId: `${prefix}-fill`,
      hoverLayerId: `${prefix}-hover`,
      layerId: `${prefix}-line`,
      labelLayerId: `${prefix}-labels`,
      selectedLayerId: `${prefix}-selected`,
      dataUrl: `data/live/map-divisions/${value}.geojson`,
    });
  }));

// cache in-flight requests separately from parsed features used for selection
const divisionLoads = new Map();
const divisionFeatures = new Map();
let divisionOptionsIndex;

let activeMap;
let activeFilterType = null;

// an area result is showing, as opposed to a polygon type with nothing picked
let polygonSelected = false;
let cameraFeatures = [];
let camerasLoaded = false;

// names the camera whose viewshed is highlighted, for the export legend
let highlightedCameraName = '';
let resolveCameraFeatures;

// camera options wait for the provider data while division sources wait for map setup
const cameraFeaturesReady = new Promise((resolve) => {
  resolveCameraFeatures = resolve;
});

let resolveFilterSources;
const filterSourcesReady = new Promise((resolve) => {
  resolveFilterSources = resolve;
});

let cameraMetricsLoad;

// option slugs per filter type, filled as each type's options load
const anchorSlugsByType = new Map();
let anchorRequest = 0;

// incremented whenever another selection or clear action takes ownership of results
let cameraResultRequest = 0;
let digitizedCameraLoad;
// legend label -> load promise for layers fetched the first time their row is switched on
const deferredLayerLoads = new Map();

// legend rows a filter preset switched on, hidden again when that filter is left
// a row the user toggles themselves drops out and stays as they set it
const presetLayersOn = new Set();
let digitizedCameraLayersLoad;

const DIGITIZED_CAMERA_OPERATORS = Object.freeze([
  Object.freeze({
    operator: 'EnviroVision Solutions',
    label: 'EnviroVision Solutions',
    layerId: LAYER_IDS.digitizedEnviroVision,
    color: DIGITIZED_CAMERA_COLORS.enviroVision,
    operationalIconId: 'digitized-envirovision-operational',
    operationalIconUrl: DIGITIZED_CAMERA_ICON_URLS.enviroVisionOperational,
    plannedIconId: 'digitized-envirovision-planned',
    plannedIconUrl: DIGITIZED_CAMERA_ICON_URLS.enviroVisionPlanned,
  }),
  Object.freeze({
    operator: 'ALERTWest',
    label: 'ALERTWest',
    layerId: LAYER_IDS.digitizedAlertWest,
    color: DIGITIZED_CAMERA_COLORS.alertWest,
    operationalIconId: 'digitized-alertwest-operational',
    operationalIconUrl: DIGITIZED_CAMERA_ICON_URLS.alertWestOperational,
    plannedIconId: 'digitized-alertwest-planned',
    plannedIconUrl: DIGITIZED_CAMERA_ICON_URLS.alertWestPlanned,
  }),
  Object.freeze({
    operator: 'Pano AI',
    label: 'Pano AI',
    layerId: LAYER_IDS.digitizedPano,
    color: DIGITIZED_CAMERA_COLORS.pano,
    operationalIconId: 'digitized-pano-operational',
    operationalIconUrl: DIGITIZED_CAMERA_ICON_URLS.panoOperational,
    plannedIconId: 'digitized-pano-planned',
    plannedIconUrl: DIGITIZED_CAMERA_ICON_URLS.panoPlanned,
  }),
  Object.freeze({
    operator: 'Joint Site',
    label: 'Joint Sites',
    layerId: LAYER_IDS.digitizedJoint,
    color: DIGITIZED_CAMERA_COLORS.joint,
    operationalIconId: 'digitized-joint',
    operationalIconUrl: DIGITIZED_CAMERA_ICON_URLS.joint,
    plannedIconId: 'digitized-joint',
    plannedIconUrl: DIGITIZED_CAMERA_ICON_URLS.joint,
    markerShapes: ['square'],
  }),
]);

// operator metadata drives both symbol filters and grouped legend rows
const DIGITIZED_CAMERA_LAYER_IDS = Object.freeze(
  DIGITIZED_CAMERA_OPERATORS.map(({ layerId }) => layerId)
);

// legend symbols that the layer's popups repeat beside their titles
const LAYER_SYMBOLS = Object.freeze({
  lookouts: Object.freeze({ swatchColor: LOOKOUT_COLOR, swatchShape: 'circle' }),
  transmissionLines: Object.freeze({
    swatchColor: TRANSMISSION_LINE_COLOR,
    swatchClass: 'legend-swatch--line',
  }),
  fires: Object.freeze({ iconUrl: MARKER_ICON_URLS.fire }),
  prescribed: Object.freeze({ iconUrl: MARKER_ICON_URLS.prescribed }),
  fireHistoryPerimeters: Object.freeze({
    swatchColor: FIRE_HISTORY_COLOR,
    swatchOpacity: FIRE_HISTORY_FILL_OPACITY,
  }),
  fireHistoryIgnitions: Object.freeze({ swatchColor: FIRE_HISTORY_COLOR, swatchShape: 'circle' }),
  fireHistoryEarlierPerimeters: Object.freeze({
    swatchColor: FIRE_HISTORY_EARLIER_COLOR,
    swatchOpacity: FIRE_HISTORY_EARLIER_FILL_OPACITY,
  }),
  fireHistoryEarlierIgnitions: Object.freeze({
    swatchColor: FIRE_HISTORY_EARLIER_COLOR,
    swatchShape: 'circle',
    swatchOpacity: FIRE_HISTORY_EARLIER_IGNITION_OPACITY,
  }),
});

const FIRE_HISTORY_PERIMETER_LAYER_IDS = Object.freeze([
  LAYER_IDS.fireHistoryPerimetersOutgoingFill,
  LAYER_IDS.fireHistoryPerimetersOutgoingLine,
  LAYER_IDS.fireHistoryPerimetersFill,
  LAYER_IDS.fireHistoryPerimetersLine,
]);
const FIRE_HISTORY_IGNITION_LAYER_IDS = Object.freeze([
  LAYER_IDS.fireHistoryIgnitionsOutgoing,
  LAYER_IDS.fireHistoryIgnitions,
]);
// every legend row that draws fire history, so the timeline shows while any is on
const FIRE_HISTORY_LABELS = Object.freeze([
  LEGEND_LAYERS.fireHistoryPerimeters,
  LEGEND_LAYERS.fireHistoryIgnitions,
  LEGEND_LAYERS.fireHistoryEarlierPerimeters,
  LEGEND_LAYERS.fireHistoryEarlierIgnitions,
]);
// the timeline's year, and the year it just left while that one fades out
const FIRE_HISTORY_YEAR_LAYER_IDS = Object.freeze([
  LAYER_IDS.fireHistoryPerimetersFill,
  LAYER_IDS.fireHistoryPerimetersLine,
  LAYER_IDS.fireHistoryIgnitions,
]);
const FIRE_HISTORY_OUTGOING_LAYER_IDS = Object.freeze([
  LAYER_IDS.fireHistoryPerimetersOutgoingFill,
  LAYER_IDS.fireHistoryPerimetersOutgoingLine,
  LAYER_IDS.fireHistoryIgnitionsOutgoing,
]);
const FIRE_HISTORY_CLICK_LAYER_IDS = Object.freeze([
  LAYER_IDS.fireHistoryIgnitions,
  LAYER_IDS.fireHistoryIgnitionsEarlier,
  LAYER_IDS.fireHistoryPerimetersFill,
  LAYER_IDS.fireHistoryPerimetersEarlierFill,
]);

// features that take a click ahead of whatever lies under them
const MARKER_LAYER_IDS = Object.freeze([
  ...CAMERA_LAYER_IDS,
  ...DIGITIZED_CAMERA_LAYER_IDS,
  LAYER_IDS.fires,
  LAYER_IDS.perimetersFill,
  LAYER_IDS.prescribed,
  LAYER_IDS.lookouts,
  ...FIRE_HISTORY_CLICK_LAYER_IDS,
]);
const INTERACTIVE_LAYER_IDS = Object.freeze([...MARKER_LAYER_IDS, LAYER_IDS.transmissionLinesHit]);

// marker sizes use CSS pixels
const CAMERA_MARKER_SIZE = 20;
const PRESCRIBED_MARKER_SIZE = 18;

// each [minimum zoom, size] pair selects a prerendered official camera marker
// steps sit on whole zooms because Mapbox lays out symbols at tile zoom
const CAMERA_MARKER_SIZES = [
  [0, 12],
  [6, 15],
  [7, 17],
  [8, CAMERA_MARKER_SIZE],
];

// each [minimum acres, size] pair selects a prerendered fire marker
const FIRE_MARKER_SIZES = [
  [0, 14],
  [1, 16],
  [10, 18],
  [100, 20],
  [1_000, 24],
  [10_000, 28],
];

// render control shells before Mapbox and providers finish loading
initAbout();

// rows left out of js/visible-content.js are kept aside so their layers stay off
const legendRows = visibleLegendItems(legendItems(), VISIBLE_LAYERS);
const REMOVED_LAYER_LABELS = new Set(legendRows.removed.map(({ label }) => label));
const legendControl = initLegend(legendRows.visible);

// a preset row found unchecked was switched off by the user, so it is theirs now
legendControl.onChange(() => {
  for (const label of presetLayersOn) {
    if (!legendControl.isChecked(label)) presetLayersOn.delete(label);
  }
});

const resultsControl = initResultsPanel({
  getMap: () => activeMap,
  getBasemap,
  getMapCanvas: () => activeMap?.getCanvas(),
  getLegendItems: () => [...document.querySelectorAll('#legend .legend-row')]
    .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
    .filter((row) => !row.hidden && !row.closest('.legend-group[hidden]'))
    .map((row) => row.dataset.legendLabel ?? row.querySelector('.legend-label')?.textContent?.trim())
    .filter(Boolean),
  getSelectionLegendItems: selectionLegendItems,
  // the summary report lists each area inside a combined option, e.g. every ODF district
  getMemberFeatures: (type, ids) => ids
    .map((id) => divisionFeatures.get(type)?.get(id))
    .filter(Boolean),
  // clears the picked option but keeps the filter panel on its current type
  onClose: () => filterControl.clearSelection(),
});

// the year the fire history layers last drew, so the next one knows which year to fade out
let shownFireHistoryYear = null;
// one request per fire history file, shared by its selected and earlier year rows
const fireHistoryFiles = new Map();

// the year slider rides over the map and only shows while a fire history row is on
const fireHistoryTimeline = initFireHistoryTimeline(
  document.querySelector('.map-panels'),
  (year) => {
    labelFireHistoryExport(year);
    if (activeMap) applyFireHistoryYear(activeMap, year);
  }
);

const filterControl = initFilterPanel({
  types: FILTER_TYPES.map(({ value, label, group }) => ({
    value, label, group, parent: nestedFilterParent(value, FILTER_TYPES),
  })),
  loadOptions: loadFilterOptions,
  searchOptions: searchFilterOptions,
  onTypeSelected: typeSelected,
  onSelection: optionSelected,
  onClear: clearFilter,
});

// wait for the base style before registering application layers
mapReady
  .then(waitForMapLoad)
  .then(loadMapLayers)
  .catch((error) => console.error('Failed to initialize map:', error))
  .finally(hideMapLoading);

// cached styles are ready now; otherwise wait for the first load event
function waitForMapLoad(map) {
  // an already-loaded style can proceed without waiting for another event
  if (map.loaded()) return markLoad('style loaded', map);

  return new Promise((resolve) => {
    map.once('load', () => resolve(markLoad('style loaded', map)));
  });
}

// timings show in the devtools performance panel, or list them with
// performance.getEntriesByType('mark').filter(({ name }) => name.startsWith('owdcic:'))
// startTime is milliseconds since the page started loading
function markLoad(name, value) {
  performance.mark(`owdcic: ${name}`);
  return value;
}

// register empty layers while providers run, then hydrate each source as ready
async function loadMapLayers(map) {
  activeMap = map;
  const canvas = map.getCanvas();
  // keyboard users need a focusable canvas for map shortcuts
  if (canvas && canvas.tabIndex < 0) canvas.tabIndex = 0;
  // start requests before source and marker setup finishes
  const data = loadLayerData();

  // install empty sources and interaction layers before provider requests settle
  addRegionFocusLayers(map);
  addContextLayers(map);
  addBoundaryLayers(map);
  // filter options can load only after their map sources exist
  resolveFilterSources();
  // a link that names a filter opens it as soon as its options can load
  applyAnchor();

  // home fires before its camera animation starts
  map.on(MAP_HOME_EVENT, home);
  bindApplicationSourceErrors(map);
  addViewshedLayers(map);
  addFireHistoryLayers(map);
  addPerimeterLayers(map);
  addLookoutLayer(map);

  await Promise.all([
    addFireLayer(map),
    addCameraLayers(map),
  ]);

  // symbol ordering depends on marker images and layers already being installed
  // prescribed burns draw above the other markers
  await addPrescribedLayer(map);

  orderDivisionLayers(map);

  // rebuild marker images when display density changes
  watchMarkerIconDensity(map);

  // Mapbox visibility can now follow the startup legend
  legendControl.connect(map);

  // removed layers have no checkbox to follow, so switch them off here
  for (const { layerIds } of legendRows.removed) {
    for (const layerId of layerIds) setLayerVisible(map, layerId, false);
  }

  bindDigitizedCameraUnlock(map);
  // a filter preset may have switched a row on before the map connected
  legendControl.onChange(() => loadDeferredLayers(map));
  loadDeferredLayers(map);
  legendControl.onChange(syncFireHistoryTimeline);
  syncFireHistoryTimeline();

  // slow providers hydrate in the background after the map becomes usable
  hideMapLoading();
  markLoad('map usable');
  // fetch camera metrics now so the first camera pick is not waiting on them
  loadCameraMetrics();

  await Promise.all([
    data.regionFocus.then((regionFocus) => {
      setSourceData(map, LAYER_IDS.regionFocusSource, regionFocus);
      markLoad('region outline loaded');
    }),
    // the camera filter lists every provider, so it waits for all of them
    Promise.all([
      hydrateLegendLayer(
        LEGEND_LAYERS.alertWestCameras,
        Promise.all([data.cameras, data.viewshedManifest, data.alertWestSites]),
        ([cameras, viewshedManifest, sites]) => {
          // sites kept out of the API still get a marker, drawn from the sites file
          const allCameras = { features: [...cameras.features, ...outsideApiSitesToCameras(sites)] };
          // selection ids must be attached before features reach either UI
          const features = attachViewshedIds(allCameras, viewshedManifest, sites).features;
          setSourceData(map, LAYER_IDS.cameras, { type: 'FeatureCollection', features });
          return features;
        }
      ),
      ...SITE_FILE_PROVIDERS.map(({ operator, dataKey, cameraLabel, cameraLayerId }) =>
        hydrateLegendLayer(cameraLabel, data[dataKey], (sites) => {
          // provider sites already carry their viewshed ids
          const cameras = providerSitesToCameras(sites, operator);
          setSourceData(map, cameraLayerId, cameras);
          return cameras.features;
        })
      ),
    ]).then((providerFeatures) => {
      // a failed provider contributes no cameras rather than blocking the filter
      cameraFeatures = providerFeatures.flatMap((features) => features ?? []);
      camerasLoaded = true;
      resolveCameraFeatures(cameraFeatures);
    }),
    hydrateLegendLayer(
      LEGEND_LAYERS.alertWestViewsheds,
      data.viewshedManifest,
      (viewshedManifest) => {
        // describe the manifest count and provider radius cap beside its legend row
        legendControl.updateInfo(
          LEGEND_LAYERS.alertWestViewsheds,
          `Contains ${viewshedEntries(viewshedManifest).filter(({ status }) => status === 'complete').length} camera viewsheds from ALERTWest, capped at a 12mi maximum radius`
        );
      }
    ),
    ...SITE_FILE_PROVIDERS.map(({ operator, dataKey, viewshedLabel, viewshedTileset }) =>
      hydrateLegendLayer(viewshedLabel, data[dataKey], (sites) => {
        // an unpublished tileset keeps the error its legend row already shows
        if (!viewshedTileset) return;
        // pending sites may have heights but do not have published coverage yet
        const modeled = providerSitesToCameras(sites, operator).features
          .filter((feature) => feature.properties.viewshed_id);
        legendControl.updateInfo(
          viewshedLabel,
          `Contains ${modeled.length} camera viewsheds from ${operator}, capped at a 12mi maximum radius`
        );
      })
    ),
    hydrateLegendLayer(
      LEGEND_LAYERS.fires,
      Promise.all([data.fires, data.perimeters]),
      ([fires, perimeters]) => {
        // marker sizing reads acreage from this local field
        setSourceData(
          map,
          LAYER_IDS.fires,
          addNumericProperty(fires, 'acres', ['IncidentSize'])
        );
        setSourceData(map, LAYER_IDS.perimetersSource, perimeters);
      }
    ),
    hydrateLegendLayer(
      'Prescribed fires (Watch Duty)',
      data.prescribed,
      (prescribed) => {
        setSourceData(map, LAYER_IDS.prescribedSource, prescribed);
      }
    ),
    hydrateLegendLayer('Standing lookouts', data.lookouts, (lookouts) => {
      setSourceData(map, LAYER_IDS.lookouts, lookouts);
    }),
  ]);
  markLoad('startup data loaded');
  preloadAfterStartup(map);
}

// fetch what the first chart and the forest layer need once startup is done,
// so neither holds up the first map but neither makes a later click wait
function preloadAfterStartup(map) {
  const whenIdle = window.requestIdleCallback ?? ((callback) => window.setTimeout(callback, 1_000));
  whenIdle(() => {
    loadPlotly();
    loadDeferredLayers(map, { preload: true });
  });
}

async function hydrateLegendLayer(label, dataPromise, applyData) {
  try {
    // keep data failures visible to the caller while always ending the spinner
    return applyData(await dataPromise);
  } finally {
    legendControl.setLoading(label, false);
    markLoad(`${label} loaded`);
  }
}

function addContextLayers(map) {
  const beforeId = LAYER_IDS.outsideRegionFill;

  // overlays start hidden so the legend controls the first visible map
  map.addSource(LAYER_IDS.burnProbabilitySource, {
    type: 'raster',
    tiles: [DATA_URLS.burnProbabilityTiles],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 16,
    bounds: [-124.85, 41.9, -116.4, 46.35],
  });
  map.addLayer({
    id: LAYER_IDS.burnProbability,
    type: 'raster',
    source: LAYER_IDS.burnProbabilitySource,
    layout: { visibility: 'none' },
    paint: burnProbabilityPaint(),
  }, beforeId);

  map.addSource(LAYER_IDS.blmLandsSource, {
    type: 'raster',
    tiles: [DATA_URLS.blmLandTiles],
    tileSize: 256,
    maxzoom: 14,
  });
  map.addLayer({
    id: LAYER_IDS.blmLands,
    type: 'raster',
    source: LAYER_IDS.blmLandsSource,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.68 },
  }, beforeId);

  addGeoJSONSource(map, LAYER_IDS.nationalForestsSource);
  map.addLayer({
    id: LAYER_IDS.nationalForestsFill,
    type: 'fill',
    source: LAYER_IDS.nationalForestsSource,
    layout: { visibility: 'none' },
    paint: {
      'fill-color': NATIONAL_FOREST_COLOR,
      'fill-opacity': 0.28,
    },
  }, beforeId);
  map.addLayer({
    id: LAYER_IDS.nationalForestsLine,
    type: 'line',
    source: LAYER_IDS.nationalForestsSource,
    layout: { visibility: 'none' },
    paint: {
      'line-color': NATIONAL_FOREST_COLOR,
      'line-width': 1.25,
    },
  }, beforeId);

  addGeoJSONSource(map, LAYER_IDS.transmissionLinesSource);
  map.addLayer({
    id: LAYER_IDS.transmissionLines,
    type: 'line',
    source: LAYER_IDS.transmissionLinesSource,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': TRANSMISSION_LINE_COLOR,
      // px per unit of class width, by zoom level
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        5, ['*', 0.4, TRANSMISSION_LINE_WIDTH],
        9, ['*', 0.7, TRANSMISSION_LINE_WIDTH],
        13, ['*', 1.2, TRANSMISSION_LINE_WIDTH],
      ],
    },
  }, beforeId);

  // the drawn lines are too thin to click, so an unseen wider copy takes the pointer
  map.addLayer({
    id: LAYER_IDS.transmissionLinesHit,
    type: 'line',
    source: LAYER_IDS.transmissionLinesSource,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 10, 'line-opacity': 0 },
  }, beforeId);

  bindLayerInteractions(map, LAYER_IDS.transmissionLinesHit, {
    ...featureInfo('transmissionLine', LAYER_SYMBOLS.transmissionLines),
    click: (clickedMap, event) => {
      // markers above the line keep priority for taps
      if (hasInteractiveFeatureAtPoint(clickedMap, event.point, MARKER_LAYER_IDS)) return;
      showFeaturePopup(clickedMap, event, 'transmissionLine', LAYER_SYMBOLS.transmissionLines);
    },
  });
}

// layers that are off at startup and slow or heavy to fetch wait until their row is switched on
// preload also fetches the ones worth having before they are asked for
function loadDeferredLayers(map, { preload = false } = {}) {
  // the lines are a couple of megabytes
  loadLayerWhenChecked(map, LEGEND_LAYERS.transmissionLines, LAYER_IDS.transmissionLinesSource, {}, () =>
    fetchJson(DATA_URLS.transmissionLines, 'Transmission lines')
  );
  // the selected and earlier rows of each type draw from one file, fetched once for both;
  // each file widens the timeline to the years it covers
  for (const [labels, sourceId, url] of [
    [[LEGEND_LAYERS.fireHistoryPerimeters, LEGEND_LAYERS.fireHistoryEarlierPerimeters],
      LAYER_IDS.fireHistoryPerimetersSource, DATA_URLS.fireHistoryPerimeters],
    [[LEGEND_LAYERS.fireHistoryIgnitions, LEGEND_LAYERS.fireHistoryEarlierIgnitions],
      LAYER_IDS.fireHistoryIgnitionsSource, DATA_URLS.fireHistoryIgnitions],
  ]) {
    for (const label of labels) {
      if (layerIsRemoved(label)) continue;
      loadLayerWhenChecked(map, label, sourceId, {}, () => loadFireHistoryFile(url, label));
    }
  }
  // the Forest Service query is the slowest request the map makes
  loadLayerWhenChecked(map, LEGEND_LAYERS.nationalForests, LAYER_IDS.nationalForestsSource, { preload }, () =>
    fetchArcGISGeoJSON(DATA_URLS.nationalForests, {
      where: "ownerclassification='USDA FOREST SERVICE'",
      outFields: 'ownerclassification,forestname',
      orderByFields: 'objectid',
      geometry: REGION_DATA_BOUNDS.flat().join(','),
      geometryType: 'esriGeometryEnvelope',
      // bounds are longitude and latitude, so tell ArcGIS their input CRS
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      geometryPrecision: '4',
      maxAllowableOffset: '0.005',
    })
  );
}

function loadLayerWhenChecked(map, label, sourceId, { preload = false }, loader) {
  if (deferredLayerLoads.has(label) || !(preload || legendControl.isChecked(label))) return;

  legendControl.setLoading(label, true);
  deferredLayerLoads.set(label, hydrateLegendLayer(
    label,
    safelyLoadLegend(label.toLowerCase(), label, loader),
    (data) => setSourceData(map, sourceId, data)
  ));
}

// QWRA tiles encode pre-classed colors rather than raw probability values
// blue below ~0.196 maps red through dark brown classes (>= 0.002154)
function burnProbabilityPaint() {
  return {
    'raster-opacity': 0.72,
    'raster-resampling': 'nearest',
    'raster-color-mix': [0, 0, 1, 0],
    'raster-color-range': [0, 1],
    'raster-color': [
      'step',
      // byte classes are normalized to the raster-value range from 0 to 1
      ['raster-value'],
      'rgb(89, 25, 0)',
      13 / 255, 'rgb(128, 0, 38)',
      27 / 255, 'rgb(227, 26, 28)',
      33 / 255, 'rgb(189, 0, 38)',
      40 / 255, 'rgb(252, 78, 42)',
      50 / 255, 'rgba(0, 0, 0, 0)',
    ],
  };
}

function addBoundaryLayers(map) {
  for (const division of DIVISION_TYPES) {
    // label points stay separate so text placement does not depend on polygon shape
    map.addSource(division.sourceId, {
      type: 'geojson',
      data: emptyFeatureCollection(),
    });
    map.addSource(division.labelSourceId, {
      type: 'geojson',
      data: emptyFeatureCollection(),
    });

    map.addLayer({
      id: division.fillLayerId,
      type: 'fill',
      source: division.sourceId,
      filter: WHOLE_AREA_FILTER,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': BOUNDARY_FILL_COLOR,
        'fill-opacity': 0.065,
      },
    });

    // hover is a separate translucent layer so the base fill stays neutral
    map.addLayer({
      id: division.hoverLayerId,
      type: 'fill',
      source: division.sourceId,
      filter: divisionFilterExpression(NO_DIVISION_SELECTED),
      layout: { visibility: 'none' },
      paint: {
        'fill-color': SELECTED_BOUNDARY_COLOR,
        'fill-opacity': 0.13,
      },
    });

    // outlines use zoom-based widths to stay visible at both regional and local scales
    map.addLayer({
      id: division.layerId,
      type: 'line',
      source: division.sourceId,
      filter: WHOLE_AREA_FILTER,
      layout: { visibility: 'none' },
      paint: {
        'line-color': BOUNDARY_COLOR,
        'line-opacity': 0.38,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 0.8,
          9, 1.35,
          13, 2,
        ],
        'line-emissive-strength': 0.65,
      },
    });

    // labels consume the precomputed point source registered when options load
    map.addLayer({
      id: division.labelLayerId,
      type: 'symbol',
      source: division.labelSourceId,
      layout: {
        visibility: 'none',
        'text-field': ['coalesce', ['get', 'shortName'], ['get', 'name']],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 10,
          8, 11.5,
          12, 13,
        ],
        'text-max-width': 9,
        'text-padding': 5,
        'text-variable-anchor': ['center', 'top', 'bottom'],
        'text-radial-offset': 0.35,
      },
      paint: {
        'text-color': '#334553',
        'text-halo-color': 'rgba(255, 255, 255, 0.94)',
        'text-halo-width': 1.5,
        'text-halo-blur': 0.25,
      },
    });

    // selected outline uses its own filter so hover can remain transient
    map.addLayer({
      id: division.selectedLayerId,
      type: 'line',
      source: division.sourceId,
      filter: divisionFilterExpression(NO_DIVISION_SELECTED),
      layout: { visibility: 'none' },
      paint: {
        'line-color': SELECTED_BOUNDARY_COLOR,
        'line-opacity': 1,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 3,
          9, 4.5,
          13, 6,
        ],
        'line-emissive-strength': 1,
      },
    });

    bindDivisionInteractions(map, division);
  }
}

async function loadFilterOptions(typeValue) {
  await filterSourcesReady;
  if (typeValue === 'camera') {
    // camera choices depend on the provider hydration, not just map setup
    const features = await cameraFeaturesReady;
    const providerNames = CAMERA_PROVIDERS.map(({ name }) => name);
    // numeric collation keeps labels like Camera 2 ahead of Camera 10
    const cameraOptions = features.map((feature) => ({
      value: cameraOptionId(feature),
      label: feature.properties?.name || 'Camera',
      // live ALERTWest features carry no operator, so they fall back to the first provider
      group: feature.properties?.operator || providerNames[0],
    })).sort((a, b) =>
      // the panel lists groups in the order they first appear, so keep providers together
      providerNames.indexOf(a.group) - providerNames.indexOf(b.group) ||
      LABEL_COLLATOR.compare(a.label, b.label));
    // camera names are already short and are kept whole
    anchorSlugsByType.set(typeValue, anchorOptionSlugs(cameraOptions, { shorten: false }));
    return cameraOptions;
  }

  const options = await loadDivisionOptions(activeMap, typeValue);
  anchorSlugsByType.set(typeValue, anchorOptionSlugs(options));
  return options;
}

// open the filter named by the URL query string; unknown names leave the page as it is
async function applyAnchor() {
  const request = ++anchorRequest;
  const anchor = parseAnchor(window.location.search);
  if (!anchor) return;

  const type = anchorType(FILTER_TYPES, anchor.type);
  if (!type) return;
  if (!anchor.option) {
    await filterControl.selectType(type.value);
    return;
  }

  try {
    await loadFilterOptions(type.value);
  } catch (error) {
    console.error('Unable to open anchor link:', error);
    return;
  }

  // a newer link or selection owns the page if these options loaded late
  if (request !== anchorRequest) return;
  const id = anchorOptionValue(anchorSlugsByType.get(type.value), anchor.option);

  // an option that no longer exists still lands on its filter type
  if (id == null || !(await filterControl.select(type.value, id))) {
    await filterControl.selectType(type.value);
  }
}

// record the current filter in the URL query string without adding a history entry
async function writeAnchor(type, id) {
  const request = ++anchorRequest;
  // filter types left out of js/visible-content.js have no link
  const typeSlug = anchorSlug(FILTER_TYPES.find(({ value }) => value === type)?.label);
  let optionSlug = null;

  if (typeSlug && id != null) {
    // a map click can pick an option before its filter list has ever loaded
    if (!anchorSlugsByType.has(type)) await loadFilterOptions(type).catch(() => {});
    if (request !== anchorRequest) return;
    optionSlug = anchorSlugsByType.get(type)?.get(`${id}`) ?? null;
  }

  // a pick with no link of its own must not leave another selection's link behind
  const linkable = id == null || optionSlug || activeFilterType === type;
  if (linkable) setAnchor(typeSlug, optionSlug);
  else setAnchor('');
}

function setAnchor(typeSlug, optionSlug) {
  const { pathname, search, hash } = window.location;
  // other query parameters stay as they are
  const next = formatAnchor(typeSlug, optionSlug, search);
  if (search === next) return;
  window.history.replaceState(null, '', `${pathname}${next}${hash}`);
}

async function loadDivisionOptions(map, typeValue) {
  const division = divisionType(typeValue);
  if (!division) throw new Error(`Unknown division type: ${typeValue}`);

  const data = await loadDivisionData(division);

  // a combined option has no shape of its own on the map, so clicks and labels land on its members
  const drawn = data.features.filter((feature) => !isCombinedDivision(feature));
  // keep full geometry for hit testing and selection, labels use compact points;
  // portions stay in the source only so a state option can outline its own side of the line
  setSourceData(map, division.sourceId, { ...data, features: drawn });
  const labelled = drawn.filter((feature) => !isDivisionPortion(feature));

  // precomputed label points keep text placement independent of polygon geometry
  setSourceData(map, division.labelSourceId, {
    type: 'FeatureCollection',
    features: labelled.flatMap((feature) => {
      const coordinates = feature.properties?.labelPoint;
      // malformed or missing label points should not block the polygon options
      if (!Array.isArray(coordinates) || coordinates.length !== 2 ||
          !coordinates.every(Number.isFinite)) return [];
      return [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: {
          name: feature.properties.name,
          shortName: feature.properties.shortName,
        },
      }];
    }),
  });

  return divisionOptions(division, data.features);
}

// names-only options for the panel search, so typing never downloads geometry
async function searchFilterOptions(typeValue) {
  if (typeValue === 'camera') return loadFilterOptions(typeValue);
  const division = divisionType(typeValue);
  if (!division) throw new Error(`Unknown division type: ${typeValue}`);

  divisionOptionsIndex ??= fetchJson(DATA_URLS.divisionOptions, 'Division options')
    .catch((error) => {
      // let a later search retry after network or parse failure
      divisionOptionsIndex = null;
      throw error;
    });
  const properties = (await divisionOptionsIndex)[typeValue] ?? [];
  return divisionOptions(division, properties
    .filter((entry) => filterOptionIsVisible(division, entry))
    .map((entry) => ({ properties: entry })));
}

// the menu entries for a division type, from full features or the names-only index
function divisionOptions(division, features) {
  const typeValue = division.value;
  return features.filter((feature) => !isDivisionPortion(feature)).map((feature) => ({
    value: feature.properties.divisionId,
    label: typeValue === 'utility'
      ? `${feature.properties.label}`
      : feature.properties.label,
    state: feature.properties.state,
    combined: isCombinedDivision(feature),
    rank: filterOptionRank(division, feature.properties),
    // the combined option stays first, then listed options keep their order from
    // js/visible-content.js, and ties fall back to the label
  })).sort((a, b) => b.combined - a.combined || a.rank - b.rank
    || LABEL_COLLATOR.compare(a.label, b.label));
}

// an option that stands for several others, e.g. All ODF districts; it lists them in memberDivisionIds
function isCombinedDivision(feature) {
  return Array.isArray(feature?.properties?.memberDivisionIds);
}

// the part of an area inside one state, e.g. Umatilla's Oregon portion in Oregon National Forests
function isDivisionPortion(feature) {
  return Boolean(feature?.properties?.partOfDivisionId);
}

function cameraOptionId(feature) {
  const properties = feature.properties || {};
  // some camera feeds lack ids, so use name and coordinates as a fallback
  return String(properties.id ?? properties.viewshed_id ??
    `${properties.name}|${feature.geometry?.coordinates?.join(',')}`);
}

function cameraFeatureById(cameraId) {
  // normalize ids because menu values and provider properties may differ in type
  return cameraFeatures.find((item) => cameraOptionId(item) === String(cameraId));
}

function polygonFilterIsActive() {
  return polygonSelected && Boolean(activeFilterType && activeFilterType !== 'camera');
}

// show or hide one legend layer by label through the checkbox path
// returns false for unknown labels; safe before the map connects
function setLayerVisibility(label, visible) {
  // presets may name a layer that js/visible-content.js currently leaves out
  if (layerIsRemoved(label)) return false;
  const found = legendControl.setVisible(label, visible);
  if (!found) console.warn(`Unknown legend layer: ${label}`);
  return found;
}

function layerIsRemoved(label) {
  return legendRows.removed.some((item) =>
    item.label === label || item.children?.some((child) => child.label === label));
}

// apply the configured basemap and layer toggles for a filter type
// types without a preset leave the current view untouched
function applyLayerPresetForFilter(filterType) {
  const preset = layerPresetForFilter(filterType);
  if (!preset) return;

  // off runs first so a label listed in both ends up visible
  for (const label of preset.layersOff ?? []) setLayerVisibility(label, false);
  for (const label of preset.layersOn ?? []) {
    // a row that was already on is the user's choice and stays on later
    const wasOff = !legendControl.isChecked(label);
    if (setLayerVisibility(label, true) && wasOff) presetLayersOn.add(label);
  }

  if (preset.basemap) {
    setBasemap(preset.basemap).catch((error) => {
      console.error('Failed to apply preset basemap:', error);
    });
  }
}

// switch off the rows the last preset turned on, once its filter type is left
function hidePresetLayers() {
  const labels = [...presetLayersOn];
  presetLayersOn.clear();
  for (const label of labels) setLayerVisibility(label, false);
}

// list category change resets map selection and stale camera requests
function typeSelected(type) {
  // invalidate pending camera metrics before the old result panel is cleared
  cameraResultRequest += 1;
  polygonSelected = false;

  // dropping the picked option reselects the same type, which keeps its layers
  if ((type || null) !== activeFilterType) hidePresetLayers();
  activeFilterType = type || null;
  if (type) applyLayerPresetForFilter(type);

  // null is the brief gap while options load, so the link waits for the real type
  if (type) writeAnchor(type);

  if (activeMap) {
    clearDivisionFilter(activeMap);
    if (type && type !== 'camera') showDivisionType(activeMap, type);
    selectCameraViewshed(activeMap, null);
  }

  resultsControl.clear();
}

// list picks and map polygon clicks use the same selection path
function optionSelected(type, id) {
  if (!activeMap || !id) return;
  activeFilterType = type;
  if (type === 'camera') {
    const feature = cameraFeatureById(id);
    if (!feature) {
      console.warn(`Camera ${id} is not available`);
      return;
    }
    showCameraResult(activeMap, feature);
    return;
  }

  // area results replace any camera request still waiting on coverage metrics
  // a new area selection drops any camera viewshed highlight
  cameraResultRequest += 1;
  polygonSelected = true;
  selectCameraViewshed(activeMap, null);
  selectDivision(activeMap, type, id);
  writeAnchor(type, id);
}

async function polygonClicked(type, id) {
  if (!type || !id) return;
  // use the filter panel path when its options are ready so both controls stay in sync
  const synced = await filterControl.select(type, id);
  // map selection still works before its option list finishes loading
  if (!synced) optionSelected(type, id);
}

async function cameraClicked(cameraId, mapFeature) {
  if (!activeMap || cameraId == null || cameraId === '') return;

  // prefer the canonical loaded feature but accept the rendered feature during startup
  const feature = cameraFeatureById(cameraId) || mapFeature;
  if (!feature) return;

  selectCameraViewshed(activeMap, feature.properties?.viewshed_id, feature.properties?.name);

  // keep polygon details in the result panel while highlighting the camera
  if (polygonFilterIsActive()) return;

  if (activeFilterType === 'camera') {
    // selecting the matching row preserves the filter panel's active choice
    const synced = await filterControl.select('camera', cameraOptionId(feature));
    if (!synced) showCameraResult(activeMap, feature);
    return;
  }

  showCameraResult(activeMap, feature);
}

function clearFilter() {
  // prevent a late metrics response from refilling the cleared panel
  cameraResultRequest += 1;
  polygonSelected = false;
  activeFilterType = null;
  hidePresetLayers();

  if (activeMap) {
    clearDivisionFilter(activeMap);
    selectCameraViewshed(activeMap, null);
  }

  filterControl.setClearEnabled?.(false);
  resultsControl.clear();
  writeAnchor(null);
}

function home() {
  // map home fires before the camera animation begins
  filterControl.reset();
}

function enableClearForResult() {
  // camera-only results have no active type, so the menu would leave Clear off
  filterControl.setClearEnabled?.(true);
}

async function showCameraResult(map, feature) {
  // each selection owns a token; only its latest response may update the panel
  const request = ++cameraResultRequest;
  const properties = feature.properties || {};
  selectCameraViewshed(map, properties.viewshed_id, properties.name);
  enableClearForResult();
  resultsControl.showLoading(properties.name || 'Camera');
  writeAnchor('camera', cameraOptionId(feature));

  const metricsById = await loadCameraMetrics();
  // a newer pick owns the panel if this request finished late
  if (request !== cameraResultRequest) return;

  const viewshedId = properties.viewshed_id;
  const metrics = viewshedId
    // accept both the wrapped and legacy id-keyed data shapes
    ? metricsById.viewsheds?.[viewshedId] ?? metricsById[viewshedId] ?? null
    : null;
  resultsControl.showCamera(properties, metrics, feature);
  collapseControlsOnNarrowScreen();
  fitMapToCamera(map, feature);
}

// share one metrics request across camera picks
function loadCameraMetrics() {
  cameraMetricsLoad ??= fetchJson(DATA_URLS.cameraCoverage, 'Camera coverage')
    .catch((error) => {
      cameraMetricsLoad = null;
      console.error('Failed to load camera coverage:', error);
      return {};
    });
  return cameraMetricsLoad;
}

function showDivisionType(map, typeValue) {
  const selected = divisionType(typeValue);

  // clear hidden categories too so switching back cannot reveal stale highlights
  for (const division of DIVISION_TYPES) {
    const visible = division === selected;
    for (const layerId of divisionLayerIds(division)) {
      setLayerVisible(map, layerId, visible);
    }
    setDivisionLayerFilter(map, division, NO_DIVISION_SELECTED);
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  }
}

function loadDivisionData(division) {
  if (!divisionLoads.has(division.value)) {
    // share one request per category across menu and map interactions
    const load = fetchJson(division.dataUrl, `${division.label} data`)
      .then((data) => {
        if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          throw new Error(`${division.label} data is not a FeatureCollection`);
        }

        const unmatched = unmatchedFilterOptions(division, data.features);
        if (unmatched.length) {
          console.warn(`VISIBLE_FILTERS lists unknown ${division.label} options:`, unmatched);
        }

        // options left out of js/visible-content.js are dropped before the menu, map, and selection see them
        const visible = data.features.filter((feature) =>
          filterOptionIsVisible(division, feature.properties));

        // retain source features for result details and later bounds fitting
        const features = new Map(
          visible.map((feature) => [feature.properties?.divisionId, feature])
        );
        divisionFeatures.set(division.value, features);
        markLoad(`${division.label} areas loaded`);
        return { ...data, features: visible };
      })
      .catch((error) => {
        // let a later selection retry after network or parse failure
        divisionLoads.delete(division.value);
        console.error(`Failed to load ${division.label} divisions:`, error);
        throw error;
      });

    divisionLoads.set(division.value, load);
  }

  return divisionLoads.get(division.value);
}

function selectDivision(map, typeValue, divisionId) {
  const division = divisionType(typeValue);
  if (!division) return;

  const feature = divisionFeatures.get(typeValue)?.get(divisionId);
  // a combined option highlights every member together
  setDivisionLayerFilter(
    map,
    division,
    (isCombinedDivision(feature) ? feature.properties.memberDivisionIds : divisionId)
      || NO_DIVISION_SELECTED
  );

  if (!divisionId) {
    resultsControl.clear();
    return;
  }

  if (!feature) {
    console.warn(`Division ${divisionId} is not available`);
    resultsControl.clear();
    return;
  }

  resultsControl.showPolygon(typeValue, feature, polygonCameraCounts(feature));
  // an early selection fills in its camera counts once every provider has loaded
  if (!camerasLoaded) {
    cameraFeaturesReady.then(() => resultsControl.updatePolygonCameraCounts(feature, polygonCameraCounts(feature)));
  }
  collapseControlsOnNarrowScreen();
  fitMapToBounds(map, featureBounds(feature), { maxZoom: 10, duration: 800 });
}

// camera markers inside the area per provider, or null until the providers load
function polygonCameraCounts(feature) {
  if (!camerasLoaded) return null;
  // live ALERTWest features carry no operator, so they fall back to the first provider
  return countPointsInGeometry(
    { features: cameraFeatures },
    feature.geometry,
    (camera) => camera.properties?.operator || CAMERA_PROVIDERS[0].name,
  );
}

function clearDivisionFilter(map) {
  // hide every category and clear both hover and selected expressions
  for (const division of DIVISION_TYPES) {
    for (const layerId of divisionLayerIds(division)) {
      setLayerVisible(map, layerId, false);
    }
    setDivisionLayerFilter(map, division, NO_DIVISION_SELECTED);
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  }

  map.getCanvas().style.cursor = '';
}

function collapseControlsOnNarrowScreen() {
  // collapsing frees map width after the result panel opens on phones
  if (!window.matchMedia('(max-width: 900px)').matches) return;
  document.getElementById('control-sidebar')?._controlShellApi?.collapse();
}

function divisionType(value) {
  return DIVISION_TYPES.find((division) => division.value === value);
}

function setLayerVisible(map, layerId, visible) {
  // optional layers may not exist yet during startup
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

function setDivisionLayerFilter(map, division, divisionId) {
  if (map.getLayer(division.selectedLayerId)) {
    map.setFilter(division.selectedLayerId, divisionFilterExpression(divisionId));
  }
}

function setDivisionHoverFilter(map, division, divisionId) {
  if (map.getLayer(division.hoverLayerId)) {
    map.setFilter(division.hoverLayerId, divisionFilterExpression(divisionId));
  }
}

function divisionFilterExpression(divisionId) {
  // hover fill and selected outline share the same stable property
  if (Array.isArray(divisionId)) return ['in', ['get', 'divisionId'], ['literal', divisionId]];
  return ['==', ['get', 'divisionId'], divisionId];
}

function divisionLayerIds(division) {
  // visibility is shared by the fill, hover, outline, label, and selection layers
  return [
    division.fillLayerId,
    division.hoverLayerId,
    division.layerId,
    division.labelLayerId,
    division.selectedLayerId,
  ];
}

function bindDivisionInteractions(map, division) {
  map.on('mousemove', division.fillLayerId, (event) => {
    const divisionId = event.features?.[0]?.properties?.divisionId;
    // empty space inside a polygon can still return no feature during transitions
    if (!divisionId) return;

    map.getCanvas().style.cursor = 'pointer';
    setDivisionHoverFilter(map, division, divisionId);
  });

  map.on('mouseleave', division.fillLayerId, () => {
    map.getCanvas().style.cursor = '';
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  });

  map.on('click', division.fillLayerId, (event) => {
    // markers above the polygon keep priority for clicks
    if (hasInteractiveFeatureAtPoint(map, event.point)) return;

    const divisionId = event.features?.[0]?.properties?.divisionId;
    if (divisionId) polygonClicked(division.value, divisionId);
  });
}

function hasInteractiveFeatureAtPoint(map, point, candidateLayerIds = INTERACTIVE_LAYER_IDS) {
  // only query layers already installed during asynchronous setup
  const layerIds = candidateLayerIds.filter((layerId) => map.getLayer(layerId));

  return (
    layerIds.length > 0 &&
    map.queryRenderedFeatures(point, { layers: layerIds }).length > 0
  );
}

function orderDivisionLayers(map) {
  const firstPointLayer = [
    LAYER_IDS.lookouts,
    LAYER_IDS.fires,
    ...DIGITIZED_CAMERA_LAYER_IDS,
    ...CAMERA_LAYER_IDS,
    LAYER_IDS.prescribed,
  ].find((layerId) => map.getLayer(layerId));

  // boundaries stay below point markers while selected outlines sit above data
  for (const division of DIVISION_TYPES) {
    if (firstPointLayer) {
      for (const layerId of [
        division.hoverLayerId,
        division.layerId,
        division.labelLayerId,
      ]) {
        if (map.getLayer(layerId)) map.moveLayer(layerId, firstPointLayer);
      }
    }

    if (map.getLayer(division.selectedLayerId)) {
      map.moveLayer(division.selectedLayerId);
    }
  }
}

function fitMapToCamera(map, feature) {
  // GeoJSON points store longitude before latitude
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return;
  // reject malformed values before they reach Mapbox camera methods
  if (![coordinates[0], coordinates[1]].every(Number.isFinite)) return;

  afterPanelLayout(() => {
    map.easeTo({
      center: coordinates,
      // zoom in enough to inspect the marker without zooming out from a closer view
      zoom: Math.max(map.getZoom(), 8),
      duration: motionDuration(650),
      padding: mapPanelPadding(map),
    });
  });
}

function fitMapToBounds(map, bounds, { maxZoom = 10, duration = 800 } = {}) {
  if (!bounds) return;

  afterPanelLayout(() => {
    map.fitBounds(bounds, {
      duration: motionDuration(duration),
      maxZoom,
      padding: mapPanelPadding(map),
    });
  });
}

function afterPanelLayout(callback) {
  // two frames cover the panel update and its resulting responsive layout pass
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function featureBounds(feature) {
  const bbox = feature?.bbox;
  if (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((value) => Number.isFinite(Number(value)))
  ) {
    // GeoJSON bbox order is west, south, east, north
    const [west, south, east, north] = bbox.map(Number);
    return [[west, south], [east, north]];
  }

  // derive bounds when the feature has no usable bbox
  const coords = [];
  // handle Polygon and MultiPolygon nesting without assuming a fixed depth
  collectCoordinates(feature?.geometry?.coordinates, coords);
  if (!coords.length) return null;

  // reduce every coordinate to the outermost longitude and latitude
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const [lng, lat] of coords) {
    // invalid pairs should not poison the running extrema
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < west) west = lng;
    if (lat < south) south = lat;
    if (lng > east) east = lng;
    if (lat > north) north = lat;
  }

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return [[west, south], [east, north]];
}

function collectCoordinates(node, out) {
  if (!Array.isArray(node) || node.length === 0) return;
  // a numeric first item marks a coordinate pair; deeper arrays hold rings or polygons
  if (typeof node[0] === 'number') {
    out.push(node);
    return;
  }

  for (const child of node) collectCoordinates(child, out);
}

const VIEWSHED_TILE_RETRY_LIMIT = 1;

function bindApplicationSourceErrors(map) {
  let viewshedRetries = 0;
  let retrying = false;
  const viewshedLabels = new Map(
    CAMERA_PROVIDERS.map(({ viewshedSourceId, viewshedLabel }) => [viewshedSourceId, viewshedLabel])
  );

  // vector tile failures arrive as map errors rather than fetch rejections
  map.on('error', (event) => {
    const sourceId = event.sourceId;
    const label = viewshedLabels.get(sourceId);

    // vector tiles fail asynchronously, so there is no fetch promise to catch
    if (label) {
      const tileId = event.tile?.tileID?.canonical;
      console.warn(
        `${label} tile failed:`,
        tileId ? `${tileId.z}/${tileId.x}/${tileId.y}` : 'source metadata',
        event.error?.message
      );

      // mapbox keeps tiles in a CacheStorage bucket that survives hard reloads,
      // and Firefox can hand back a truncated copy of large tiles from it, so
      // flush that cache before refetching instead of rereading the bad copy
      if (viewshedRetries < VIEWSHED_TILE_RETRY_LIMIT && !retrying) {
        viewshedRetries += 1;
        retrying = true;
        mapboxgl.clearStorage(() => {
          retrying = false;
          // the flush emptied every source's cache, so refetch them all
          for (const viewshedSourceId of viewshedLabels.keys()) {
            map.getSource(viewshedSourceId)?.reload?.();
          }
        });
        return;
      }

      legendControl.setError(label, 'Camera viewshed tiles did not load');
    }
  });

  // tiles that load after an earlier failure should clear the error icon
  map.on('sourcedata', (event) => {
    const label = viewshedLabels.get(event.sourceId);
    if (!label) return;
    // errored tiles also count as settled, so require a tile that actually loaded
    if (event.dataType !== 'source' || event.tile?.state !== 'loaded') return;
    legendControl.clearError(label);
  });
}

// group provider requests so every layer can hydrate from its own result
function loadLayerData() {
  // launch the requests now before returning the bundle to map setup
  return {
    cameras: safelyLoadLegend(
      'ALERTWest cameras',
      LEGEND_LAYERS.alertWestCameras,
      loadAlertWestCameras
    ),

    panoSites: safelyLoadLegend('Pano AI cameras', LEGEND_LAYERS.panoCameras, () =>
      fetchJson(DATA_URLS.panoCameraSites, 'Pano AI camera sites')
    ),

    enviroVisionSites: safelyLoadLegend('EnviroVision cameras', LEGEND_LAYERS.enviroVisionCameras, () =>
      fetchJson(DATA_URLS.enviroVisionCameraSites, 'EnviroVision camera sites')
    ),

    alertWestSites: safelyLoadLegend('ALERTWest site locations', LEGEND_LAYERS.alertWestCameras, () =>
      fetchJson(DATA_URLS.alertWestCameraSites, 'ALERTWest site locations')
    ),

    fires: safelyLoadLegend('NIFC fires', LEGEND_LAYERS.fires, () =>
      // limit the service response to the two states covered by the map
      fetchArcGISGeoJSON(DATA_URLS.nifcFires, {
        where: "POOState IN ('US-OR','US-WA')",
        outFields: [
          'IncidentName',
          'IncidentSize',
          'PercentContained',
          'POOCounty',
          'POOState',
          'IncidentTypeCategory',
        ].join(','),
      })
    ),

    regionFocus: safelyLoad(
      'Oregon and Washington boundary',
      loadRegionFocusData
    ),

    perimeters: safelyLoadLegend('NIFC perimeters', LEGEND_LAYERS.fires, () =>
      fetchArcGISGeoJSON(
        DATA_URLS.nifcPerimeters,
        {
          where: "attr_POOState IN ('US-OR','US-WA')",
          outFields: [
            'poly_IncidentName',
            'attr_IncidentName',
            'poly_GISAcres',
            'attr_PercentContained',
            'attr_POOCounty',
            'attr_POOState',
            'attr_IncidentTypeCategory',
          ].join(','),
          // precision and offset use geographic-coordinate degrees for these results
          // simplify on the service so large perimeters stay compact in transit
          geometryPrecision: '3',
          maxAllowableOffset: '0.01',
        }
      )
    ),

    prescribed: safelyLoadLegend(
      'Watch Duty prescribed fires',
      'Prescribed fires (Watch Duty)',
      async () => {
        // envelope query reduces transfer; local bounds check trims edge spillover
        const geojson = await fetchArcGISGeoJSON(DATA_URLS.prescribedFires, {
          outFields: 'name,prescribed_date_start,watchduty_url,acreage',
          // filter at the service to avoid downloading records outside the region
          geometry: REGION_DATA_BOUNDS.flat().join(','),
          geometryType: 'esriGeometryEnvelope',
          spatialRel: 'esriSpatialRelIntersects',
        });

        // apply the same inclusive bounds to returned features
        return filterGeoJSONByBounds(geojson, REGION_DATA_BOUNDS);
      }
    ),

    viewshedManifest: safelyLoadLegend(
      'viewshed manifest',
      LEGEND_LAYERS.alertWestViewsheds,
      () => fetchJson(DATA_URLS.viewshedManifest, 'Viewshed manifest'),
      { viewsheds: [] }
    ),

    lookouts: safelyLoadLegend('standing lookouts', 'Standing lookouts', () =>
      fetchJson(DATA_URLS.standingLookouts, 'Standing lookouts')
    ),
  };
}

// keep digitized camera locations out of the normal UI and startup requests
function bindDigitizedCameraUnlock(map) {
  let sequenceIndex = 0;
  let sequenceStartedAt = 0;

  const resetSequence = () => {
    sequenceIndex = 0;
    sequenceStartedAt = 0;
  };

  const handleKeyDown = (event) => {
    // do not steal keystrokes from typing, IME composition, or key repeat
    if (
      event.repeat ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      isEditableKeyboardTarget(event.target)
    ) {
      resetSequence();
      return;
    }

    const now = performance.now();
    // the timeout is measured from the first key in the sequence
    if (
      sequenceStartedAt &&
      now - sequenceStartedAt > DIGITIZED_CAMERA_UNLOCK_TIMEOUT_MS
    ) {
      resetSequence();
    }

    const expectedKey = DIGITIZED_CAMERA_UNLOCK_SEQUENCE[sequenceIndex];
    if (event.key !== expectedKey) {
      // a mismatched key can immediately start a fresh sequence
      if (event.key === DIGITIZED_CAMERA_UNLOCK_SEQUENCE[0]) {
        sequenceIndex = 1;
        sequenceStartedAt = now;
      } else {
        resetSequence();
      }
      return;
    }

    if (sequenceIndex === 0) sequenceStartedAt = now;
    sequenceIndex += 1;
    if (sequenceIndex !== DIGITIZED_CAMERA_UNLOCK_SEQUENCE.length) return;

    // unlock once per page load so later key presses cannot repeat the request
    document.removeEventListener('keydown', handleKeyDown);
    unlockDigitizedCameraSources(map);
  };

  document.addEventListener('keydown', handleKeyDown);
}

async function unlockDigitizedCameraSources(map) {
  try {
    // install icons and hidden layers before exposing their legend controls
    await ensureDigitizedCameraLayers(map);
    // reconnect so new hidden layers follow the provider checkboxes
    legendControl.connect(map);
    legendControl.setHidden(DIGITIZED_CAMERA_GROUP_LABEL, false);
    await loadDigitizedCameraSources(map);
  } catch (error) {
    console.error('Unable to unlock digitized camera sources:', error);
  }
}

function isEditableKeyboardTarget(target) {
  if (!(target instanceof Element)) return false;
  // contenteditable=false descendants remain eligible for the shortcut
  return Boolean(
    target.closest(
      'input, select, textarea, [contenteditable]:not([contenteditable="false"])'
    )
  );
}

// share the load promise so repeated unlocks do not refetch the data
function loadDigitizedCameraSources(map) {
  digitizedCameraLoad ??= hydrateLegendLayer(
    DIGITIZED_CAMERA_GROUP_LABEL,
    safelyLoadLegend(
      'digitized camera sources',
      DIGITIZED_CAMERA_GROUP_LABEL,
      () =>
        fetchJson(
          DATA_URLS.digitizedCameraSources,
          'Digitized camera sources'
        )
    ),
    (digitizedCameras) => {
      setSourceData(
        map,
        LAYER_IDS.digitizedCamerasSource,
        digitizedCameras
      );
    }
  );

  return digitizedCameraLoad;
}

function ensureDigitizedCameraLayers(map) {
  digitizedCameraLayersLoad ??= addDigitizedCameraLayers(map);
  return digitizedCameraLayersLoad;
}

function safelyLoadLegend(label, legendLabel, loader, fallback) {
  // a removed layer resolves empty without requesting its data
  // camera loaders pass child row labels, so they always run for the filters and results
  if (REMOVED_LAYER_LABELS.has(legendLabel)) {
    return Promise.resolve(fallback ?? emptyFeatureCollection());
  }

  return safelyLoad(label, loader, fallback, (error) => {
    legendControl.setError(
      legendLabel,
      `${label} did not load: ${shortErrorMessage(error)}`
    );
  });
}

// one provider failure becomes an empty layer without blocking the others
async function safelyLoad(
  label,
  loader,
  fallback = emptyFeatureCollection(),
  onError
) {
  try {
    return await loader();
  } catch (error) {
    // return usable empty data so one provider cannot block unrelated layers
    console.error(`Failed to load ${label}:`, error);
    onError?.(error);
    return fallback;
  }
}

function shortErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 120);
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  // include a useful response code while keeping parse errors intact
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

// adapt ALERTWest records to the GeoJSON contract used by map sources
async function loadAlertWestCameras() {
  return camerasToGeoJSON(await fetchJson(CAMERA_API, 'Camera API'));
}

// picks a per-size value for the camera marker size at the current zoom
function cameraZoomStep(valueForSize) {
  const [[, smallestSize], ...largerSizes] = CAMERA_MARKER_SIZES;

  return [
    'step',
    ['zoom'],
    valueForSize(smallestSize),
    ...largerSizes.flatMap(([zoom, size]) => [zoom, valueForSize(size)]),
  ];
}

async function addCameraLayers(map) {
  const sizes = CAMERA_MARKER_SIZES.map(([, size]) => size);
  // register images before adding symbol layers that reference them
  await Promise.all(
    CAMERA_PROVIDERS.flatMap(({ iconId, iconUrl, privateIconId, privateIconUrl }) => [
      registerMarkerIconSizes(map, { id: iconId, url: iconUrl, sizes }),
      privateIconId && registerMarkerIconSizes(map, { id: privateIconId, url: privateIconUrl, sizes }),
    ])
  );

  for (const {
    cameraLayerId,
    iconId,
    iconUrl,
    privateIconId,
    privateIconUrl,
    sharedSiteIconOffset = [0, 0],
  } of CAMERA_PROVIDERS) {
    addGeoJSONSource(map, cameraLayerId);
    map.addLayer({
      id: cameraLayerId,
      type: 'symbol',
      source: cameraLayerId,
      layout: {
        // zoomed out, cameras shrink so dense areas stay readable
        ...markerLayout(cameraZoomStep((size) =>
          privateIconId
            ? ['case', ['==', ['get', 'outsideApi'], true], sizedIconId(privateIconId, size), sizedIconId(iconId, size)]
            : sizedIconId(iconId, size)
        )),
        // shared-site offsets are set for the full-size marker, so they shrink with it
        'icon-offset': cameraZoomStep((size) => [
          'case',
          ['==', ['get', 'sharesAlertWestSite'], true],
          ['literal', sharedSiteIconOffset.map((offset) => Math.round((offset * size) / CAMERA_MARKER_SIZE))],
          ['literal', [0, 0]],
        ]),
      },
    });

    // hovering names the camera; clicks and taps open details and select its viewshed
    bindLayerInteractions(map, cameraLayerId, {
      hover: {
        kind: 'camera',
        // same marker the camera is drawn with
        symbol: (feature) => ({
          iconUrl: privateIconUrl && feature.properties?.outsideApi ? privateIconUrl : iconUrl,
        }),
      },
      click: (clickedMap, event) => {
        const feature = event.features?.[0];
        if (feature) cameraClicked(cameraOptionId(feature), feature);
      },
      clickWithMouse: true,
    });
  }
}

async function addDigitizedCameraLayers(map) {
  const icons = new Map();
  // deduplicate shared joint-site artwork before parallel icon registration
  for (const operator of DIGITIZED_CAMERA_OPERATORS) {
    icons.set(operator.operationalIconId, operator.operationalIconUrl);
    icons.set(operator.plannedIconId, operator.plannedIconUrl);
  }

  await Promise.all(
    [...icons].map(([id, url]) =>
      registerMarkerIcon(map, {
        id,
        url,
        size: 18,
      })
    )
  );

  // all provider sublayers share one GeoJSON source and split by operator
  addGeoJSONSource(map, LAYER_IDS.digitizedCamerasSource);

  for (const operator of DIGITIZED_CAMERA_OPERATORS) {
    map.addLayer({
      id: operator.layerId,
      type: 'symbol',
      source: LAYER_IDS.digitizedCamerasSource,
      filter: ['==', ['get', 'operator'], operator.operator],
      layout: {
        ...markerLayout([
          'match',
          ['get', 'status'],
          // only the exact planned status uses the planned marker
          'Planned',
          operator.plannedIconId,
          operator.operationalIconId,
        ]),
        visibility: 'none',
      },
    });

    // same marker the site is drawn with
    const symbol = (feature) => ({
      iconUrl: feature?.properties?.status === 'Planned'
        ? operator.plannedIconUrl
        : operator.operationalIconUrl,
    });
    bindLayerInteractions(map, operator.layerId, {
      hover: { kind: 'digitizedCamera', symbol },
      click: (clickedMap, event) =>
        showFeaturePopup(clickedMap, event, 'digitizedCamera', symbol(event.features?.[0])),
    });
  }
}

function addViewshedLayers(map) {
  // providers without a published tileset keep their legend row as an error
  const providers = CAMERA_PROVIDERS.filter(({ viewshedLabel, viewshedTileset }) => {
    if (!viewshedTileset) {
      legendControl.setError(viewshedLabel, 'Viewshed tileset has not been published yet');
    }
    return Boolean(viewshedTileset);
  });

  // one dissolved fill avoids stacked opacity where shared-color providers overlap
  if (DATA_URLS.combinedCameraViewsheds) {
    map.addSource(LAYER_IDS.combinedViewshedsSource, {
      type: 'vector',
      url: DATA_URLS.combinedCameraViewsheds,
      minzoom: 5,
      maxzoom: 12,
    });
    map.addLayer({
      id: LAYER_IDS.combinedViewshedsFill,
      type: 'fill',
      source: LAYER_IDS.combinedViewshedsSource,
      'source-layer': DATA_URLS.cameraViewshedsCoverageSourceLayer,
      // syncViewshedFills decides when this replaces the provider fills
      layout: { visibility: 'none' },
      paint: {
        'fill-color': VIEWSHED_FILL_COLOR.outdoors,
        'fill-opacity': VIEWSHED_FILL_OPACITY,
      },
    });
  }

  for (const provider of providers) {
    map.addSource(provider.viewshedSourceId, {
      type: 'vector',
      url: provider.viewshedTileset,
      minzoom: 5,
      maxzoom: 12,
    });

    // dissolved coverage avoids stacked opacity; individual features keep selection ids
    map.addLayer({
      id: provider.viewshedFillLayerId,
      type: 'fill',
      source: provider.viewshedSourceId,
      'source-layer': DATA_URLS.cameraViewshedsCoverageSourceLayer,
      paint: {
        // the basemap and settings hooks below set the real color
        'fill-color': VIEWSHED_FILL_COLOR.outdoors,
        'fill-opacity': VIEWSHED_FILL_OPACITY,
      },
    });
  }

  // highlights draw above every provider fill so a selection is never covered
  for (const provider of providers) {
    map.addLayer({
      id: provider.viewshedHighlightLayerId,
      type: 'fill',
      source: provider.viewshedSourceId,
      'source-layer': DATA_URLS.cameraViewshedsSourceLayer,
      filter: viewshedFilter(NO_VIEWSHED_SELECTED),
      paint: {
        'fill-color': VIEWSHED_HIGHLIGHT_COLOR,
        'fill-opacity': VIEWSHED_HIGHLIGHT_OPACITY,
      },
    });
  }

  // both hooks call back immediately, so the first pass may precede the other's value
  let basemap = 'outdoors';

  onBasemapChange((selected) => {
    basemap = selected;
    applyViewshedSymbology(map, basemap);
  });
  onSettingChange(SEPARATE_VIEWSHED_COLORS_SETTING, () => {
    applyViewshedSymbology(map, basemap);
    syncViewshedFills(map);
  });
  legendControl.onChange(() => syncViewshedFills(map));
}

// shared-color providers draw through the combined fill so overlaps do not darken
// the legend still owns each provider's highlight layer and its checkbox state
function syncViewshedFills(map) {
  const visibleProviders = CAMERA_PROVIDERS.filter(({ viewshedLabel, viewshedFillLayerId }) =>
    legendControl.isChecked(viewshedLabel) && map.getLayer(viewshedFillLayerId));
  const useCombined = Boolean(map.getLayer(LAYER_IDS.combinedViewshedsFill)) &&
    !getSetting(SEPARATE_VIEWSHED_COLORS_SETTING) &&
    visibleProviders.length > 1;

  setLayerVisible(map, LAYER_IDS.combinedViewshedsFill, useCombined);
  for (const provider of visibleProviders) {
    setLayerVisible(map, provider.viewshedFillLayerId, !useCombined);
  }
}

function applyViewshedSymbology(map, basemap) {
  const shared = viewshedSymbol(null, basemap);
  legendControl.updateSwatchColor(LEGEND_LAYERS.viewsheds, shared.swatchColor, { image: shared.swatchImage });
  if (map.getLayer(LAYER_IDS.combinedViewshedsFill)) {
    map.setPaintProperty(LAYER_IDS.combinedViewshedsFill, 'fill-color', shared.swatchColor);
  }

  for (const provider of CAMERA_PROVIDERS) {
    const { swatchColor, swatchImage } = viewshedSymbol(provider, basemap);
    if (map.getLayer(provider.viewshedFillLayerId)) {
      map.setPaintProperty(provider.viewshedFillLayerId, 'fill-color', swatchColor);
    }
    legendControl.updateSwatchColor(provider.viewshedLabel, swatchColor, { image: swatchImage });
  }
}

// a provider, or null for the shared color, as the layer list and hover info draw it
function viewshedSymbol(provider, basemap) {
  const colors = provider ? viewshedColors(provider) : VIEWSHED_FILL_COLOR;
  return {
    swatchColor: basemapColor(colors, basemap),
    // providers in their own color show a sample viewshed in that color
    swatchImage: colors === VIEWSHED_FILL_COLOR
      ? basemapColor(VIEWSHED_LEGEND_IMAGES, basemap)
      : provider.viewshedLegendImage,
  };
}

function viewshedColors({ viewshedFillColor }) {
  return getSetting(SEPARATE_VIEWSHED_COLORS_SETTING) ? viewshedFillColor : VIEWSHED_FILL_COLOR;
}

function basemapColor(colors, basemap) {
  return colors[basemap] ?? colors.outdoors;
}

function selectCameraViewshed(map, viewshedId, cameraName = '') {
  highlightedCameraName = viewshedId ? cameraName || 'Camera' : '';

  // provider viewshed ids are unique, so each highlight layer can share one filter
  // the sentinel produces an empty match while no camera is selected
  const filter = viewshedFilter(viewshedId || NO_VIEWSHED_SELECTED);
  for (const { viewshedHighlightLayerId } of CAMERA_PROVIDERS) {
    if (map.getLayer(viewshedHighlightLayerId)) {
      map.setFilter(viewshedHighlightLayerId, filter);
    }
  }
}

function viewshedFilter(viewshedId) {
  return ['==', ['get', 'viewshed_id'], viewshedId];
}

// export legend rows for selection symbols, which have no layer row of their own
function selectionLegendItems(selection) {
  const items = [];

  if (selection?.kind === 'polygon') {
    const name = selection.properties?.name || selection.properties?.label || 'Selected area';
    items.push({
      // utility outlines are approximate service areas, so the label says so
      label: selection.type === 'utility' ? `${name} approx. service boundary` : `${name} border`,
      visual: { type: 'swatch', style: 'border', color: SELECTED_BOUNDARY_COLOR },
    });
  }

  if (highlightedCameraName && highlightedViewshedIsRendered(activeMap)) {
    items.push({
      label: `${highlightedCameraName} viewshed`,
      // a sample viewshed in the highlight color reads better than a flat swatch
      visual: { type: 'icon', src: 'img/yellow_portland_tower_viewshed.png', outline: VIEWSHED_HIGHLIGHT_COLOR, size: 22 },
    });
  }

  return items;
}

function highlightedViewshedIsRendered(map) {
  // an unchecked viewshed row or an off-screen camera leaves nothing to label
  const layers = CAMERA_PROVIDERS
    .map(({ viewshedHighlightLayerId }) => viewshedHighlightLayerId)
    .filter((layerId) => map?.getLayer(layerId));
  return layers.length > 0 && map.queryRenderedFeatures({ layers }).length > 0;
}

async function addFireLayer(map) {
  // register the image before adding a symbol layer that references it
  await registerMarkerIconSizes(map, {
    id: FIRE_ICON_ID,
    url: MARKER_ICON_URLS.fire,
    sizes: FIRE_MARKER_SIZES.map(([, size]) => size),
  });

  addGeoJSONSource(map, LAYER_IDS.fires);
  map.addLayer({
    id: LAYER_IDS.fires,
    type: 'symbol',
    source: LAYER_IDS.fires,
    layout: markerLayout(fireIconExpression()),
  });

  bindLayerInteractions(map, LAYER_IDS.fires, featureInfo('fire', LAYER_SYMBOLS.fires));
}

/**
 * pick a prerendered fire image by acreage
 * swapping images keeps each size pixel aligned
 */
function fireIconExpression() {
  const [[, smallestSize], ...largerSizes] = FIRE_MARKER_SIZES;

  return [
    'step',
    // missing or nonpositive acreage uses the smallest marker
    ['max', ['coalesce', ['to-number', ['get', 'acres']], 0], 0],
    sizedIconId(FIRE_ICON_ID, smallestSize),
    ...largerSizes.flatMap(([acres, size]) => [
      acres,
      sizedIconId(FIRE_ICON_ID, size),
    ]),
  ];
}

function addPerimeterLayers(map) {
  addGeoJSONSource(map, LAYER_IDS.perimetersSource);

  // draw the fill first so the sharper outline stays on top
  map.addLayer({
    id: LAYER_IDS.perimetersFill,
    type: 'fill',
    source: LAYER_IDS.perimetersSource,
    paint: {
      'fill-color': '#d64545',
      'fill-opacity': 0.28,
    },
  });

  map.addLayer({
    id: LAYER_IDS.perimetersLine,
    type: 'line',
    source: LAYER_IDS.perimetersSource,
    paint: {
      'line-color': '#b42318',
      'line-width': 2,
    },
  });

  bindLayerInteractions(map, LAYER_IDS.perimetersFill, featureInfo('fire', LAYER_SYMBOLS.fires));
}

// each fire history type draws earlier years, the year being left, and the timeline's year
// in their own layers, so one year can fade out as the next fades in over the earlier ones
function addFireHistoryLayers(map) {
  const year = fireHistoryTimeline.current();
  const hidden = { visibility: 'none' };

  addGeoJSONSource(map, LAYER_IDS.fireHistoryPerimetersSource);
  map.addLayer({
    id: LAYER_IDS.fireHistoryPerimetersEarlierFill,
    type: 'fill',
    source: LAYER_IDS.fireHistoryPerimetersSource,
    layout: hidden,
    filter: NO_FIRE_YEAR,
    paint: {
      'fill-color': FIRE_HISTORY_EARLIER_COLOR,
      'fill-opacity': FIRE_HISTORY_EARLIER_FILL_OPACITY,
      'fill-outline-color': FIRE_HISTORY_EARLIER_COLOR,
    },
  });
  for (const [fillId, lineId] of [
    [LAYER_IDS.fireHistoryPerimetersOutgoingFill, LAYER_IDS.fireHistoryPerimetersOutgoingLine],
    [LAYER_IDS.fireHistoryPerimetersFill, LAYER_IDS.fireHistoryPerimetersLine],
  ]) {
    map.addLayer({
      id: fillId,
      type: 'fill',
      source: LAYER_IDS.fireHistoryPerimetersSource,
      layout: hidden,
      filter: NO_FIRE_YEAR,
      paint: {
        'fill-color': FIRE_HISTORY_COLOR,
        'fill-opacity': FIRE_HISTORY_FILL_OPACITY,
      },
    });
    map.addLayer({
      id: lineId,
      type: 'line',
      source: LAYER_IDS.fireHistoryPerimetersSource,
      layout: hidden,
      filter: NO_FIRE_YEAR,
      paint: {
        'line-color': FIRE_HISTORY_COLOR,
        'line-width': 1.25,
      },
    });
  }

  addGeoJSONSource(map, LAYER_IDS.fireHistoryIgnitionsSource);
  map.addLayer({
    id: LAYER_IDS.fireHistoryIgnitionsEarlier,
    type: 'circle',
    source: LAYER_IDS.fireHistoryIgnitionsSource,
    layout: hidden,
    filter: NO_FIRE_YEAR,
    paint: {
      'circle-color': FIRE_HISTORY_EARLIER_COLOR,
      'circle-opacity': FIRE_HISTORY_EARLIER_IGNITION_OPACITY,
      'circle-radius': FIRE_HISTORY_IGNITION_RADIUS,
    },
  });
  for (const layerId of [LAYER_IDS.fireHistoryIgnitionsOutgoing, LAYER_IDS.fireHistoryIgnitions]) {
    map.addLayer({
      id: layerId,
      type: 'circle',
      source: LAYER_IDS.fireHistoryIgnitionsSource,
      layout: hidden,
      filter: NO_FIRE_YEAR,
      paint: {
        'circle-color': FIRE_HISTORY_COLOR,
        'circle-radius': FIRE_HISTORY_IGNITION_RADIUS,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 0.75,
      },
    });
  }

  if (year !== null) applyFireHistoryYear(map, year);

  for (const layerId of [LAYER_IDS.fireHistoryIgnitions, LAYER_IDS.fireHistoryIgnitionsEarlier]) {
    bindLayerInteractions(map, layerId, featureInfo('fireHistory', LAYER_SYMBOLS.fireHistoryIgnitions));
  }
  for (const layerId of [LAYER_IDS.fireHistoryPerimetersFill, LAYER_IDS.fireHistoryPerimetersEarlierFill]) {
    bindLayerInteractions(map, layerId, {
      ...featureInfo('fireHistory', LAYER_SYMBOLS.fireHistoryPerimeters),
      click: (clickedMap, event) => {
        // an ignition point sitting on its own burn scar keeps the tap
        const ignitionLayers = [LAYER_IDS.fireHistoryIgnitions, LAYER_IDS.fireHistoryIgnitionsEarlier];
        if (hasInteractiveFeatureAtPoint(clickedMap, event.point, ignitionLayers)) return;
        showFeaturePopup(clickedMap, event, 'fireHistory', LAYER_SYMBOLS.fireHistoryPerimeters);
      },
    });
  }
}

// shows the timeline's year, and every year before it in the earlier rows
function applyFireHistoryYear(map, year) {
  const previousYear = shownFireHistoryYear;
  shownFireHistoryYear = year;

  const yearFilter = ['==', ['get', 'year'], year];
  const earlierFilter = ['<', ['get', 'year'], year];
  for (const layerId of FIRE_HISTORY_YEAR_LAYER_IDS) map.setFilter(layerId, yearFilter);
  map.setFilter(LAYER_IDS.fireHistoryPerimetersEarlierFill, earlierFilter);
  map.setFilter(LAYER_IDS.fireHistoryIgnitionsEarlier, earlierFilter);

  if (previousYear === null || previousYear === year) return;

  // the year being left fades out on top; with the earlier rows on it settles
  // into their muted style underneath, otherwise it disappears
  const outgoingFilter = ['==', ['get', 'year'], previousYear];
  for (const layerId of FIRE_HISTORY_OUTGOING_LAYER_IDS) map.setFilter(layerId, outgoingFilter);
  crossfadeFireHistoryYears(map);
}

// paint transitions only run between constant values, so both years jump to their
// starting opacity for one frame and then ease past each other
function crossfadeFireHistoryYears(map) {
  const duration = motionDuration(FIRE_HISTORY_FADE_MS);
  const fades = [
    ['fill-opacity', FIRE_HISTORY_FILL_OPACITY, LAYER_IDS.fireHistoryPerimetersFill, LAYER_IDS.fireHistoryPerimetersOutgoingFill],
    ['line-opacity', 1, LAYER_IDS.fireHistoryPerimetersLine, LAYER_IDS.fireHistoryPerimetersOutgoingLine],
    ['circle-opacity', 1, LAYER_IDS.fireHistoryIgnitions, LAYER_IDS.fireHistoryIgnitionsOutgoing],
    ['circle-stroke-opacity', 1, LAYER_IDS.fireHistoryIgnitions, LAYER_IDS.fireHistoryIgnitionsOutgoing],
  ];
  const setOpacity = (layerId, property, opacity, transition) => {
    map.setPaintProperty(layerId, `${property}-transition`, { duration: transition, delay: 0 });
    map.setPaintProperty(layerId, property, opacity);
  };

  for (const [property, opacity, incomingId, outgoingId] of fades) {
    setOpacity(incomingId, property, duration ? 0 : opacity, 0);
    setOpacity(outgoingId, property, duration ? opacity : 0, 0);
  }
  if (!duration) return;

  map.once('render', () => {
    for (const [property, opacity, incomingId, outgoingId] of fades) {
      setOpacity(incomingId, property, opacity, duration);
      setOpacity(outgoingId, property, 0, duration);
    }
  });
}

// the timeline follows the fire history rows rather than having a switch of its own
function syncFireHistoryTimeline() {
  fireHistoryTimeline.setVisible(FIRE_HISTORY_LABELS.some((label) => legendControl.isChecked(label)));
}

// an exported map has no slider, so its legend names the years each row shows
function labelFireHistoryExport(year) {
  const firstYear = fireHistoryTimeline.firstYear();
  let earlierYears = `before ${year}`;
  if (year - 1 === firstYear) earlierYears = String(firstYear);
  else if (year - 1 > firstYear) earlierYears = `${firstYear}–${year - 1}`;

  for (const [label, years] of [
    [LEGEND_LAYERS.fireHistoryPerimeters, year],
    [LEGEND_LAYERS.fireHistoryIgnitions, year],
    [LEGEND_LAYERS.fireHistoryEarlierPerimeters, earlierYears],
    [LEGEND_LAYERS.fireHistoryEarlierIgnitions, earlierYears],
  ]) {
    legendControl.setExportLabel(label, `${label} (${years})`);
  }
}

function loadFireHistoryFile(url, label) {
  if (!fireHistoryFiles.has(url)) {
    const request = fetchJson(url, label).then((data) => {
      fireHistoryTimeline.includeYears(data.features.map(({ properties }) => properties?.year));
      return data;
    });
    // a failed request is dropped so the other row can try again
    request.catch(() => fireHistoryFiles.delete(url));
    fireHistoryFiles.set(url, request);
  }
  return fireHistoryFiles.get(url);
}

async function addPrescribedLayer(map) {
  // register the image before adding a symbol layer that references it
  await registerMarkerIcon(map, {
    id: PRESCRIBED_ICON_ID,
    url: MARKER_ICON_URLS.prescribed,
    size: PRESCRIBED_MARKER_SIZE,
  });

  addGeoJSONSource(map, LAYER_IDS.prescribedSource);
  map.addLayer({
    id: LAYER_IDS.prescribed,
    type: 'symbol',
    source: LAYER_IDS.prescribedSource,
    layout: markerLayout(PRESCRIBED_ICON_ID),
  });

  // the clicked box keeps its Watch Duty link reachable for mouse users too
  bindLayerInteractions(map, LAYER_IDS.prescribed, {
    ...featureInfo('prescribed', LAYER_SYMBOLS.prescribed),
    clickWithMouse: true,
  });
}

function addLookoutLayer(map) {
  addGeoJSONSource(map, LAYER_IDS.lookouts);
  map.addLayer({
    id: LAYER_IDS.lookouts,
    type: 'circle',
    source: LAYER_IDS.lookouts,
    paint: {
      'circle-radius': 5,
      'circle-color': LOOKOUT_COLOR,
      'circle-stroke-width': 1.25,
      'circle-stroke-color': '#fff',
    },
  });

  bindLayerInteractions(map, LAYER_IDS.lookouts, featureInfo('lookout', LAYER_SYMBOLS.lookouts));
}

function markerLayout(iconImage) {
  return {
    'icon-image': iconImage,
    // atlas images already use physical pixels, so keep Mapbox at scale 1
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

// create sources before requests finish so layers can register right away
function addGeoJSONSource(map, sourceId, options = {}) {
  // empty collections let style layers exist before their provider completes
  map.addSource(sourceId, {
    type: 'geojson',
    data: emptyFeatureCollection(),
    ...options,
  });
}

// ignore late data when its source was removed during loading
function setSourceData(map, sourceId, data) {
  const source = map.getSource(sourceId);
  if (!source) {
    console.warn(`Map source ${sourceId} is no longer available`);
    return;
  }

  source.setData(data);
}

// same details on hover with a mouse and in a box when tapped
function featureInfo(kind, symbol) {
  return {
    hover: { kind, symbol },
    click: (map, event) => showFeaturePopup(map, event, kind, symbol),
  };
}

/**
 * share hover info, pointer affordance, and click dispatch across interactive layers
 * clicks only act for touch unless `clickWithMouse`, since a mouse already sees the info on hover
 */
function bindLayerInteractions(map, layerId, { hover, click, clickWithMouse = false }) {
  if (hover) addHoverLayer(map, layerId, hover);

  const clickActs = () => clickWithMouse || !pointerCanHover();

  map.on('mouseenter', layerId, () => {
    if (clickActs()) map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', layerId, (event) => {
    if (clickActs()) click(map, event);
  });
}

// map each legend row to the Mapbox layers controlled by its checkbox
function legendItems() {
  // keep loading and hidden defaults aligned with startup source visibility
  return [
    {
      label: LEGEND_LAYERS.cameras,
      groupColors: CAMERA_PROVIDERS.map(({ color }) => color),
      layerIds: CAMERA_LAYER_IDS,
      children: CAMERA_PROVIDERS.map(({ cameraLabel, cameraLayerId, iconUrl }) => ({
        label: cameraLabel,
        iconUrl,
        loading: true,
        layerIds: [cameraLayerId],
      })),
    },
    {
      label: DIGITIZED_CAMERA_GROUP_LABEL,
      hidden: true,
      groupColors: Object.values(DIGITIZED_CAMERA_COLORS),
      visible: false,
      loading: true,
      keyItems: [
        { shape: 'triangle', label: 'Operational' },
        { shape: 'circle', label: 'Planned' },
      ],
      layerIds: DIGITIZED_CAMERA_LAYER_IDS,
      children: DIGITIZED_CAMERA_OPERATORS.map((operator) => ({
        label: operator.label,
        markerColor: operator.color,
        markerShapes: operator.markerShapes,
        visible: false,
        layerIds: [operator.layerId],
      })),
    },
    {
      label: LEGEND_LAYERS.viewsheds,
      swatchColor: VIEWSHED_FILL_COLOR.outdoors,
      swatchBorder: false,
      // the group row shows only its checkbox and label; the export still reads this swatch
      swatchClass: 'legend-swatch--hidden',
      layerIds: CAMERA_PROVIDERS.flatMap(viewshedLayerIds),
      children: CAMERA_PROVIDERS.map((provider) => ({
        label: provider.viewshedLabel,
        // the group row already says "camera", and the full label wraps in the sidebar
        displayLabel: `${provider.name} viewsheds`,
        swatchColor: viewshedColors(provider).outdoors,
        swatchBorder: false,
        infoText: 'Loading camera viewshed count…',
        loading: true,
        layerIds: viewshedLayerIds(provider),
      })),
    },
    {
      label: LEGEND_LAYERS.lookouts,
      ...LAYER_SYMBOLS.lookouts,
      visible: false,
      loading: true,
      infoText: 'Fire lookout tower locations from Firelookout.org',
      layerIds: [LAYER_IDS.lookouts],
    },
    {
      label: LEGEND_LAYERS.nationalForests,
      swatchColor: NATIONAL_FOREST_COLOR,
      visible: false,
      infoText: 'Surface ownership parcels from the U.S. Forest Service',
      layerIds: [
        LAYER_IDS.nationalForestsFill,
        LAYER_IDS.nationalForestsLine,
      ],
    },
    {
      label: LEGEND_LAYERS.blmLands,
      swatchColor: BLM_LAND_COLOR,
      swatchBorder: false,
      visible: false,
      layerIds: [LAYER_IDS.blmLands],
    },
    {
      label: LEGEND_LAYERS.burnProbability,
      swatchColor: BURN_PROBABILITY_COLOR,
      swatchBorder: false,
      swatchClass: 'legend-swatch--burn-probability',
      visible: false,
      infoText: `Annual burn probability from the 2023 Pacific Northwest QWRA. Values below ${BURN_PROBABILITY_MIN} are hidden.`,
      layerIds: [LAYER_IDS.burnProbability],
    },
    {
      label: LEGEND_LAYERS.transmissionLines,
      ...LAYER_SYMBOLS.transmissionLines,
      visible: false,
      infoText: 'Electric power transmission lines from a 2024 archive of the U.S. Electric Power Transmission Lines dataset. Thicker lines carry higher voltage. Hover over or tap a line for its owner, voltage, and substations.',
      layerIds: [LAYER_IDS.transmissionLines, LAYER_IDS.transmissionLinesHit],
    },
    {
      label: LEGEND_LAYERS.fires,
      ...LAYER_SYMBOLS.fires,
      visible: false,
      loading: true,
      layerIds: [
        LAYER_IDS.fires,
        LAYER_IDS.perimetersFill,
        LAYER_IDS.perimetersLine,
      ],
    },
    {
      label: LEGEND_LAYERS.fireHistory,
      swatchClass: 'legend-swatch--hidden',
      swatchColor: FIRE_HISTORY_COLOR,
      visible: false,
      infoText: `Wildfires of 100 acres or more in Oregon and Washington since 2016, from the NIFC Interagency Fire Perimeter History and WFIGS services. Turning a layer on opens a timeline over the map to step through the years.`,
      layerIds: [
        ...FIRE_HISTORY_PERIMETER_LAYER_IDS,
        ...FIRE_HISTORY_IGNITION_LAYER_IDS,
        LAYER_IDS.fireHistoryPerimetersEarlierFill,
        LAYER_IDS.fireHistoryIgnitionsEarlier,
      ],
      children: [
        {
          label: LEGEND_LAYERS.fireHistoryPerimeters,
          ...LAYER_SYMBOLS.fireHistoryPerimeters,
          visible: false,
          layerIds: FIRE_HISTORY_PERIMETER_LAYER_IDS,
        },
        {
          label: LEGEND_LAYERS.fireHistoryIgnitions,
          ...LAYER_SYMBOLS.fireHistoryIgnitions,
          visible: false,
          layerIds: FIRE_HISTORY_IGNITION_LAYER_IDS,
        },
        {
          label: LEGEND_LAYERS.fireHistoryEarlierPerimeters,
          ...LAYER_SYMBOLS.fireHistoryEarlierPerimeters,
          visible: false,
          infoText: 'Shows the perimeters before the current year in a faded brown',
          layerIds: [LAYER_IDS.fireHistoryPerimetersEarlierFill],
        },
        {
          label: LEGEND_LAYERS.fireHistoryEarlierIgnitions,
          ...LAYER_SYMBOLS.fireHistoryEarlierIgnitions,
          visible: false,
          infoText: 'Shows the ignitions before the current year in a faded brown',
          layerIds: [LAYER_IDS.fireHistoryIgnitionsEarlier],
        },
      ],
    },
    {
      label: LEGEND_LAYERS.prescribed,
      ...LAYER_SYMBOLS.prescribed,
      visible: false,
      loading: true,
      layerIds: [LAYER_IDS.prescribed],
    },
  ];
}

function viewshedLayerIds({ viewshedFillLayerId, viewshedHighlightLayerId }) {
  return [viewshedFillLayerId, viewshedHighlightLayerId];
}

function viewshedEntries(manifest) {
  // tolerate a missing or malformed manifest while the layer error is reported
  return Array.isArray(manifest?.viewsheds) ? manifest.viewsheds : [];
}
