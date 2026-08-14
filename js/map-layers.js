import { fetchArcGISGeoJSON } from './arcgis-requests.js';
import {
  CAMERA_API,
  DATA_URLS,
  LAYER_IDS,
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
  addOregonFocusLayers,
  loadOregonFocusData,
} from './oregon-highlight.js';
import {
  showCameraPopup,
  showFirePopup,
  showPrescribedPopup,
} from './popups.js';

const FIRE_ICON_ID = 'fa-fire-marker';
const CAMERA_ICON_ID = 'fa-camera-marker';

// Font Awesome private-use codepoints drawn into canvas marker images
const FA_FIRE_GLYPH = '\uf06d';
const FA_CAMERA_GLYPH = '\uf030';

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

  // focus first keeps base shields below gray and app markers above it
  addOregonFocusLayers(map);
  addPerimeterLayers(map);
  await Promise.all([addFireLayer(map), addCameraLayer(map)]);
  addPrescribedLayer(map);

  // legend defaults need every controlled layer to exist first
  initLegend(map, legendItems());

  const { cameras, fires, oregonFocus, perimeters, prescribed } = await dataPromise;

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
  await addFaMarkerIcon(map, {
    id: CAMERA_ICON_ID,
    glyph: FA_CAMERA_GLYPH,
    fill: '#7a7a7a',
    shape: 'square',
  });

  addGeoJSONSource(map, LAYER_IDS.cameras);
  map.addLayer({
    id: LAYER_IDS.cameras,
    type: 'symbol',
    source: LAYER_IDS.cameras,
    layout: {
      'icon-image': CAMERA_ICON_ID,
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],

        // each pair is zoom level then icon scale
        5, 0.28,
        10, 0.35,
        14, 0.42,
      ],
      // keep every camera visible when Mapbox symbols overlap
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  bindLayerInteractions(map, LAYER_IDS.cameras, showCameraPopup);
}

async function addFireLayer(map) {
  // symbol layers can only reference images already registered on the map
  await addFaMarkerIcon(map, {
    id: FIRE_ICON_ID,
    glyph: FA_FIRE_GLYPH,
    fill: '#d64545',
    shape: 'circle',
  });

  addGeoJSONSource(map, LAYER_IDS.fires);
  map.addLayer({
    id: LAYER_IDS.fires,
    type: 'symbol',
    source: LAYER_IDS.fires,
    layout: {
      'icon-image': FIRE_ICON_ID,
      'icon-size': [
        'interpolate',
        ['linear'],
        // missing and nonpositive acreage use the smallest marker stop
        ['max', ['coalesce', ['to-number', ['get', 'acres']], 0.1], 0.1],

        // each pair is acres then icon scale
        0.1, 0.25,
        1, 0.3,
        10, 0.35,
        100, 0.45,
        1_000, 0.55,
        10_000, 0.75,
      ],
      // keep every incident visible when Mapbox symbols overlap
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  bindLayerInteractions(map, LAYER_IDS.fires, showFirePopup);
}

// registers Font Awesome glyph as a Mapbox image
async function addFaMarkerIcon(map, { id, glyph, fill, shape }) {
  if (map.hasImage(id)) return;

  await document.fonts.ready;
  const fontFaces = await document.fonts.load(
    '900 64px "Font Awesome 6 Free"',
    glyph
  );

  // marker geometry uses backing pixels for clean edges
  const size = 128;
  const inset = 8;
  const box = size - inset * 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');

  // colored shape and border remain useful when the icon font is unavailable
  context.beginPath();
  if (shape === 'square') {
    context.roundRect(inset, inset, box, box, 16);
  } else {
    context.arc(size / 2, size / 2, box / 2, 0, Math.PI * 2);
  }

  context.fillStyle = fill;
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = '#ffffff';
  context.stroke();

  // glyph is optional so stylesheet or font failures dont hide the marker
  if (fontFaces.length > 0) {
    context.fillStyle = '#ffffff';
    context.font = '900 64px "Font Awesome 6 Free"';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // 2 backing pixels optically center the glyph in its background
    context.fillText(glyph, size / 2, size / 2 + 2);
  }

  // pixelRatio 2 presents 128 backing pixels as a 64px map image
  map.addImage(id, context.getImageData(0, 0, size, size), { pixelRatio: 2 });
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

function addPrescribedLayer(map) {
  addGeoJSONSource(map, LAYER_IDS.prescribedSource);
  map.addLayer({
    id: LAYER_IDS.prescribed,
    type: 'circle',
    source: LAYER_IDS.prescribedSource,
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],

        // each pair is zoom level then radius in screen pixels
        5, 5,
        10, 7,
        14, 9,
      ],
      'circle-color': '#e6a817',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
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

// shares pointer affordance and popup dispatch across interactive layers
function bindLayerInteractions(map, layerId, showPopup) {
  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', layerId, (event) => showPopup(map, event));
}

// maps each legend row to every Mapbox layer controlled by its checkbox
function legendItems() {
  return [
    {
      label: 'ALERTWest cameras',
      color: '#7a7a7a',
      shape: 'camera',
      icon: 'fa-solid fa-camera',
      layerIds: [LAYER_IDS.cameras],
    },
    {
      label: 'Fires (NIFC)',
      color: '#d64545',
      shape: 'fire',
      icon: 'fa-solid fa-fire',
      visible: false,
      layerIds: [
        LAYER_IDS.fires,
        LAYER_IDS.perimetersFill,
        LAYER_IDS.perimetersLine,
      ],
    },
    {
      label: 'Prescribed fires (Watch Duty)',
      color: '#e6a817',
      shape: 'circle',
      visible: false,
      layerIds: [LAYER_IDS.prescribed],
    },
  ];
}
