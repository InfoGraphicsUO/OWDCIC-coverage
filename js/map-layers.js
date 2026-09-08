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
import { initDivisionFilter, initLegend } from './legend.js';
import { hideMapLoading } from './loading.js';
import { MAP_HOME_EVENT, mapReady, onBasemapChange } from './map.js';
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
  hideDivisionPopup,
  showCameraPopup,
  showCameraPreview,
  showDivisionPopup,
  showFirePopup,
  showLookoutPopup,
  showPrescribedPopup,
} from './popups.js';

const FIRE_ICON_ID = 'fire-marker';
const CAMERA_ICON_ID = 'camera-marker';
const PRESCRIBED_ICON_ID = 'prescribed-marker';
const BOUNDARY_COLOR = '#1769aa';
const BOUNDARY_FILL_COLOR = '#397b9d';
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
const NO_VIEWSHED_SELECTED = '__none__';
// dissolved base avoids stacked opacity while individual features keep selection ids
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
const DIVISION_TYPES = Object.freeze([
  Object.freeze({
    value: 'county',
    label: 'County',
    sourceId: LAYER_IDS.countyBoundariesSource,
    fillLayerId: LAYER_IDS.countyBoundaryFill,
    hoverLayerId: LAYER_IDS.countyBoundaryHover,
    layerId: LAYER_IDS.countyBoundaries,
    labelLayerId: LAYER_IDS.countyBoundaryLabels,
    selectedLayerId: LAYER_IDS.countyBoundarySelected,
    dataUrl: DATA_URLS.countyDivisions,
  }),
]);
const divisionLoads = new Map();
const divisionFeatures = new Map();

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
const legendControl = initLegend(legendItems());
const divisionFilterControl = initDivisionFilter({
  types: DIVISION_TYPES.map(({ value, label }) => ({ value, label })),
  loadOptions: loadDivisionOptions,
  onTypeSelected: showDivisionType,
  onDivisionSelected: selectDivision,
  onClear: clearDivisionFilter,
});

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
  divisionFilterControl.connect(map);
  map.on(MAP_HOME_EVENT, () => divisionFilterControl.reset());
  addViewshedLayers(map);
  addPerimeterLayers(map);
  addLookoutLayer(map);
  await Promise.all([addFireLayer(map), addCameraLayer(map)]);

  // added last so prescribed burns draw above the other markers
  await addPrescribedLayer(map);

  orderDivisionLayers(map);

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
  for (const division of DIVISION_TYPES) {
    map.addSource(division.sourceId, {
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

    map.addLayer({
      id: division.labelLayerId,
      type: 'symbol',
      source: division.sourceId,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'shortName'],
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

async function loadDivisionOptions(map, typeValue) {
  const division = divisionType(typeValue);
  if (!division) throw new Error(`Unknown division type: ${typeValue}`);

  const data = await loadDivisionData(division);
  setSourceData(map, division.sourceId, data);

  return data.features.map((feature) => ({
    value: feature.properties.divisionId,
    label: feature.properties.label,
  }));
}

function showDivisionType(map, typeValue) {
  const selected = divisionType(typeValue);

  for (const division of DIVISION_TYPES) {
    const visible = division === selected;
    for (const layerId of divisionLayerIds(division)) {
      setLayerVisible(map, layerId, visible);
    }
    setDivisionLayerFilter(map, division, NO_DIVISION_SELECTED);
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  }
  hideDivisionPopup(map);
}

function loadDivisionData(division) {
  if (!divisionLoads.has(division.value)) {
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

        const features = new Map(
          data.features.map((feature) => [feature.properties?.divisionId, feature])
        );
        divisionFeatures.set(division.value, features);
        return data;
      })
      .catch((error) => {
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
    hideDivisionPopup(map);
    return;
  }

  const feature = divisionFeatures.get(typeValue)?.get(divisionId);
  if (!feature) {
    console.warn(`Division ${divisionId} is not available`);
    hideDivisionPopup(map);
    return;
  }

  const [west, south, east, north] = feature.bbox;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      duration: reducedMotion ? 0 : 800,
      maxZoom: 10,
      padding: divisionFitPadding(map),
    }
  );

  showDivisionPopup(map, feature.properties);
}

function clearDivisionFilter(map) {
  for (const division of DIVISION_TYPES) {
    for (const layerId of divisionLayerIds(division)) {
      setLayerVisible(map, layerId, false);
    }
    setDivisionLayerFilter(map, division, NO_DIVISION_SELECTED);
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  }
  map.getCanvas().style.cursor = '';
  hideDivisionPopup(map);
}

function divisionType(value) {
  return DIVISION_TYPES.find((division) => division.value === value);
}

function setLayerVisible(map, layerId, visible) {
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
  return ['==', ['get', 'divisionId'], divisionId];
}

function divisionLayerIds(division) {
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
    if (!divisionId) return;

    map.getCanvas().style.cursor = 'pointer';
    setDivisionHoverFilter(map, division, divisionId);
  });

  map.on('mouseleave', division.fillLayerId, () => {
    map.getCanvas().style.cursor = '';
    setDivisionHoverFilter(map, division, NO_DIVISION_SELECTED);
  });

  map.on('click', division.fillLayerId, (event) => {
    if (hasInteractiveFeatureAtPoint(map, event.point)) return;

    const divisionId = event.features?.[0]?.properties?.divisionId;
    if (divisionId) divisionFilterControl.select(division.value, divisionId);
  });
}

function hasInteractiveFeatureAtPoint(map, point) {
  const layerIds = [
    LAYER_IDS.cameras,
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
    LAYER_IDS.cameras,
    LAYER_IDS.prescribed,
  ].find((layerId) => map.getLayer(layerId));

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

function divisionFitPadding(map) {
  const container = map.getContainer();
  if (container.clientWidth > 620) {
    return { top: 48, right: 48, bottom: 48, left: 320 };
  }

  const panel = document.querySelector('.map-panels');
  const panelBottom = panel
    ? panel.getBoundingClientRect().bottom - container.getBoundingClientRect().top
    : 0;

  // leave enough clear map below the stacked mobile panel for the label popup
  const top = Math.min(
    Math.max(36, panelBottom + 18),
    Math.max(36, container.clientHeight - 220)
  );
  return { top, right: 24, bottom: 36, left: 24 };
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
  return Array.isArray(manifest?.viewsheds) ? manifest.viewsheds : [];
}
