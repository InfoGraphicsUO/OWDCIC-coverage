// records requested from each ArcGIS page
const DEFAULT_PAGE_SIZE = 2_000;

// extra attempts allowed after the first request
const DEFAULT_RETRIES = 3;

// base backoff in milliseconds before exponential growth
const DEFAULT_RETRY_DELAY_MS = 750;

/**
 * collects every ArcGIS page into one GeoJSON FeatureCollection
 *
 * `retries` counts additional attempts per page
 * `extraParams` overrides defaults for layer-specific filters and fields
 */
export async function fetchArcGISGeoJSON(
  featureLayerUrl,
  extraParams = {},
  { pageSize = DEFAULT_PAGE_SIZE, retries = DEFAULT_RETRIES } = {}
) {
  const features = [];
  let offset = 0;

  while (true) {
    // WGS84 keeps returned coordinates compatible with GeoJSON and Mapbox
    const params = {
      f: 'geojson',
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'OBJECTID', // stable object ID order keeps offset pages aligned
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      ...extraParams,
    };

    const geojson = await fetchArcGISPage(featureLayerUrl, params, { retries });
    const page = Array.isArray(geojson.features) ? geojson.features : [];

    features.push(...page);

    // response flag moves between root and GeoJSON properties across services
    const exceededTransferLimit =
      geojson.exceededTransferLimit ?? geojson.properties?.exceededTransferLimit;

    if (exceededTransferLimit !== true && page.length < pageSize) {
      break;
    }

    // empty flagged page cannot advance the offset and would loop forever
    if (page.length === 0) {
      throw new Error('ArcGIS pagination did not advance');
    }

    // actual page length handles services that cap below the requested size
    offset += page.length;
  }

  return { type: 'FeatureCollection', features };
}

// fetch one arc page with retry handling for any failure
async function fetchArcGISPage(featureLayerUrl, params, { retries }) {
  const queryUrl = `${featureLayerUrl.replace(/\/$/, '')}/query`; // remove trailing slash from url
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      const payload = await readJson(response);
      const serviceError = payload?.error;

      // ArcGIS sometimes returns error object with successful HTTP status
      if (response.ok && !serviceError) {
        return payload;
      }

      const status = serviceError?.code ?? response.status;
      const message = serviceError?.message || `ArcGIS query HTTP ${response.status}`;
      const error = new Error(message);

      // throttling and server failures are the retryable service responses
      error.retryable = status === 429 || status >= 500;
      error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

      throw error;
    } catch (error) {
      lastError = error;

      // network failures lack a marker so they retry by default
      // known client failures stop while throttling and server errors wait
      const canRetry = attempt < retries && error.retryable !== false;
      if (!canRetry) {
        break;
      }

      // Retry-After takes priority over local exponential backoff
      const delay = error.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
      await wait(delay);
    }
  }

  throw lastError;
}

// read json while preserving status context for retry decisions
async function readJson(response) {
  const body = await response.text();

  try {
    return JSON.parse(body);
  } catch (cause) {
    const preview = body.trim().replace(/\s+/g, ' ').slice(0, 160);
    const detail = preview ? `: ${preview}` : '';
    const error = new Error(
      `ArcGIS returned invalid JSON (HTTP ${response.status})${detail}`,
      { cause }
    );

    // ArcGIS edge nodes sometimes return an HTML/plain-text 400 for a
    // valid query; unlike structured ArcGIS JSON errors, that is not retryable
    error.retryable =
      response.status === 400 ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;

    throw error;
  }
}

// will convert Retry-After seconds or an HTTP date into milliseconds from now
function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
