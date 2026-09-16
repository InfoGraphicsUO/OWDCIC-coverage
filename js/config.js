// live AlertWest camera metadata and image URLs
export const CAMERA_API = 'https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras';

// hosted tilesets and provider endpoints used by the map layers
export const DATA_URLS = Object.freeze({
  cameraViewsheds: 'mapbox://infographics.s4u0rv', // latest camera viewshed tileset https://console.mapbox.com/studio/tilesets/infographics.s4u0rv/
  cameraViewshedsSourceLayer: 'camera_viewsheds',
  cameraViewshedsCoverageSourceLayer: 'camera_viewshed_coverage',
  viewshedManifest: 'data/viewshed-manifest.json',
  digitizedCameraSources: 'data/digitized-camera-sources.geojson',
  standingLookouts: 'data/standing-lookouts.geojson',
  countyDivisions: 'data/divisions/counties.geojson',
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
  odfProtectionDistricts:
    'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/District_Boundaries/FeatureServer/1',
  burnProbabilityTiles:
    'https://tiles.arcgis.com/tiles/CD5mKowwN6nIaqd8/arcgis/rest/services/project_wre_bp_tile_package/MapServer/tile/{z}/{y}/{x}',
});

// QWRA classified tiles hide pale yellow–orange classes at or below this break
export const BURN_PROBABILITY_MIN = 0.002154;

// marker artwork rasterized by js/marker-icons.js and shown in the legend
export const MARKER_ICON_URLS = Object.freeze({
  camera: 'img/camera-marker.svg',
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
  odfProtectionSource: 'odf-protection-source',
  odfProtectionFill: 'odf-protection-fill',
  odfProtectionLine: 'odf-protection-line',
  burnProbabilitySource: 'burn-probability-source',
  burnProbability: 'burn-probability',
  cameras: 'alertwest-cameras',
  digitizedCamerasSource: 'digitized-camera-sources',
  digitizedEnviroVision: 'digitized-cameras-envirovision',
  digitizedAlertWest: 'digitized-cameras-alertwest',
  digitizedPano: 'digitized-cameras-pano',
  digitizedJoint: 'digitized-cameras-joint',
  viewshedsSource: 'camera-viewsheds',
  viewshedsFill: 'camera-viewsheds-fill',
  viewshedsHighlightFill: 'camera-viewsheds-highlight-fill',
  fires: 'nifc-fires',
  perimetersSource: 'nifc-perimeters',
  perimetersFill: 'nifc-perimeters-fill',
  perimetersLine: 'nifc-perimeters-line',
  prescribedSource: 'watchduty-prescribed',
  prescribed: 'watchduty-prescribed',
  lookouts: 'standing-lookouts',
});

export const REGION_DATA_BOUNDS = Object.freeze([
  Object.freeze([-124.85, 41.99]),
  Object.freeze([-116.4, 49.01]),
]);

// returns new collection for empty map sources and provider fallbacks
export function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}
