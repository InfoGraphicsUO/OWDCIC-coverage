// camera to viewshed join must key on id or location, not only display names
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { attachViewshedIds, countPointsInGeometry, outsideApiSitesToCameras, providerSitesToCameras } from '../js/geojson-transform.js';

const manifest = JSON.parse(readFileSync(new URL('../data/live/alertwest-viewshed-manifest.json', import.meta.url), 'utf8'));
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
const newSites = JSON.parse(readFileSync(new URL('../data/live/alertwest-sites.geojson', import.meta.url), 'utf8'));
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

// counts come from the data files, so adding or removing sites needs no edits here
const readData = (path) => JSON.parse(readFileSync(new URL(`../data/${path}`, import.meta.url), 'utf8'));
const publishedIds = (provider) => new Set(readData(`live/${provider}-viewshed-manifest.json`).viewsheds
  .filter((item) => item.status === 'complete').map((item) => item.viewshed_id));
// every camera with a published viewshed links to it, and no other camera does
const assertLinksPublished = (cameras, provider) => assert.deepEqual(
  new Set(cameras.map((f) => f.properties.viewshed_id).filter(Boolean)),
  publishedIds(provider),
);

const panoSites = readData('live/pano-sites.geojson');
const panoCameras = providerSitesToCameras(panoSites, 'Pano AI').features;
assert.equal(panoCameras.length, panoSites.features.length);
assertLinksPublished(panoCameras, 'pano');

// each owner's table lands in the one Pano layer, and every owner is a listed one
const panoOwners = readData('source/camera-providers.json').panoOwners;
assert.ok(panoCameras.every((f) => f.properties.owner in panoOwners));

// every site carries its owner's public viewer, and a feed links to a station page on it
for (const { properties } of panoCameras) {
  const owner = panoOwners[properties.owner];
  assert.deepEqual([properties.viewerUrl, properties.viewerName], [owner.viewerUrl, owner.viewerName]);
  if (properties.feed) assert.ok(properties.feed.startsWith(`${owner.viewerUrl}station/`), properties.name);
}
// Avista's public viewer leaves out Lewiston
assert.equal(panoCameras.find((f) => f.properties.name === 'Lewiston').properties.feed, null);

// EnviroVision sites flag a shared ALERTWest tower themselves instead of borrowing its point
const enviroVisionSites = readData('live/envirovision-sites.geojson');
const enviroVisionCameras = providerSitesToCameras(enviroVisionSites, 'EnviroVision').features;
assert.equal(enviroVisionCameras.length, enviroVisionSites.features.length);
assertLinksPublished(enviroVisionCameras, 'envirovision');
assert.deepEqual(
  enviroVisionCameras.map((f) => f.properties.sharesAlertWestSite),
  enviroVisionSites.features.map((f) => f.properties.sharesAlertWestSite === true),
);

const pendingWithHeight = structuredClone(panoSites.features.find(f => f.properties.name === 'Midnight Gulch'));
pendingWithHeight.properties.cameraHeightFt = 100;
pendingWithHeight.properties.viewshedStatus = 'pending';
assert.equal(providerSitesToCameras({ features: [pendingWithHeight] }, 'Pano AI').features[0].properties.viewshed_id, null);

// live sites ALERTWest keeps out of its API get a marker from the sites file, with no feed or image
const alertWestSites = JSON.parse(readFileSync(new URL('../data/live/alertwest-sites.geojson', import.meta.url), 'utf8'));
const outsideApi = attachViewshedIds({ features: outsideApiSitesToCameras(alertWestSites) }, manifest, alertWestSites).features;
assert.deepEqual(outsideApi.map(f => [f.properties.name, f.properties.viewshed_id]),
  [['Callahan Ridge', 'callahan-ridge'], ['Bear Mountain', 'bear-mountain']]);
assert.ok(outsideApi.every(f => f.properties.id == null && f.properties.image == null));
assert.deepEqual(outsideApi.map(f => [f.properties.county, f.properties.state]), [['Douglas', 'OR'], ['Lane', 'OR']]);

// area camera counts skip points in holes and outside every part, largest provider first
{
  const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
  const geometry = { type: 'MultiPolygon', coordinates: [[square(0, 0, 10), square(4, 4, 2)], [square(20, 0, 2)]] };
  const point = (operator, lon, lat) => ({ geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { operator } });
  const cameras = {
    features: [
      point('A', 1, 1), point('B', 2, 2), point('B', 21, 1), point('B', 5, 5), point('A', 30, 30),
    ],
  };
  assert.deepEqual(countPointsInGeometry(cameras, geometry, (f) => f.properties.operator), [['B', 2], ['A', 1]]);
  assert.deepEqual(countPointsInGeometry(cameras, null, (f) => f.properties.operator), []);
}
