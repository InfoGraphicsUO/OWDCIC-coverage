// camera to viewshed join must key on id or location, not only display names
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { attachViewshedIds, providerSitesToCameras } from '../js/geojson-transform.js';

const manifest = JSON.parse(readFileSync(new URL('../data/alertwest-viewshed-manifest.json', import.meta.url), 'utf8'));
const entry = (id) => manifest.viewsheds.find((item) => item.viewshed_id === id);

const camera = (id, name, lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, name },
});
const join = (...features) => attachViewshedIds({ features }, manifest).features.map((f) => f.properties.viewshed_id);

// AlertWest names differ from the viewshed site names, so only location links these
const portland = entry('portland-tower');
const smith = entry('smith-ridge');
assert.deepEqual(
  join(
    camera('11134', 'Axis-PortlandWestHills1', portland.longitude + 0.00008, portland.latitude),
    camera('11135', 'Axis-PortlandWestHills2', portland.longitude, portland.latitude + 0.00005),
    camera('11140', 'Axis-SmithRidgeOR', smith.longitude, smith.latitude),
  ),
  ['portland-tower', 'portland-tower', 'smith-ridge'],
);

// every manifest site is reachable from a camera placed on it under an unrelated name
for (const site of manifest.viewsheds) {
  const [joined] = join(camera('x', 'Unrelated', site.longitude, site.latitude));
  const sharesSpot = manifest.viewsheds.some((other) => other !== site && other.longitude === site.longitude && other.latitude === site.latitude);
  if (!sharesSpot) assert.equal(joined, site.viewshed_id, site.site_name);
}

// a camera 1.1 km from the nearest viewshed (older, mismatched model) stays unmatched
const jackass = entry('jackass-mountain');
assert.deepEqual(join(camera('17952', 'Axis-JackassButte', jackass.longitude - 0.0135, jackass.latitude)), [null]);

// explicit AlertWest ids win, and name matching remains a fallback without coordinates
const withIds = { viewsheds: [{ viewshed_id: 'a', site_name: 'Alpha', alertwest_site_ids: [7], longitude: 0, latitude: 0 }] };
assert.equal(attachViewshedIds({ features: [camera('7', 'Whatever', 50, 50)] }, withIds).features[0].properties.viewshed_id, 'a');
assert.equal(attachViewshedIds({ features: [{ type: 'Feature', geometry: null, properties: { id: '8', name: 'Axis-Alpha' } }] }, withIds).features[0].properties.viewshed_id, 'a');

console.log('geojson transform tests passed');

// known site corrections must move both camera heads without inventing coverage
const newSites = JSON.parse(readFileSync(new URL('../data/alertwest-sites.geojson', import.meta.url), 'utf8'));
const halfway = newSites.features.find(f => f.properties.name === 'Halfway');
const halfwayHeads = { features: [camera(18030, 'Axis-Halfway1', -117.0316, 44.8814), camera(18031, 'Axis-Halfway2', -117.0316, 44.8814)] };
for (const f of attachViewshedIds(halfwayHeads, manifest, newSites).features) {
  assert.deepEqual(f.geometry, halfway.geometry);
  assert.equal(f.properties.viewshed_id, 'halfway');
}
const pendingHalfway = structuredClone(halfway);
pendingHalfway.properties.viewshedStatus = 'pending';
for (const f of attachViewshedIds(halfwayHeads, manifest, { features: [pendingHalfway] }).features) {
  assert.equal(f.properties.viewshed_id, null);
}
const panoSites = JSON.parse(readFileSync(new URL('../data/pano-sites.geojson', import.meta.url), 'utf8'));
const panoCameras = providerSitesToCameras(panoSites, 'Pano AI').features;
assert.equal(panoCameras.length, 34);
assert.equal(panoCameras.filter(f => f.properties.viewshed_id).length, 24);
const pendingWithHeight = structuredClone(panoSites.features.find(f => f.properties.name === 'Mullan Substation'));
pendingWithHeight.properties.cameraHeightFt = 173.9;
assert.equal(providerSitesToCameras({ features: [pendingWithHeight] }, 'Pano AI').features[0].properties.viewshed_id, null);
