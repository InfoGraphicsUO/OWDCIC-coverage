//converts Oregon AlertWest camera records into GeoJSON points
export function camerasToGeoJSON(cameras) {
  if (!Array.isArray(cameras)) {
    throw new TypeError('Camera API returned an unexpected payload');
  }

  const features = [];

  for (const camera of cameras) {
    // source nests location under site and may vary state-code casing
    if (String(camera.site?.state || '').toUpperCase() !== 'OR') {
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

/**
 * treats missing or malformed feature arrays as empty provider data
 */
function getFeatures(geojson) {
  return Array.isArray(geojson?.features) ? geojson.features : [];
}

/**
 * accepts numeric strings while rejecting empty and non-finite values
 */
function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}
