import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  BURN_PROBABILITY_MIN,
  CAMERA_API,
  DATA_URLS,
  DIGITIZED_CAMERA_ICON_URLS,
  LAYER_IDS,
  MARKER_ICON_URLS,
  REGION_DATA_BOUNDS,
  emptyFeatureCollection,
} from './config.js';
import {
  addNumericProperty,
  attachViewshedIds,
  camerasToGeoJSON,
  filterGeoJSONByBounds,
} from './geojson-transform.js';
import { initLegend } from './legend.js?v=20260922tooltip1';
import { initFilterPanel } from './filter-panel.js?v=20260922sort1';
import { initResultsPanel } from './results-panel.js?v=20260922camera-layout1';
import { hideMapLoading } from './loading.js';
import {
  MAP_HOME_EVENT,
  mapPanelPadding,
  mapReady,
  motionDuration,
  onBasemapChange,
} from './map.js?v=20260922basemap-current-preview1';
import {
  registerMarkerIcon,
  registerMarkerIconSizes,
  sizedIconId,
  watchMarkerIconDensity,
} from './marker-icons.js?v=20260922simple1';
import {
  addRegionFocusLayers,
  loadRegionFocusData,
} from './states-highlight.js?v=20260922simple1';
import {
  hideCameraPreview,
  showCameraPreview,
  showDigitizedCameraPopup,
  showFirePopup,
  showLookoutPopup,
  showPrescribedPopup,
} from './popups.js';

const LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// stable ids let UI controls refer to layers without inspecting the style
const FIRE_ICON_ID = 'fire-marker';
const CAMERA_ICON_ID = 'camera-marker';
const PRESCRIBED_ICON_ID = 'prescribed-marker';
const DIGITIZED_CAMERA_GROUP_LABEL = 'Digitized Camera Sources';
const DIGITIZED_CAMERA_UNLOCK_SEQUENCE = Object.freeze(['1', '2', '3', '4']); // key sequence reveals digitized camera layer
// all four keys must arrive within this many milliseconds
const DIGITIZED_CAMERA_UNLOCK_TIMEOUT_MS = 2_000;
const BOUNDARY_COLOR = '#494949';
const BOUNDARY_FILL_COLOR = '#929292';
const SELECTED_BOUNDARY_COLOR = '#f8e109';
const VIEWSHED_LEGEND_LABEL = 'Camera viewsheds';
const VIEWSHED_FILL_COLOR = Object.freeze({
  outdoors: '#F28D05',
  satellite: '#F4F1EA',
});
const VIEWSHED_HIGHLIGHT_COLOR = '#ffee00';
const VIEWSHED_FILL_OPACITY = 0.5;
const VIEWSHED_HIGHLIGHT_OPACITY = 0.55;
const LOOKOUT_COLOR = '#8154BD';
const NATIONAL_FOREST_COLOR = '#3b7d4f';
const BLM_LAND_COLOR = '#f6d94a';
const ODF_PROTECTION_COLOR = '#008fb3';
const BURN_PROBABILITY_COLOR = '#d7191c';
const DIGITIZED_CAMERA_COLORS = Object.freeze({
  enviroVision: '#6eaa00',
  alertWest: '#a80000',
  pano: '#004ca9',
  joint: '#f8e109',
});
const NO_VIEWSHED_SELECTED = '__none__';
// dissolved coverage avoids stacked opacity; individual features keep selection ids
const VIEWSHED_INDIVIDUAL_SOURCE = Object.freeze({
  source: LAYER_IDS.viewshedsSource,
  'source-layer': DATA_URLS.cameraViewshedsSourceLayer,
});
const VIEWSHED_COVERAGE_SOURCE = Object.freeze({
  source: LAYER_IDS.viewshedsSource,
  'source-layer': DATA_URLS.cameraViewshedsCoverageSourceLayer,
});
const VIEWSHED_LAYER_IDS = Object.freeze([
  LAYER_IDS.viewshedsFill,
  LAYER_IDS.viewshedsHighlightFill,
]);
const NO_DIVISION_SELECTED = '__none__';
const FILTER_TYPES = Object.freeze([
  ['state', 'State'],
  ['county', 'County'],
  ['house', 'State House'],
  ['us-house', 'US House'],
  ['senate', 'State Senate'],
  ['utility', 'Utility provider'],
  ['national-forest', 'National Forest'],
  ['national-park', 'National Park'],
  ['federal-land', 'Federal land'],
  ['tribal-land', 'Tribal land'],
  ['camera', 'Camera'],
]);
// keep this order aligned with the filter menu; camera is the only non-polygon type
// cameras use point selection; every other type builds polygon layers
const DIVISION_TYPES = Object.freeze(FILTER_TYPES
  .filter(([value]) => value !== 'camera')
  .map(([value, label]) => {
    const prefix = `filter-${value}`;
    return Object.freeze({
      value,
      label,
      sourceId: `${prefix}-source`,
      labelSourceId: `${prefix}-label-source`,
      fillLayerId: `${prefix}-fill`,
      hoverLayerId: `${prefix}-hover`,
      layerId: `${prefix}-line`,
      labelLayerId: `${prefix}-labels`,
      selectedLayerId: `${prefix}-selected`,
      dataUrl: `data/divisions/${value}.geojson`,
    });
  }));
// cache in-flight requests separately from parsed features used for selection
const divisionLoads = new Map();
const divisionFeatures = new Map();
let activeMap;
let activeFilterType = null;
let cameraFeatures = [];
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
// incremented whenever another selection or clear action takes ownership of results
let cameraResultRequest = 0;
let digitizedCameraLoad;
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

// marker sizes use CSS pixels
const CAMERA_MARKER_SIZE = 20;
const PRESCRIBED_MARKER_SIZE = 18;

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
const legendControl = initLegend(legendItems());
const resultsControl = initResultsPanel({
  getMap: () => activeMap,
  getMapCanvas: () => activeMap?.getCanvas(),
  getLegendItems: () => [...document.querySelectorAll('#legend .legend-row')]
    .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
    .filter((row) => !row.hidden && !row.closest('.legend-group[hidden]'))
    .map((row) => row.querySelector('.legend-label')?.textContent?.trim())
    .filter(Boolean),
});
const filterControl = initFilterPanel({
  types: FILTER_TYPES.map(([value, label]) => ({ value, label })),
  loadOptions: loadFilterOptions,
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
  if (map.loaded()) return map;

  return new Promise((resolve) => {
    map.once('load', () => resolve(map));
  });
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
  // home fires before its camera animation starts
  map.on(MAP_HOME_EVENT, home);
  bindApplicationSourceErrors(map);
  addViewshedLayers(map);
  addPerimeterLayers(map);
  addLookoutLayer(map);
  await Promise.all([
    addFireLayer(map),
    addCameraLayer(map),
  ]);

  // symbol ordering depends on marker images and layers already being installed
  // prescribed burns draw above the other markers
  await addPrescribedLayer(map);

  orderDivisionLayers(map);

  // rebuild marker images when display density changes
  watchMarkerIconDensity(map);

  // Mapbox visibility can now follow the startup legend
  legendControl.connect(map);
  bindDigitizedCameraUnlock(map);

  // slow providers hydrate in the background after the map becomes usable
  hideMapLoading();

  await Promise.all([
    data.regionFocus.then((regionFocus) => {
      setSourceData(map, LAYER_IDS.regionFocusSource, regionFocus);
    }),
    hydrateLegendLayer(
      'Cameras (ALERTWest)',
      Promise.all([data.cameras, data.viewshedManifest]),
      ([cameras, viewshedManifest]) => {
        // selection ids must be attached before features reach either UI
        cameraFeatures = attachViewshedIds(cameras, viewshedManifest).features;
        setSourceData(
          map,
          LAYER_IDS.cameras,
          { type: 'FeatureCollection', features: cameraFeatures }
        );
        resolveCameraFeatures(cameraFeatures);
      }
    ),
    hydrateLegendLayer(
      VIEWSHED_LEGEND_LABEL,
      data.viewshedManifest,
      (viewshedManifest) => {
        // describe the manifest count and provider radius cap beside its legend row
        legendControl.updateInfo(
          VIEWSHED_LEGEND_LABEL,
          `Contains ${viewshedEntries(viewshedManifest).length} camera viewsheds from ALERTWest, capped at a 12mi maximum radius`
        );
      }
    ),
    hydrateLegendLayer(
      'Fires (NIFC)',
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
    hydrateLegendLayer(
      'National forests',
      data.nationalForests,
      (nationalForests) => {
        setSourceData(map, LAYER_IDS.nationalForestsSource, nationalForests);
      }
    ),
    hydrateLegendLayer(
      'ODF protection districts',
      data.odfProtectionDistricts,
      (odfProtectionDistricts) => {
        setSourceData(map, LAYER_IDS.odfProtectionSource, odfProtectionDistricts);
      }
    ),
  ]);
}

async function hydrateLegendLayer(label, dataPromise, applyData) {
  try {
    // keep data failures visible to the caller while always ending the spinner
    applyData(await dataPromise);
  } finally {
    legendControl.setLoading(label, false);
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

  addGeoJSONSource(map, LAYER_IDS.odfProtectionSource);
  map.addLayer({
    id: LAYER_IDS.odfProtectionFill,
    type: 'fill',
    source: LAYER_IDS.odfProtectionSource,
    layout: { visibility: 'none' },
    paint: {
      'fill-color': ODF_PROTECTION_COLOR,
      'fill-opacity': 0.10,
    },
  }, beforeId);
  map.addLayer({
    id: LAYER_IDS.odfProtectionLine,
    type: 'line',
    source: LAYER_IDS.odfProtectionSource,
    layout: { visibility: 'none' },
    paint: {
      'line-color': ODF_PROTECTION_COLOR,
      'line-dasharray': [3, 2],
      'line-opacity': 0.95,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5, 1.25,
        10, 2.5,
      ],
    },
  }, beforeId);
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
    // numeric collation keeps labels like Camera 2 ahead of Camera 10
    return features.map((feature) => ({
      value: cameraOptionId(feature),
      label: feature.properties?.name || 'Camera',
    })).sort((a, b) => LABEL_COLLATOR.compare(a.label, b.label));
  }

  return loadDivisionOptions(activeMap, typeValue);
}

async function loadDivisionOptions(map, typeValue) {
  const division = divisionType(typeValue);
  if (!division) throw new Error(`Unknown division type: ${typeValue}`);

  const data = await loadDivisionData(division);
  // keep full geometry for hit testing and selection, labels use compact points
  setSourceData(map, division.sourceId, data);
  // precomputed label points keep text placement independent of polygon geometry
  setSourceData(map, division.labelSourceId, {
    type: 'FeatureCollection',
    features: data.features.flatMap((feature) => {
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

  return data.features.map((feature) => ({
    value: feature.properties.divisionId,
    label: typeValue === 'utility'
      ? `${feature.properties.label}`
      : feature.properties.label,
    state: feature.properties.state,
  })).sort((a, b) => LABEL_COLLATOR.compare(a.label, b.label));
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
  return Boolean(activeFilterType && activeFilterType !== 'camera');
}

// list category change resets map selection and stale camera requests
function typeSelected(type) {
  // invalidate pending camera metrics before the old result panel is cleared
  cameraResultRequest += 1;
  activeFilterType = type || null;
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
  selectCameraViewshed(activeMap, null);
  selectDivision(activeMap, type, id);
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

  hideCameraPreview(activeMap);
  selectCameraViewshed(activeMap, feature.properties?.viewshed_id);

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

function cameraHovered(cameraId, event) {
  if (!activeMap) return;
  if (!cameraId) {
    hideCameraPreview(activeMap);
    return;
  }
  if (event) showCameraPreview(activeMap, event);
}

function clearFilter() {
  // prevent a late metrics response from refilling the cleared panel
  cameraResultRequest += 1;
  activeFilterType = null;
  if (activeMap) {
    clearDivisionFilter(activeMap);
    selectCameraViewshed(activeMap, null);
    hideCameraPreview(activeMap);
  }
  filterControl.setClearEnabled?.(false);
  resultsControl.clear();
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
  selectCameraViewshed(map, properties.viewshed_id);
  enableClearForResult();
  resultsControl.showLoading(properties.name || 'Camera');

  // share one metrics request across camera picks
  cameraMetricsLoad ??= fetch('data/camera-coverage.json')
    .then((response) => {
      // reject HTTP errors before attempting JSON parsing
      if (!response.ok) throw new Error(`Camera coverage HTTP ${response.status}`);
      return response.json();
    })
    .catch((error) => {
      cameraMetricsLoad = null;
      console.error('Failed to load camera coverage:', error);
      return {};
    });
  const metricsById = await cameraMetricsLoad;
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
    const load = fetch(division.dataUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${division.label} data HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          throw new Error(`${division.label} data is not a FeatureCollection`);
        }

        // retain source features for result details and later bounds fitting
        const features = new Map(
          data.features.map((feature) => [feature.properties?.divisionId, feature])
        );
        divisionFeatures.set(division.value, features);
        return data;
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

  setDivisionLayerFilter(
    map,
    division,
    divisionId || NO_DIVISION_SELECTED
  );

  if (!divisionId) {
    resultsControl.clear();
    return;
  }

  const feature = divisionFeatures.get(typeValue)?.get(divisionId);
  if (!feature) {
    console.warn(`Division ${divisionId} is not available`);
    resultsControl.clear();
    return;
  }

  resultsControl.showPolygon(typeValue, feature);
  collapseControlsOnNarrowScreen();
  fitMapToBounds(map, featureBounds(feature), { maxZoom: 10, duration: 800 });
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

function hasInteractiveFeatureAtPoint(map, point) {
  // only query layers already installed during asynchronous setup
  const layerIds = [
    LAYER_IDS.cameras,
    ...DIGITIZED_CAMERA_LAYER_IDS,
    LAYER_IDS.fires,
    LAYER_IDS.perimetersFill,
    LAYER_IDS.prescribed,
    LAYER_IDS.lookouts,
  ].filter((layerId) => map.getLayer(layerId));

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
    LAYER_IDS.cameras,
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

function bindApplicationSourceErrors(map) {
  // vector tile failures arrive as map errors rather than fetch rejections
  map.on('error', (event) => {
    const sourceId = event.sourceId;
    // vector tiles fail asynchronously, so there is no fetch promise to catch
    if (sourceId === LAYER_IDS.viewshedsSource) {
      legendControl.setError(
        VIEWSHED_LEGEND_LABEL,
        'Camera viewshed tiles did not load'
      );
    }
  });
}

// group provider requests so every layer can hydrate from its own result
function loadLayerData() {
  // launch the requests now before returning the bundle to map setup
  return {
    cameras: safelyLoadLegend(
      'ALERTWest cameras',
      'Cameras (ALERTWest)',
      loadAlertWestCameras
    ),

    fires: safelyLoadLegend('NIFC fires', 'Fires (NIFC)', () =>
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

    perimeters: safelyLoadLegend('NIFC perimeters', 'Fires (NIFC)', () =>
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
        },
        { pageSize: 25 }
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
      VIEWSHED_LEGEND_LABEL,
      () => fetchJson(DATA_URLS.viewshedManifest, 'Viewshed manifest'),
      { viewsheds: [] }
    ),

    lookouts: safelyLoadLegend('standing lookouts', 'Standing lookouts', () =>
      fetchJson(DATA_URLS.standingLookouts, 'Standing lookouts')
    ),

    nationalForests: safelyLoadLegend(
      'national forests',
      'National forests',
      () =>
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
    ),

    odfProtectionDistricts: safelyLoadLegend(
      'ODF protection districts',
      'ODF protection districts',
      () =>
        fetchArcGISGeoJSON(DATA_URLS.odfProtectionDistricts, {
          outFields: 'ODF_FPD',
          geometryPrecision: '4',
          maxAllowableOffset: '0.001',
        })
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

async function addCameraLayer(map) {
  // register the image before adding a symbol layer that references it
  await registerMarkerIcon(map, {
    id: CAMERA_ICON_ID,
    url: MARKER_ICON_URLS.camera,
    size: CAMERA_MARKER_SIZE,
  });

  addGeoJSONSource(map, LAYER_IDS.cameras);
  map.addLayer({
    id: LAYER_IDS.cameras,
    type: 'symbol',
    source: LAYER_IDS.cameras,
    layout: markerLayout(CAMERA_ICON_ID),
  });

  // hover previews use the map event; clicks open details and select its viewshed
  bindLayerInteractions(map, LAYER_IDS.cameras, null, {
    show: (hoveredMap, event) => {
      const feature = event.features?.[0];
      cameraHovered(feature ? cameraOptionId(feature) : null, event);
    },
    hide: () => cameraHovered(null),
  });
  map.on('click', LAYER_IDS.cameras, (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    cameraClicked(cameraOptionId(feature), feature);
  });
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

    bindLayerInteractions(map, operator.layerId, showDigitizedCameraPopup);
  }
}

function addViewshedLayers(map) {
  map.addSource(LAYER_IDS.viewshedsSource, {
    type: 'vector',
    url: DATA_URLS.cameraViewsheds,
    minzoom: 5,
    maxzoom: 12,
  });

  // dissolved coverage avoids stacked opacity; individual source keeps camera ids
  map.addLayer({
    id: LAYER_IDS.viewshedsFill,
    type: 'fill',
    ...VIEWSHED_COVERAGE_SOURCE,
    paint: {
      'fill-color': VIEWSHED_FILL_COLOR.outdoors,
      'fill-opacity': VIEWSHED_FILL_OPACITY,
    },
  });

  map.addLayer({
    id: LAYER_IDS.viewshedsHighlightFill,
    type: 'fill',
    ...VIEWSHED_INDIVIDUAL_SOURCE,
    filter: viewshedFilter(NO_VIEWSHED_SELECTED),
    paint: {
      'fill-color': VIEWSHED_HIGHLIGHT_COLOR,
      'fill-opacity': VIEWSHED_HIGHLIGHT_OPACITY,
    },
  });

  onBasemapChange((basemap) => applyViewshedSymbology(map, basemap));
}

function applyViewshedSymbology(map, basemap) {
  const satellite = basemap === 'satellite';
  // satellite imagery needs a light viewshed fill for contrast
  const fillColor =
    VIEWSHED_FILL_COLOR[basemap] ?? VIEWSHED_FILL_COLOR.outdoors;

  map.setPaintProperty(LAYER_IDS.viewshedsFill, 'fill-color', fillColor);
  legendControl.updateSwatchColor(VIEWSHED_LEGEND_LABEL, fillColor, {
    darkOutline: satellite,
  });
}

function selectCameraViewshed(map, viewshedId) {
  // the sentinel produces an empty match while no camera is selected
  if (!map.getLayer(LAYER_IDS.viewshedsHighlightFill)) return;
  map.setFilter(
    LAYER_IDS.viewshedsHighlightFill,
    viewshedFilter(viewshedId || NO_VIEWSHED_SELECTED)
  );
}

function viewshedFilter(viewshedId) {
  return ['==', ['get', 'viewshed_id'], viewshedId];
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

  bindLayerInteractions(map, LAYER_IDS.fires, showFirePopup);
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

  bindLayerInteractions(map, LAYER_IDS.perimetersFill, showFirePopup);
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

  bindLayerInteractions(map, LAYER_IDS.prescribed, showPrescribedPopup);
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

  bindLayerInteractions(map, LAYER_IDS.lookouts, showLookoutPopup);
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

/**
 * share pointer affordance and popup dispatch across interactive layers
 * previews add a hover popup that clicks can expand
 */
function bindLayerInteractions(map, layerId, showPopup, preview) {
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    preview?.hide(map);
  });

  // mousemove catches transitions between markers placed side by side
  if (preview) {
    map.on('mousemove', layerId, (event) => preview.show(map, event));
  }

  // layers without a full popup still retain pointer feedback and previews
  if (showPopup) map.on('click', layerId, (event) => showPopup(map, event));
}

// map each legend row to the Mapbox layers controlled by its checkbox
function legendItems() {
  // keep loading and hidden defaults aligned with startup source visibility
  return [
    {
      label: 'Cameras (ALERTWest)',
      iconUrl: MARKER_ICON_URLS.camera,
      loading: true,
      layerIds: [LAYER_IDS.cameras],
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
      label: VIEWSHED_LEGEND_LABEL,
      swatchColor: VIEWSHED_FILL_COLOR.outdoors,
      swatchBorder: false,
      infoText: 'Loading camera viewshed count…',
      loading: true,
      layerIds: VIEWSHED_LAYER_IDS,
    },
    {
      label: 'Standing lookouts',
      swatchColor: LOOKOUT_COLOR,
      swatchShape: 'circle',
      visible: false,
      loading: true,
      infoText: 'Fire lookout tower locations from Firelookout.org',
      layerIds: [LAYER_IDS.lookouts],
    },
    {
      label: 'National forests',
      swatchColor: NATIONAL_FOREST_COLOR,
      visible: false,
      loading: true,
      infoText: 'Surface ownership parcels from the U.S. Forest Service',
      layerIds: [
        LAYER_IDS.nationalForestsFill,
        LAYER_IDS.nationalForestsLine,
      ],
    },
    {
      label: 'BLM lands',
      swatchColor: BLM_LAND_COLOR,
      swatchBorder: false,
      visible: false,
      layerIds: [LAYER_IDS.blmLands],
    },
    {
      label: 'ODF protection districts',
      swatchColor: ODF_PROTECTION_COLOR,
      visible: false,
      infoText: 'Forest protection districts from the Oregon Department of Forestry',
      loading: true,
      layerIds: [
        LAYER_IDS.odfProtectionFill,
        LAYER_IDS.odfProtectionLine,
      ],
    },
    {
      label: 'OR Burn probability (QWRA)',
      swatchColor: BURN_PROBABILITY_COLOR,
      swatchBorder: false,
      swatchClass: 'legend-swatch--burn-probability',
      visible: false,
      infoText: `Annual burn probability from the 2023 Pacific Northwest QWRA. Values below ${BURN_PROBABILITY_MIN} are hidden.`,
      layerIds: [LAYER_IDS.burnProbability],
    },
    {
      label: 'Fires (NIFC)',
      iconUrl: MARKER_ICON_URLS.fire,
      visible: false,
      loading: true,
      layerIds: [
        LAYER_IDS.fires,
        LAYER_IDS.perimetersFill,
        LAYER_IDS.perimetersLine,
      ],
    },
    {
      label: 'Prescribed fires (Watch Duty)',
      iconUrl: MARKER_ICON_URLS.prescribed,
      visible: false,
      loading: true,
      layerIds: [LAYER_IDS.prescribed],
    },
  ];
}

function viewshedEntries(manifest) {
  // tolerate a missing or malformed manifest while the layer error is reported
  return Array.isArray(manifest?.viewsheds) ? manifest.viewsheds : [];
}
