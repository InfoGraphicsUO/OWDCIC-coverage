const CAMERA_API = 'https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras';
const CAMERA_LAYER_ID = 'alertwest-cameras';

mapReady
  .then((map) => {
    if (map.loaded()) {
      loadAlertWestCameras(map);
    } else {
      map.once('load', () => loadAlertWestCameras(map));
    }
  })
  .catch((error) => console.error('Failed to initialize map:', error));

async function loadAlertWestCameras(map) {
  try {
    const response = await fetch(CAMERA_API);
    if (!response.ok) {
      throw new Error(`Camera API HTTP ${response.status}`);
    }

    const cameras = await response.json();
    const geojson = camerasToGeoJSON(cameras);

    map.addSource(CAMERA_LAYER_ID, {
      type: 'geojson',
      data: geojson,
    });

    map.addLayer({
      id: CAMERA_LAYER_ID,
      type: 'circle',
      source: CAMERA_LAYER_ID,
      paint: {
        'circle-radius': 
        ['interpolate', ['linear'], 
        ['zoom'], 
        5, 5, 
        10, 7, 
        14, 9
    ],
        'circle-color': '#7a7a7a',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });

    map.on('mouseenter', CAMERA_LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', CAMERA_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('click', CAMERA_LAYER_ID, (event) => showCameraPopup(map, event));
  } catch (error) {
    console.error('Failed to load ALERTWest cameras:', error);
  }
}

function showCameraPopup(map, event) {
  const feature = event.features?.[0];
  if (!feature) return;

  new mapboxgl.Popup({ maxWidth: '280px' })
    .setLngLat(feature.geometry.coordinates)
    .setDOMContent(createCameraPopup(feature.properties))
    .addTo(map);
}

function createCameraPopup({ name, id, pan, image, state, county }) {
  // dom nodes so api vals are treated as text
  const popup = document.createElement('div');
  popup.className = 'cam-popup';

  const title = document.createElement('strong');
  title.textContent = name || 'Camera';
  popup.append(title);

  const location = [county, state].filter(Boolean).join(', ');
  if (location) popup.append(createMetaLine(location));

  const numericPan = Number(pan);
  popup.append(createMetaLine(`Pan: ${Number.isFinite(numericPan) ? `${numericPan}\u00b0` : '\u2014'}`)); // degree symbol

  const imageUrl = getHttpsUrl(image);
  if (imageUrl) { // if img url exists add it to the popup
    const thumbnail = document.createElement('img');
    thumbnail.className = 'cam-thumb';
    thumbnail.src = imageUrl;
    thumbnail.alt = name || 'Camera';
    thumbnail.loading = 'lazy';
    popup.append(thumbnail);
  }

  if (id) { // if id exists add link to alertwest camera console
    const link = document.createElement('a');
    link.href = `https://alertwest.live/cam-console/${encodeURIComponent(id)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open camera feed';
    popup.append(link);
  }

  return popup;
}

function createMetaLine(text) {
  const line = document.createElement('div');
  line.className = 'cam-meta';
  line.textContent = text;
  return line;
}

function getHttpsUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function camerasToGeoJSON(cameras) {
  if (!Array.isArray(cameras)) {
    throw new TypeError('Camera API returned an unexpected payload');
  }

  const features = [];

    // filter out cameras not in oregon
  for (const camera of cameras) {
    if (String(camera.site?.state || '').toUpperCase() !== 'OR') continue;

    const latitude = Number(camera.site?.latitude);
    const longitude = Number(camera.site?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
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
