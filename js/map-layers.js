import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  CAMERA_API,
  DATA_URLS,
  LAYER_IDS,
  MARKER_ICON_URLS,
  OREGON_DATA_BOUNDS,
  emptyFeatureCollection,
} from './config.js';
import {
  addNumericProperty,
  camerasToGeoJSON,
  filterGeoJSONByBounds,
} from './geojson-transform.js';
import { initLegend } from './legend.js';
import { mapReady } from './map.js';
import {
  registerMarkerIcon,
  registerMarkerIconSizes,
  sizedIconId,
  watchMarkerIconDensity,
} from './marker-icons.js';
import {
  addOregonFocusLayers,
  loadOregonFocusData,
} from './oregon-highlight.js';
import {
  hideCameraPreview,
  showCameraPopup,
  showCameraPreview,
  showFirePopup,
  showPrescribedPopup,
} from './popups.js';

const FIRE_ICON_ID = 'fire-marker';
const CAMERA_ICON_ID = 'camera-marker';
const PRESCRIBED_ICON_ID = 'prescribed-marker';

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

// startup waits for the base style before registering application layers
mapReady
  .then(waitForMapLoad)
  .then(loadMapLayers)
  .catch((error) => console.error('Failed to initialize map:', error));

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

  // temporary Oregon highlight off switch
  addOregonFocusLayers(map);
  addPerimeterLayers(map);
  await Promise.all([addFireLayer(map), addCameraLayer(map)]);

  // added last so prescribed burns draw above the other markers
  await addPrescribedLayer(map);

  // rebuilds every registered marker image when display density changes
  watchMarkerIconDensity(map);

  // legend defaults need every controlled layer to exist first
  initLegend(map, legendItems());

  const { cameras, fires, oregonFocus, perimeters, prescribed } = await dataPromise;

  // matching source update for highlight switch above
  setSourceData(map, LAYER_IDS.oregonFocusSource, oregonFocus);

  setSourceData(map, LAYER_IDS.cameras, cameras);

  // copy provider acreage into the local field used by marker sizing
  setSourceData(
    map,
    LAYER_IDS.fires,
    addNumericProperty(fires, 'acres', ['IncidentSize'])
  );

  setSourceData(map, LAYER_IDS.perimetersSource, perimeters);
  setSourceData(map, LAYER_IDS.prescribedSource, prescribed);
}

// starts every provider together and keeps results aligned by layer
async function loadLayerData() {
  const [cameras, fires, oregonFocus, perimeters, prescribed] = await Promise.all([
    safelyLoad('ALERTWest cameras', loadAlertWestCameras),

    safelyLoad('NIFC fires', () =>
      fetchArcGISGeoJSON(DATA_URLS.nifcFires, {
        where: "POOState='US-OR'",
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

    safelyLoad('Oregon boundary', loadOregonFocusData),

    safelyLoad('NIFC perimeters', () =>
      fetchArcGISGeoJSON(
        DATA_URLS.nifcPerimeters,
        {
          where: "attr_POOState='US-OR'",
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
        // server-side envelope avoids downloading records far outside Oregon
        geometry: OREGON_DATA_BOUNDS.flat().join(','),
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
      });

      // enforce the same inclusive bounds on whatever the service returns
      return filterGeoJSONByBounds(geojson, OREGON_DATA_BOUNDS);
    }),
  ]);

  return { cameras, fires, oregonFocus, perimeters, prescribed };
}

// turns one provider failure into an empty layer without blocking the rest
async function safelyLoad(label, loader) {
  try {
    return await loader();
  } catch (error) {
    console.error(`Failed to load ${label}:`, error);
    return emptyFeatureCollection();
  }
}

// adapts ALERTWest records to the GeoJSON contract used by map sources
async function loadAlertWestCameras() {
  const response = await fetch(CAMERA_API);
  if (!response.ok) throw new Error(`Camera API HTTP ${response.status}`);

  return camerasToGeoJSON(await response.json());
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
    layout: {
      'icon-image': CAMERA_ICON_ID,
      // 1 draws the image at its authored size so Mapbox never rescales it
      'icon-size': 1,
      // keep every camera visible when Mapbox symbols overlap
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  bindLayerInteractions(map, LAYER_IDS.cameras, showCameraPopup, {
    show: showCameraPreview,
    hide: hideCameraPreview,
  });
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
    layout: {
      'icon-image': fireIconExpression(),
      // 1 draws each image at its authored size so Mapbox never rescales it
      'icon-size': 1,
      // keep every incident visible when Mapbox symbols overlap
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
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
    layout: {
      'icon-image': PRESCRIBED_ICON_ID,
      // 1 draws the image at its authored size so Mapbox never rescales it
      'icon-size': 1,
      // keep every burn visible when Mapbox symbols overlap
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  bindLayerInteractions(map, LAYER_IDS.prescribed, showPrescribedPopup);
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
      label: 'ALERTWest cameras',
      iconUrl: MARKER_ICON_URLS.camera,
      layerIds: [LAYER_IDS.cameras],
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
