// anchor links turn filter labels into URL query strings and read them back
import { strict as assert } from 'node:assert';
import { FILTER_TYPES, visibleFilterTypes } from '../js/config.js';
import { VISIBLE_FILTERS } from '../js/visible-content.js';
import {
  anchorOptionSlugs,
  anchorOptionValue,
  anchorSlug,
  anchorType,
  formatAnchor,
  parseAnchor,
  parseLegacyAnchor,
} from '../js/anchor-links.js';

// slugs keep letters and digits and fold everything else into single hyphens
assert.equal(anchorSlug('Pacific Power (PacifiCorp)'), 'pacific-power-pacificorp');
assert.equal(anchorSlug('  U.S. Forest Service '), 'u-s-forest-service');
assert.equal(anchorSlug('Peña Blanca'), 'pena-blanca');
assert.equal(anchorSlug(null), '');

// a link is the type slug, then an optional option slug
assert.equal(formatAnchor('county'), '?filter=county');
assert.equal(formatAnchor('county', 'or-lane'), '?filter=county&selection=or-lane');
assert.equal(formatAnchor('', 'or-lane'), '');
assert.deepEqual(parseAnchor('?filter=county'), { type: 'county', option: null });
assert.deepEqual(parseAnchor('?filter=county&selection=or-lane'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseAnchor('?filter=County&selection=OR%20Lane'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseAnchor('?filter=county&selection='), { type: 'county', option: null });
assert.equal(parseAnchor(''), null);
assert.equal(parseAnchor('?'), null);
assert.equal(parseAnchor('?selection=or-lane'), null);
// a broken escape matches nothing instead of throwing
assert.doesNotThrow(() => parseAnchor('?filter=%E0%A4%A'));

// other query parameters survive a link being written, replaced, or cleared
assert.equal(formatAnchor('county', 'or-lane', '?basemap=topo'), '?basemap=topo&filter=county&selection=or-lane');
assert.equal(formatAnchor('utility-provider', null, '?filter=county&selection=or-lane&basemap=topo'), '?basemap=topo&filter=utility-provider');
assert.equal(formatAnchor('', null, '?filter=county&basemap=topo'), '?basemap=topo');
assert.equal(formatAnchor('', null, '?filter=county&selection=or-lane'), '');

// hash links from before the query string are still read
assert.deepEqual(parseLegacyAnchor('#county'), { type: 'county', option: null });
assert.deepEqual(parseLegacyAnchor('#county/or-lane'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseLegacyAnchor('#County/OR%20Lane/extra'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseLegacyAnchor('#county/'), { type: 'county', option: null });
assert.equal(parseLegacyAnchor(''), null);
assert.equal(parseLegacyAnchor('#'), null);
assert.equal(parseLegacyAnchor('#/or-lane'), null);
assert.doesNotThrow(() => parseLegacyAnchor('#%E0%A4%A'));

// every shipped filter group has its own slug and can be found by slug or type id
const types = visibleFilterTypes(VISIBLE_FILTERS, FILTER_TYPES, () => {});
const typeSlugs = types.map(({ label }) => anchorSlug(label));
assert.equal(new Set(typeSlugs).size, types.length);
assert.ok(typeSlugs.every(Boolean));
assert.equal(anchorType(types, 'utility-provider').value, 'utility');
assert.equal(anchorType(types, 'utility').value, 'utility');
assert.equal(anchorType(types, 'nope'), null);

// one-state types use the bare label
const utilities = anchorOptionSlugs([
  { value: 'utility:42', label: 'Pacific Power (PacifiCorp)' },
  { value: 'utility:44', label: 'Portland General Electric (PGE)' },
]);
assert.equal(utilities.get('utility:42'), 'pacific-power-pacificorp');
assert.equal(anchorOptionValue(utilities, 'portland-general-electric-pge'), 'utility:44');
assert.equal(anchorOptionValue(utilities, 'eweb'), null);
const districts = anchorOptionSlugs([
  { value: 'odf:1', label: 'Central Oregon District', state: 'OR' },
  { value: 'odf:2', label: 'Klamath-Lake District', state: 'OR' },
]);
assert.equal(districts.get('odf:1'), 'central-oregon-district');

// types spanning both states prefix every option so shared names stay apart
const counties = anchorOptionSlugs([
  { value: 'county:41003', label: 'Benton', state: 'OR' },
  { value: 'county:53005', label: 'Benton', state: 'WA' },
  { value: 'county:41039', label: 'Lane', state: 'OR' },
]);
assert.equal(counties.get('county:41003'), 'or-benton');
assert.equal(counties.get('county:53005'), 'wa-benton');
assert.equal(counties.get('county:41039'), 'or-lane');

// names that still collide, or have no usable letters, fall back to the option value
const cameras = anchorOptionSlugs([
  { value: 101, label: 'Lenhart' },
  { value: 102, label: 'Lenhart' },
  { value: 103, label: '***' },
  { value: 104, label: 'Halfway' },
]);
assert.equal(cameras.get('101'), 'lenhart-101');
assert.equal(cameras.get('102'), 'lenhart-102');
assert.equal(cameras.get('103'), '103');
assert.equal(cameras.get('104'), 'halfway');
assert.equal(new Set(cameras.values()).size, 4);

console.log('anchor links tests passed');
