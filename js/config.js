// live AlertWest camera metadata and image URLs
export const CAMERA_API = 'https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras';
export const PGE_WILDFIREWATCH_URL = 'https://portlandgeneral.wildfirewatch.com/';

// hosted tilesets and provider endpoints used by the map layers
export const DATA_URLS = Object.freeze({
  cameraViewsheds: 'mapbox://infographics.qn8uiv', // latest ALERTWest camera viewshed tileset https://console.mapbox.com/studio/tilesets/infographics.qn8uiv/
  cameraViewshedsSourceLayer: 'camera_viewsheds',
  cameraViewshedsCoverageSourceLayer: 'camera_viewshed_coverage',
  viewshedManifest: 'data/alertwest-viewshed-manifest.json',
  // latest Pano AI camera viewshed tileset https://console.mapbox.com/studio/tilesets/infographics.3eiwtk/
  // an empty value shows the legend row as unpublished instead of requesting tiles
  panoCameraViewsheds: 'mapbox://infographics.3eiwtk',
  // every provider's coverage dissolved together, drawn when they share one fill color https://console.mapbox.com/studio/tilesets/infographics.4qzk4g/
  // built by scripts/build-combined-viewshed-coverage.py; empty falls back to stacked provider fills
  combinedCameraViewsheds: 'mapbox://infographics.4qzk4g',
  panoCameraSites: 'data/pano-sites.geojson',
  alertWestCameraSites: 'data/alertwest-sites.geojson',
  digitizedCameraSources: 'data/digitized-camera-sources.geojson',
  standingLookouts: 'data/standing-lookouts.geojson',
  countyDivisions: 'data/divisions/county.geojson',
  transmissionLines: 'data/transmission-lines.geojson',
  censusStateBoundaries:
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/10',
  worldCountries:
    'https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/World_Countries_(Generalized)/FeatureServer/0',
  nifcFires:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0',
  nifcPerimeters:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0',
  prescribedFires:
    'https://services5.arcgis.com/VNhSlpl1umSknM3q/arcgis/rest/services/Watch_Duty_Prescribed_Fires/FeatureServer/0',
  nationalForests:
    'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_BasicOwnership_02/MapServer/0',
  blmLandTiles:
    'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_BLM_Only/MapServer/tile/{z}/{y}/{x}',
  burnProbabilityTiles:
    'https://tiles.arcgis.com/tiles/CD5mKowwN6nIaqd8/arcgis/rest/services/project_wre_bp_tile_package/MapServer/tile/{z}/{y}/{x}',
});

// QWRA classified tiles hide pale yellow–orange classes at or below this break
export const BURN_PROBABILITY_MIN = 0.002154;

// official camera providers share these colors across markers, legend rows, and viewsheds
// the marker SVGs in img/ hardcode the same values, so update both together
export const CAMERA_PROVIDER_COLORS = Object.freeze({
  alertWest: '#f2b705',
  pano: '#3898ec',
});

// marker artwork rasterized by js/marker-icons.js and shown in the legend
export const MARKER_ICON_URLS = Object.freeze({
  camera: 'img/camera-marker.svg',
  panoCamera: 'img/pano-camera-marker.svg',
  fire: 'img/fire-marker.svg',
  prescribed: 'img/prescribed-marker.svg',
});

export const DIGITIZED_CAMERA_ICON_URLS = Object.freeze({
  enviroVisionOperational: 'img/envirovision-operational.svg',
  enviroVisionPlanned: 'img/envirovision-planned.svg',
  alertWestOperational: 'img/alertwest-operational.svg',
  alertWestPlanned: 'img/alertwest-planned.svg',
  panoOperational: 'img/pano-operational.svg',
  panoPlanned: 'img/pano-planned.svg',
  joint: 'img/joint.svg',
});

export const LAYER_IDS = Object.freeze({
  regionFocusSource: 'region-focus',
  outsideRegionClip: 'outside-region-clip',
  outsideRegionFill: 'outside-region-fill',
  regionOutline: 'region-outline',
  countyBoundariesSource: 'county-boundaries-source',
  countyBoundaryFill: 'county-boundary-fill',
  countyBoundaryHover: 'county-boundary-hover',
  countyBoundaries: 'county-boundaries',
  countyBoundaryLabels: 'county-boundary-labels',
  countyBoundarySelected: 'county-boundary-selected',
  nationalForestsSource: 'national-forests-source',
  nationalForestsFill: 'national-forests-fill',
  nationalForestsLine: 'national-forests-line',
  blmLandsSource: 'blm-lands-source',
  blmLands: 'blm-lands',
  burnProbabilitySource: 'burn-probability-source',
  burnProbability: 'burn-probability',
  transmissionLinesSource: 'transmission-lines-source',
  transmissionLines: 'transmission-lines',
  cameras: 'alertwest-cameras',
  panoCameras: 'pano-cameras',
  digitizedCamerasSource: 'digitized-camera-sources',
  digitizedEnviroVision: 'digitized-cameras-envirovision',
  digitizedAlertWest: 'digitized-cameras-alertwest',
  digitizedPano: 'digitized-cameras-pano',
  digitizedJoint: 'digitized-cameras-joint',
  viewshedsSource: 'camera-viewsheds',
  viewshedsFill: 'camera-viewsheds-fill',
  viewshedsHighlightFill: 'camera-viewsheds-highlight-fill',
  panoViewshedsSource: 'pano-camera-viewsheds',
  panoViewshedsFill: 'pano-camera-viewsheds-fill',
  panoViewshedsHighlightFill: 'pano-camera-viewsheds-highlight-fill',
  combinedViewshedsSource: 'combined-camera-viewsheds',
  combinedViewshedsFill: 'combined-camera-viewsheds-fill',
  fires: 'nifc-fires',
  perimetersSource: 'nifc-perimeters',
  perimetersFill: 'nifc-perimeters-fill',
  perimetersLine: 'nifc-perimeters-line',
  prescribedSource: 'watchduty-prescribed',
  prescribed: 'watchduty-prescribed',
  lookouts: 'standing-lookouts',
});

// legend row labels are the public ids for toggling layers from code
export const LEGEND_LAYERS = Object.freeze({
  cameras: 'Cameras',
  alertWestCameras: 'ALERTWest cameras',
  panoCameras: 'Pano AI cameras',
  viewsheds: 'Camera viewsheds',
  alertWestViewsheds: 'ALERTWest camera viewsheds',
  panoViewsheds: 'Pano AI camera viewsheds',
  lookouts: 'Standing lookouts',
  nationalForests: 'National forests',
  blmLands: 'BLM lands',
  burnProbability: 'OR Burn probability (QWRA)',
  transmissionLines: 'Transmission lines',
  fires: 'Fires (NIFC)',
  prescribed: 'Prescribed fires (Watch Duty)',
});

// every filter group the code can build, as [type id, label shown in the panel]
// js/visible-content.js picks which of these the site shows and in what order
// camera is the only non-polygon type; the others load data/divisions/<type id>.geojson
export const FILTER_TYPES = Object.freeze([
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
  ['odf-protection-district', 'ODF protection district'],
  ['camera', 'Camera'],
]);

// filter type -> context to show when that type is picked
// basemap: 'outdoors' | 'satellite' | 'simple', omit to keep the current basemap
// layersOn / layersOff: LEGEND_LAYERS values; omit or leave empty to leave layers alone
// filter types without an entry keep the current layers and basemap
export const FILTER_LAYER_PRESETS = Object.freeze({
  utility: Object.freeze({ layersOn: Object.freeze([LEGEND_LAYERS.transmissionLines]) }),
  'national-forest': Object.freeze({ layersOn: Object.freeze([LEGEND_LAYERS.nationalForests]) }),
  'federal-land': Object.freeze({ layersOn: Object.freeze([LEGEND_LAYERS.blmLands]) }),
});

// returns the preset for a filter type, or null when it has none
export function layerPresetForFilter(filterType, presets = FILTER_LAYER_PRESETS) {
  return Object.hasOwn(presets, filterType) ? presets[filterType] : null;
}

// names in the editable lists ignore case and stray spaces
function normalizeName(name) {
  return `${name}`.trim().toLowerCase();
}

// resolves the editable filter list against every type the code can build
// returns the listed types in list order as { value, label, options }
// options is null when every option shows, otherwise a Set of normalized names
export function visibleFilterTypes(visibleFilters, types = FILTER_TYPES, warn = console.warn) {
  const visible = [];
  for (const [name, options] of Object.entries(visibleFilters)) {
    const type = types.find(([value, label]) =>
      normalizeName(label) === normalizeName(name) || value === name);
    if (!type) {
      warn(`Unknown filter group in VISIBLE_FILTERS: ${name}`);
      continue;
    }
    if (options !== 'all' && !Array.isArray(options)) {
      warn(`VISIBLE_FILTERS['${name}'] must be 'all' or a list of options; showing all`);
    }
    visible.push({
      value: type[0],
      label: type[1],
      options: Array.isArray(options) ? new Set(options.map(normalizeName)) : null,
    });
  }
  return visible;
}

// an option can be listed by its panel label, its full name, or its divisionId
export function filterOptionIsVisible(type, properties) {
  if (!type.options) return true;
  return [properties?.label, properties?.name, properties?.divisionId]
    .some((name) => name != null && type.options.has(normalizeName(name)));
}

// listed option names that match no feature, so typos can be reported
export function unmatchedFilterOptions(type, features) {
  if (!type.options) return [];
  const known = new Set(features.flatMap(({ properties }) =>
    [properties?.label, properties?.name, properties?.divisionId]
      .filter((name) => name != null)
      .map(normalizeName)));
  return [...type.options].filter((name) => !known.has(name));
}

// splits legend rows into the listed ones, in list order, and the ones left out
// rows that start hidden are revealed by code rather than listed, so they always stay
export function visibleLegendItems(items, visibleLayers, warn = console.warn) {
  const listed = [];
  for (const name of visibleLayers) {
    const item = items.find(({ label, hidden }) =>
      !hidden && normalizeName(label) === normalizeName(name));
    if (!item) warn(`Unknown map layer in VISIBLE_LAYERS: ${name}`);
    else if (!listed.includes(item)) listed.push(item);
  }
  return {
    visible: [...listed, ...items.filter(({ hidden }) => hidden)],
    removed: items.filter((item) => !item.hidden && !listed.includes(item)),
  };
}

export const REGION_DATA_BOUNDS = Object.freeze([
  Object.freeze([-124.85, 41.99]),
  Object.freeze([-116.4, 49.01]),
]);

// returns new collection for empty map sources and provider fallbacks
export function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}
