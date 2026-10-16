import { DATA_URLS, LAYER_IDS, emptyFeatureCollection } from './config.js';

const OUTSIDE_HATCH_IMAGE_ID = 'outside-region-hatch';
const HATCH_SIZE = 32;
const HATCH_SPACING = 16;
const HATCH_LINE_WIDTH = 2;

// prebuilt by scripts/data-builders/build-service-area-focus.py from the OHAZ service area
export async function loadRegionFocusData() {
  const response = await fetch(DATA_URLS.serviceAreaFocus);
  if (!response.ok) throw new Error(`Service area HTTP ${response.status}`);
  return response.json();
}

// adds the outside-region hatch and combined outline above the basemap
export function addRegionFocusLayers(map) {
  registerOutsideHatch(map);

  map.addSource(LAYER_IDS.regionFocusSource, {
    type: 'geojson',
    data: emptyFeatureCollection(),
  });

  // basemap symbols and models below vanish outside the service area
  map.addLayer({
    id: LAYER_IDS.outsideRegionClip,
    type: 'clip',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    layout: {
      'clip-layer-types': ['symbol', 'model'],
    },
  });

  // no slot keeps the hatch above imported highway shields
  map.addLayer({
    id: LAYER_IDS.outsideRegionFill,
    type: 'fill',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outside'],
    paint: {
      'fill-pattern': OUTSIDE_HATCH_IMAGE_ID,
      'fill-opacity': 0.62,
      'fill-antialias': false,
    },
  });

  map.addLayer({
    id: LAYER_IDS.regionOutline,
    type: 'line',
    source: LAYER_IDS.regionFocusSource,
    filter: ['==', ['get', 'kind'], 'outline'],
    paint: {
      'line-color': '#2f2e2e',
      // screen-pixel width gets a modest boost while zooming
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5, 3,
        9, 5.5,
        13, 7,
      ],
      'line-opacity': 0.68,
      'line-emissive-strength': 0.65,
    },
  });
}

// creates a seamless bitmap pattern without muting the basemap between lines
export function registerOutsideHatch(map) {
  if (map.hasImage(OUTSIDE_HATCH_IMAGE_ID)) return;

  const data = new Uint8Array(HATCH_SIZE * HATCH_SIZE * 4);

  for (let y = 0; y < HATCH_SIZE; y += 1) {
    for (let x = 0; x < HATCH_SIZE; x += 1) {
      if ((x + y) % HATCH_SPACING >= HATCH_LINE_WIDTH) continue;

      const offset = (y * HATCH_SIZE + x) * 4;
      data[offset] = 95;
      data[offset + 1] = 98;
      data[offset + 2] = 102;
      data[offset + 3] = 255;
    }
  }

  map.addImage(
    OUTSIDE_HATCH_IMAGE_ID,
    { width: HATCH_SIZE, height: HATCH_SIZE, data },
    { pixelRatio: 2 }
  );
}
