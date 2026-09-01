import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  CAMERA_API,
  DATA_URLS,
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
import { initLegend } from './legend.js';
import { hideMapLoading } from './loading.js';
import { mapReady } from './map.js';
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
import {
  hideCameraPreview,
  showCameraPopup,
  showCameraPreview,
  showFirePopup,
  showLookoutPopup,
  showPrescribedPopup,
} from './popups.js';

const FIRE_ICON_ID = 'fire-marker';
const CAMERA_ICON_ID = 'camera-marker';
const PRESCRIBED_ICON_ID = 'prescribed-marker';
const BOUNDARY_COLOR = '#1769aa';
const VIEWSHED_COLOR = '#F28D05';
const VIEWSHED_HIGHLIGHT_COLOR = '#f8e109';
const LOOKOUT_COLOR = '#8154BD';
const NO_VIEWSHED_SELECTED = '__none__';
const VIEWSHED_SOURCE = Object.freeze({
  source: LAYER_IDS.viewshedsSource,
  'source-layer': DATA_URLS.cameraViewshedsSourceLayer,
});
const VIEWSHED_HIGHLIGHT_LAYER_IDS = Object.freeze([
  LAYER_IDS.viewshedsHighlightFill,
  LAYER_IDS.viewshedsHighlightLine,
]);
const VIEWSHED_LAYER_IDS = Object.freeze([
  LAYER_IDS.viewshedsFill,
  ...VIEWSHED_HIGHLIGHT_LAYER_IDS,
]);
const REGION_STATE_WHERE = "STATE IN ('41','53')";
const CENSUS_ATTRIBUTION =
  '<a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener noreferrer">U.S. Census Bureau TIGERweb</a>';
const BOUNDARY_TYPES = Object.freeze([
  Object.freeze({
    value: 'county',
    label: 'County',
    sourceId: LAYER_IDS.countyBoundariesSource,
    layerId: LAYER_IDS.countyBoundaries,
    url: DATA_URLS.censusCountyBoundaries,
  }),
  Object.freeze({
    value: 'senate',
    label: 'Senate',
    sourceId: LAYER_IDS.senateBoundariesSource,
    layerId: LAYER_IDS.senateBoundaries,
    url: DATA_URLS.censusStateSenateDistricts,
  }),
  Object.freeze({
    value: 'house',
    label: 'House',
    sourceId: LAYER_IDS.houseBoundariesSource,
    layerId: LAYER_IDS.houseBoundaries,
    url: DATA_URLS.censusStateHouseDistricts,
  }),
  Object.freeze({
    value: 'us-house',
    label: 'US House',
    sourceId: LAYER_IDS.congressionalBoundariesSource,
    layerId: LAYER_IDS.congressionalBoundaries,
    url: DATA_URLS.censusCongressionalDistricts,
  }),
]);
const boundaryLoads = new Map();

// marker sizes in CSS pixels
const CAMERA_MARKER_SIZE = 20;
const PRESCRIBED_MARKER_SIZE = 18;

// acreage drives which fire image is used; each entry is [minimum acres, size]
const FIRE_MARKER_SIZES = [
  [0, 14],
  [1, 16],
  [10, 18],
  [100, 20],
  [1_000, 24],
  [10_000, 28],
];

// render layer names and defaults without waiting for Mapbox or data providers
const legendControl = initLegend(legendItems(), [boundaryLayerSelect()]);

// startup waits for the base style before registering application layers
mapReady
  .then(waitForMapLoad)
  .then(loadMapLayers)
  .catch((error) => console.error('Failed to initialize map:', error))
  .finally(hideMapLoading);

// resolves immediately for cached styles or waits for the first full load
function waitForMapLoad(map) {
  if (map.loaded()) return map;

  return new Promise((resolve) => {
    map.once('load', () => resolve(map));
  });
}

// registers empty layers while providers run then hydrates all sources together
async function loadMapLayers(map) {
  // overlap network requests with source and marker setup
  const dataPromise = loadLayerData();

  addRegionFocusLayers(map);
  addBoundaryLayers(map);
  addViewshedLayers(map);
  addPerimeterLayers(map);
  addLookoutLayer(map);
  await Promise.all([addFireLayer(map), addCameraLayer(map)]);

  // added last so prescribed burns draw above the other markers
  await addPrescribedLayer(map);

  // rebuilds every registered marker image when display density changes
  watchMarkerIconDensity(map);

  // Mapbox visibility can now follow the legend that was rendered at startup
  legendControl.connect(map);

  const {
    cameras,
    fires,
    regionFocus,
    perimeters,
    prescribed,
    viewshedManifest,
    lookouts,
  } = await dataPromise;

  // matching source update for highlight switch above
  setSourceData(map, LAYER_IDS.regionFocusSource, regionFocus);

  setSourceData(
    map,
    LAYER_IDS.cameras,
    attachViewshedIds(cameras, viewshedManifest)
  );
  legendControl.updateInfo(
    'Camera viewsheds',
    `Contains ${viewshedEntries(viewshedManifest).length} camera viewsheds from ALERTWest`
  );

  // copy provider acreage into the local field used by marker sizing
  setSourceData(
    map,
    LAYER_IDS.fires,
    addNumericProperty(fires, 'acres', ['IncidentSize'])
  );

  setSourceData(map, LAYER_IDS.perimetersSource, perimeters);
  setSourceData(map, LAYER_IDS.prescribedSource, prescribed);
  setSourceData(map, LAYER_IDS.lookouts, lookouts);
}

function addBoundaryLayers(map) {
  for (const boundary of BOUNDARY_TYPES) {
    map.addSource(boundary.sourceId, {
      type: 'geojson',
      data: emptyFeatureCollection(),
      attribution: CENSUS_ATTRIBUTION,
    });

    map.addLayer({
      id: boundary.layerId,
      type: 'line',
      source: boundary.sourceId,
      layout: { visibility: 'none' },
      paint: {
        'line-color': BOUNDARY_COLOR,
        'line-opacity': 0.92,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 1.25,
          9, 2,
          13, 3,
        ],
        'line-emissive-strength': 1,
      },
    });
  }
}

function loadBoundary(map, boundary) {
  if (boundaryLoads.has(boundary.value)) {
    return boundaryLoads.get(boundary.value);
  }

  const load = safelyLoad(`${boundary.label} boundaries`, () =>
    fetchArcGISGeoJSON(boundary.url, {
      where: REGION_STATE_WHERE,
      outFields: 'STATE,GEOID,BASENAME',
      geometryPrecision: '5',
      maxAllowableOffset: '0.0005',
    })
  ).then((data) => setSourceData(map, boundary.sourceId, data));

  boundaryLoads.set(boundary.value, load);
  return load;
}

// starts every provider together and keeps results aligned by layer
async function loadLayerData() {
  const [
    cameras,
    fires,
    regionFocus,
    perimeters,
    prescribed,
    viewshedManifest,
    lookouts,
  ] = await Promise.all([
    safelyLoad('ALERTWest cameras', loadAlertWestCameras),

    safelyLoad('NIFC fires', () =>
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

    safelyLoad('Oregon and Washington boundary', loadRegionFocusData),

    safelyLoad('NIFC perimeters', () =>
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
          // WGS84 degree precision and simplification keep polygons compact
          geometryPrecision: '3',
          maxAllowableOffset: '0.01',
        },
        { pageSize: 25 }
      )
    ),

    safelyLoad('Watch Duty prescribed fires', async () => {
      const geojson = await fetchArcGISGeoJSON(DATA_URLS.prescribedFires, {
        outFields: 'name,prescribed_date_start,watchduty_url,acreage',
        // server-side envelope avoids downloading records outside the region
        geometry: REGION_DATA_BOUNDS.flat().join(','),
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
      });

      // enforce the same inclusive bounds on whatever the service returns
      return filterGeoJSONByBounds(geojson, REGION_DATA_BOUNDS);
    }),

    safelyLoad(
      'viewshed manifest',
      () => fetchJson(DATA_URLS.viewshedManifest, 'Viewshed manifest'),
      { viewsheds: [] }
    ),

    safelyLoad('standing lookouts', () =>
      fetchJson(DATA_URLS.standingLookouts, 'Standing lookouts')
    ),
  ]);

  return {
    cameras,
    fires,
    regionFocus,
    perimeters,
    prescribed,
    viewshedManifest,
    lookouts,
  };
}

// turns one provider failure into an empty layer without blocking the rest
async function safelyLoad(label, loader, fallback = emptyFeatureCollection()) {
  try {
    return await loader();
  } catch (error) {
    console.error(`Failed to load ${label}:`, error);
    return fallback;
  }
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

// adapts ALERTWest records to the GeoJSON contract used by map sources
async function loadAlertWestCameras() {
  return camerasToGeoJSON(await fetchJson(CAMERA_API, 'Camera API'));
}

async function addCameraLayer(map) {
  // symbol layers can only reference images already registered on the map
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

  map.on('click', LAYER_IDS.cameras, (event) => {
    selectCameraViewshed(map, event.features?.[0]?.properties?.viewshed_id);
  });

  bindLayerInteractions(map, LAYER_IDS.cameras, showCameraPopup, {
    show: showCameraPreview,
    hide: hideCameraPreview,
  });
}

function addViewshedLayers(map) {
  map.addSource(LAYER_IDS.viewshedsSource, {
    type: 'vector',
    url: DATA_URLS.cameraViewsheds,
  });

  map.addLayer({
    id: LAYER_IDS.viewshedsFill,
    type: 'fill',
    ...VIEWSHED_SOURCE,
    paint: {
      'fill-color': VIEWSHED_COLOR,
      'fill-opacity': 0.35,
    },
  });

  const selectedFilter = viewshedFilter(NO_VIEWSHED_SELECTED);

  map.addLayer({
    id: LAYER_IDS.viewshedsHighlightFill,
    type: 'fill',
    ...VIEWSHED_SOURCE,
    filter: selectedFilter,
    paint: {
      'fill-color': VIEWSHED_HIGHLIGHT_COLOR,
      'fill-opacity': 0.36,
    },
  });

  map.addLayer({
    id: LAYER_IDS.viewshedsHighlightLine,
    type: 'line',
    ...VIEWSHED_SOURCE,
    filter: selectedFilter,
    paint: {
      'line-color': VIEWSHED_HIGHLIGHT_COLOR,
      'line-width': 3,
    },
  });
}

function selectCameraViewshed(map, viewshedId) {
  const filter = viewshedFilter(viewshedId || NO_VIEWSHED_SELECTED);

  for (const layerId of VIEWSHED_HIGHLIGHT_LAYER_IDS) {
    if (map.getLayer(layerId)) map.setFilter(layerId, filter);
  }
}

function viewshedFilter(viewshedId) {
  return ['==', ['get', 'viewshed_id'], viewshedId];
}

async function addFireLayer(map) {
  // symbol layers can only reference images already registered on the map
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
 * picks a prerendered fire image by acreage
 * swapping images instead of scaling one keeps every size pixel aligned
 */
function fireIconExpression() {
  const [[, smallestSize], ...largerSizes] = FIRE_MARKER_SIZES;

  return [
    'step',
    // missing or nonpositive acreage falls back to the smallest marker
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

  // fill goes first so the sharper outline renders above it
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
  // symbol layers can only reference images already registered on the map
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
    // icon atlas already matches physical pixels so Mapbox must not rescale it
    'icon-size': 1,
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

// sources exist before requests finish so layer registration can proceed
function addGeoJSONSource(map, sourceId) {
  map.addSource(sourceId, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });
}

// ignores a late response when its source was removed during loading
function setSourceData(map, sourceId, data) {
  const source = map.getSource(sourceId);
  if (!source) {
    console.warn(`Map source ${sourceId} is no longer available`);
    return;
  }

  source.setData(data);
}

/**
 * shares pointer affordance and popup dispatch across interactive layers
 * a preview pair adds the hover popup that a click then expands
 */
function bindLayerInteractions(map, layerId, showPopup, preview) {
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    preview?.hide(map);
  });

  // mousemove also catches moving between two markers that sit side by side
  if (preview) {
    map.on('mousemove', layerId, (event) => preview.show(map, event));
  }

  map.on('click', layerId, (event) => showPopup(map, event));
}

// maps each legend row to every Mapbox layer controlled by its checkbox
function legendItems() {
  return [
    {
      label: 'Cameras (ALERTWest)',
      iconUrl: MARKER_ICON_URLS.camera,
      layerIds: [LAYER_IDS.cameras],
    },
    {
      label: 'Camera viewsheds',
      swatchColor: VIEWSHED_COLOR,
      swatchBorder: false,
      infoText: 'Loading camera viewshed count…',
      layerIds: VIEWSHED_LAYER_IDS,
    },
    {
      label: 'Standing lookouts',
      swatchColor: LOOKOUT_COLOR,
      swatchShape: 'circle',
      layerIds: [LAYER_IDS.lookouts],
    },
    {
      label: 'Fires (NIFC)',
      iconUrl: MARKER_ICON_URLS.fire,
      visible: false,
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
      layerIds: [LAYER_IDS.prescribed],
    },
  ];
}

function boundaryLayerSelect() {
  return {
    id: 'legend-boundary-select',
    label: 'Boundaries',
    defaultValue: '',
    options: [
      { value: '', label: 'None', layerIds: [] },
      ...BOUNDARY_TYPES.map((boundary) => ({
        value: boundary.value,
        label: boundary.label,
        layerIds: [boundary.layerId],
        activate: (map) => loadBoundary(map, boundary),
      })),
    ],
  };
}

function viewshedEntries(manifest) {
  return Array.isArray(manifest?.viewsheds) ? manifest.viewsheds : [];
}
