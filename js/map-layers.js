import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  BURN_PROBABILITY_MIN,
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
import { mapReady, onBasemapChange } from './map.js';
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
const NO_VIEWSHED_SELECTED = '__none__';
const VIEWSHED_SOURCE = Object.freeze({
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
const REGION_STATE_WHERE = "STATE IN ('41','53')";
const CENSUS_ATTRIBUTION =
  '<a href="https://tigerweb.geo.census.gov/" target="_blank" rel="noopener noreferrer">U.S. Census Bureau TIGERweb</a>';
const NATIONAL_FOREST_ATTRIBUTION =
  '<a href="https://www.arcgis.com/home/item.html?id=4710a9e7cac3445eacc8265f7f61b813" target="_blank" rel="noopener noreferrer">U.S. Forest Service</a>';
const BLM_ATTRIBUTION =
  '<a href="https://www.arcgis.com/home/item.html?id=f8b3161f734f48f2971f4222411f1304" target="_blank" rel="noopener noreferrer">Bureau of Land Management</a>';
const ODF_ATTRIBUTION =
  '<a href="https://oregon-department-of-forestry-geo.hub.arcgis.com/datasets/odf-forest-protection-districts" target="_blank" rel="noopener noreferrer">Oregon Department of Forestry</a>';
const BURN_PROBABILITY_ATTRIBUTION =
  '<a href="https://www.arcgis.com/home/item.html?id=55a7c77f09064571ae3d06dc76411cef" target="_blank" rel="noopener noreferrer">Oregon Explorer / 2023 PNW QWRA</a>';
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

// registers empty layers while providers run then hydrates each source as ready
async function loadMapLayers(map) {
  // overlap network requests with source and marker setup
  const data = loadLayerData();

  addRegionFocusLayers(map);
  addContextLayers(map);
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

  // The map is usable now; slow or unavailable data providers hydrate their
  // sources in the background and should not hold the full-screen overlay.
  hideMapLoading();

  await Promise.all([
    data.regionFocus.then((regionFocus) => {
      setSourceData(map, LAYER_IDS.regionFocusSource, regionFocus);
    }),
    hydrateLegendLayer(
      'Cameras (ALERTWest)',
      Promise.all([data.cameras, data.viewshedManifest]),
      ([cameras, viewshedManifest]) => {
        setSourceData(
          map,
          LAYER_IDS.cameras,
          attachViewshedIds(cameras, viewshedManifest)
        );
      }
    ),
    hydrateLegendLayer(
      VIEWSHED_LEGEND_LABEL,
      data.viewshedManifest,
      (viewshedManifest) => {
        legendControl.updateInfo(
          VIEWSHED_LEGEND_LABEL,
          `Contains ${viewshedEntries(viewshedManifest).length} camera viewsheds from ALERTWest`
        );
      }
    ),
    hydrateLegendLayer(
      'Fires (NIFC)',
      Promise.all([data.fires, data.perimeters]),
      ([fires, perimeters]) => {
        // copy provider acreage into the local field used by marker sizing
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
    applyData(await dataPromise);
  } finally {
    legendControl.setLoading(label, false);
  }
}

function addContextLayers(map) {
  const beforeId = LAYER_IDS.outsideRegionFill;

  map.addSource(LAYER_IDS.burnProbabilitySource, {
    type: 'raster',
    tiles: [DATA_URLS.burnProbabilityTiles],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 16,
    bounds: [-124.85, 41.9, -116.4, 46.35],
    attribution: BURN_PROBABILITY_ATTRIBUTION,
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
    attribution: BLM_ATTRIBUTION,
  });
  map.addLayer({
    id: LAYER_IDS.blmLands,
    type: 'raster',
    source: LAYER_IDS.blmLandsSource,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.68 },
  }, beforeId);

  addGeoJSONSource(map, LAYER_IDS.nationalForestsSource, {
    attribution: NATIONAL_FOREST_ATTRIBUTION,
  });
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

  addGeoJSONSource(map, LAYER_IDS.odfProtectionSource, {
    attribution: ODF_ATTRIBUTION,
  });
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

/**
 * QWRA tiles are pre-classed ColorBrewer YlOrRd, not raw probability values.
 * Blue channel below ~0.196 is red through dark brown (>= 0.002154); paler classes hide.
 */
function burnProbabilityPaint() {
  return {
    'raster-opacity': 0.72,
    'raster-resampling': 'nearest',
    'raster-color-mix': [0, 0, 1, 0],
    'raster-color-range': [0, 1],
    'raster-color': [
      'step',
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
function loadLayerData() {
  return {
    cameras: safelyLoadLegend(
      'ALERTWest cameras',
      'Cameras (ALERTWest)',
      loadAlertWestCameras
    ),

    fires: safelyLoadLegend('NIFC fires', 'Fires (NIFC)', () =>
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
          // WGS84 degree precision and simplification keep polygons compact
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
        const geojson = await fetchArcGISGeoJSON(DATA_URLS.prescribedFires, {
          outFields: 'name,prescribed_date_start,watchduty_url,acreage',
          // server-side envelope avoids downloading records outside the region
          geometry: REGION_DATA_BOUNDS.flat().join(','),
          geometryType: 'esriGeometryEnvelope',
          spatialRel: 'esriSpatialRelIntersects',
        });

        // enforce the same inclusive bounds on whatever the service returns
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

function safelyLoadLegend(label, legendLabel, loader, fallback) {
  return safelyLoad(label, loader, fallback, (error) => {
    legendControl.setError(
      legendLabel,
      `${label} did not load: ${shortErrorMessage(error)}`
    );
  });
}

// turns one provider failure into an empty layer without blocking the rest
async function safelyLoad(
  label,
  loader,
  fallback = emptyFeatureCollection(),
  onError
) {
  try {
    return await loader();
  } catch (error) {
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
    minzoom: 5,
    maxzoom: 12,
  });

  // dissolved coverage layer so overlapping cameras do not stack opacity
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
    ...VIEWSHED_SOURCE,
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
  const fillColor =
    VIEWSHED_FILL_COLOR[basemap] ?? VIEWSHED_FILL_COLOR.outdoors;

  map.setPaintProperty(LAYER_IDS.viewshedsFill, 'fill-color', fillColor);
  legendControl.updateSwatchColor(VIEWSHED_LEGEND_LABEL, fillColor, {
    darkOutline: satellite,
  });
}

function selectCameraViewshed(map, viewshedId) {
  map.setFilter(
    LAYER_IDS.viewshedsHighlightFill,
    viewshedFilter(viewshedId || NO_VIEWSHED_SELECTED)
  );
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
function addGeoJSONSource(map, sourceId, options = {}) {
  map.addSource(sourceId, {
    type: 'geojson',
    data: emptyFeatureCollection(),
    ...options,
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
      loading: true,
      layerIds: [LAYER_IDS.cameras],
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
      loading: true,
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
      infoText: 'Surface management areas from the Bureau of Land Management',
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
