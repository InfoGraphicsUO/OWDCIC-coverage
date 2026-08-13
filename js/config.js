// live AlertWest camera metadata and image URLs
export const CAMERA_API = 'https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras';

// ArcGIS FeatureServer layer roots 
export const DATA_URLS = Object.freeze({
  nifcFires:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0',
  nifcPerimeters:
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0',
  prescribedFires:
    'https://services5.arcgis.com/VNhSlpl1umSknM3q/arcgis/rest/services/Watch_Duty_Prescribed_Fires/FeatureServer/0',
});

export const LAYER_IDS = Object.freeze({
  cameras: 'alertwest-cameras',
  fires: 'nifc-fires',
  perimetersSource: 'nifc-perimeters',
  perimetersFill: 'nifc-perimeters-fill',
  perimetersLine: 'nifc-perimeters-line',
  prescribedSource: 'watchduty-prescribed',
  prescribed: 'watchduty-prescribed',
});

export const OREGON_DATA_BOUNDS = Object.freeze([
  Object.freeze([-124.7, 41.9]),
  Object.freeze([-116.4, 46.4]),
]);

/**
 * returns a fresh collection for empty map sources and provider fallbacks
 */
export function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}
