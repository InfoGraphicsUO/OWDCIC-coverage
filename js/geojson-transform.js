const REGION_STATE_CODES = new Set(['OR', 'WA']);

// converts Oregon and Washington AlertWest camera records into GeoJSON points
export function camerasToGeoJSON(cameras) {
  if (!Array.isArray(cameras)) {
    throw new TypeError('Camera API returned an unexpected payload');
  }

  const features = [];

  for (const camera of cameras) {
    // source nests location under site and may vary state-code casing
    if (!REGION_STATE_CODES.has(String(camera.site?.state || '').toUpperCase())) {
      continue;
    }

    const latitude = toFiniteNumber(camera.site?.latitude);
    const longitude = toFiniteNumber(camera.site?.longitude);

    if (latitude == null || longitude == null) {
      continue;
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        // GeoJSON uses longitude first unlike the named source fields
        coordinates: [longitude, latitude],
      },
      properties: {
        id: camera.site?.id ?? null,
        name: camera.name || camera.source || 'Camera',
        pan: camera.position?.pan ?? null,
        image: camera.image?.url ?? null,
        state: camera.site?.state ?? null,
        county: camera.site?.county ?? null,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// links live camera points to viewshed ids from manifest
export function attachViewshedIds(cameras, manifest) {
  const cameraFeatures = getFeatures(cameras);
  const idLookup = new Map();
  const nameLookup = new Map();

  for (const entry of getManifestEntries(manifest)) {
    const viewshedId = stringValue(entry.viewshed_id);
    if (!viewshedId) continue;

    for (const cameraId of arrayValues(entry.alertwest_site_ids)) {
      idLookup.set(String(cameraId), viewshedId);
    }

    for (const name of [entry.site_name, ...arrayValues(entry.aliases)]) {
      const normalized = normalizeSiteName(name);
      if (normalized) nameLookup.set(normalized, viewshedId);
    }
  }

  return {
    type: 'FeatureCollection',
    features: cameraFeatures.map((feature) => {
      const properties = feature.properties || {};
      const cameraId = stringValue(properties.id);
      const cameraName = normalizeSiteName(properties.name);
      const viewshedId =
        (cameraId && idLookup.get(cameraId)) ||
        (cameraName && nameLookup.get(cameraName)) ||
        null;

      return {
        ...feature,
        properties: { ...properties, viewshed_id: viewshedId },
      };
    }),
  };
}

function getManifestEntries(manifest) {
  return Array.isArray(manifest?.viewsheds) ? manifest.viewsheds : [];
}

function arrayValues(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];

  // ArcGIS may serialize a list field as JSON or delimited text
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(/[;,|]/).map((item) => item.trim()).filter(Boolean);
    }
  }

  return [value];
}

function normalizeSiteName(value) {
  return stringValue(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^axis/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function stringValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * keeps finite point features inside an inclusive bounds box
 *
 * expects [[west, south], [east, north]] in longitude and latitude degrees
 * uses the first coordinate for MultiPoint features
 */
export function filterGeoJSONByBounds(geojson, bounds) {
  const [[west, south], [east, north]] = bounds;

  const features = getFeatures(geojson).filter((feature) => {
    const point = featurePoint(feature);
    if (!point) {
      return false;
    }

    // provider coordinates may be numeric strings
    const [longitude, latitude] = point.map(toFiniteNumber);

    return (
      longitude != null &&
      latitude != null &&
      longitude >= west &&
      longitude <= east &&
      latitude >= south &&
      latitude <= north
    );
  });

  return { type: 'FeatureCollection', features };
}

/**
 * returns Point coordinates or the first coordinate from a MultiPoint
 */
export function featurePoint(feature) {
  const geometry = feature?.geometry;

  if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }

  if (geometry?.type === 'MultiPoint' && Array.isArray(geometry.coordinates?.[0])) {
    return geometry.coordinates[0];
  }

  return null;
}

/**
 * copies features and normalizes provider-specific numeric fields
 *
 * `sourceNames` order sets priority and missing values become null
 */
export function addNumericProperty(geojson, targetName, sourceNames) {
  const features = getFeatures(geojson).map((feature) => {
    // first finite alias wins when providers expose overlapping field names
    const sourceValue = sourceNames
      .map((name) => toFiniteNumber(feature.properties?.[name]))
      .find((value) => value != null);

    return {
      ...feature,
      properties: {
        ...feature.properties,
        [targetName]: sourceValue ?? null,
      },
    };
  });

  return { type: 'FeatureCollection', features };
}

// treats missing or malformed feature arrays as empty provider data
function getFeatures(geojson) {
  return Array.isArray(geojson?.features) ? geojson.features : [];
}

// accepts numeric strings while rejecting empty and non-finite values
function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}
