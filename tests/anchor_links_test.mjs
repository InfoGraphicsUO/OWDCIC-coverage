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
} from '../js/anchor-links.js';

// slugs keep letters and digits and fold everything else into single hyphens
assert.equal(anchorSlug('Pacific Power (PacifiCorp)'), 'pacific-power-pacificorp');
assert.equal(anchorSlug('  U.S. Forest Service '), 'u-s-forest-service');
assert.equal(anchorSlug('Peña Blanca'), 'pena-blanca');
assert.equal(anchorSlug(null), '');

// a link is the type slug, then an optional option slug
assert.equal(formatAnchor('county'), '?coverage=county');
assert.equal(formatAnchor('county', 'or-lane'), '?coverage=county&selection=or-lane');
assert.equal(formatAnchor('', 'or-lane'), '');
assert.deepEqual(parseAnchor('?coverage=county'), { type: 'county', option: null });
assert.deepEqual(parseAnchor('?coverage=county&selection=or-lane'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseAnchor('?coverage=County&selection=OR%20Lane'), { type: 'county', option: 'or-lane' });
assert.deepEqual(parseAnchor('?coverage=county&selection='), { type: 'county', option: null });
assert.equal(parseAnchor(''), null);
assert.equal(parseAnchor('?'), null);
assert.equal(parseAnchor('?selection=or-lane'), null);
// a broken escape matches nothing instead of throwing
assert.doesNotThrow(() => parseAnchor('?coverage=%E0%A4%A'));
// links shared before the rename still open, and are rewritten with the new name
assert.deepEqual(parseAnchor('?filter=county&selection=or-lane'), { type: 'county', option: 'or-lane' });
assert.equal(formatAnchor('county', 'or-lane', '?filter=state'), '?coverage=county&selection=or-lane');
assert.equal(formatAnchor('', null, '?filter=county&selection=or-lane'), '');

// other query parameters survive a link being written, replaced, or cleared
assert.equal(formatAnchor('county', 'or-lane', '?basemap=topo'), '?basemap=topo&coverage=county&selection=or-lane');
assert.equal(formatAnchor('utility-provider', null, '?coverage=county&selection=or-lane&basemap=topo'), '?basemap=topo&coverage=utility-provider');
assert.equal(formatAnchor('', null, '?coverage=county&basemap=topo'), '?basemap=topo');
assert.equal(formatAnchor('', null, '?coverage=county&selection=or-lane'), '');

// every shipped filter group has its own slug and can be found by slug or type id
const types = visibleFilterTypes(VISIBLE_FILTERS, FILTER_TYPES, () => {});
const typeSlugs = types.map(({ label }) => anchorSlug(label));
assert.equal(new Set(typeSlugs).size, types.length);
assert.ok(typeSlugs.every(Boolean));
assert.equal(anchorType(types, 'utility-provider').value, 'utility');
assert.equal(anchorType(types, 'utility').value, 'utility');
assert.equal(anchorType(types, 'nope'), null);

// a trailing name in parentheses is the whole slug
const utilities = anchorOptionSlugs([
  { value: 'utility:42', label: 'Pacific Power (PacifiCorp)' },
  { value: 'utility:44', label: 'Portland General Electric (PGE)' },
]);
assert.equal(utilities.get('utility:42'), 'pacificorp');
assert.equal(anchorOptionValue(utilities, 'pge'), 'utility:44');
assert.equal(anchorOptionValue(utilities, 'eweb'), null);

// words that only name the kind of place are left out
const districts = anchorOptionSlugs([
  { value: 'odf:1', label: 'Central Oregon District', state: 'OR' },
  { value: 'odf:2', label: 'Klamath-Lake District', state: 'OR' },
  { value: 'odf:all', label: 'All ODF districts', state: 'OR' },
]);
assert.equal(districts.get('odf:1'), 'central-oregon');
// the combined option keeps its own words, so existing district links do not change
assert.equal(districts.get('odf:all'), 'all-odf-districts');
const parks = anchorOptionSlugs([
  { value: 'park:1', label: 'Deschutes National Forest' },
  { value: 'park:2', label: 'Oregon Caves National Monument and Preserve' },
  { value: 'park:3', label: "Ebey's Landing National Historical Reserve" },
  { value: 'park:4', label: 'Chehalis Off-Reservation Trust Land' },
  { value: 'park:5', label: 'Chehalis Reservation' },
]);
assert.deepEqual([...parks.values()],
  ['deschutes', 'oregon-caves', 'ebeys-landing', 'chehalis-trust-land', 'chehalis']);

// short names that collide keep their filler words
const agencies = anchorOptionSlugs([
  { value: 'federal-land:USFS', label: 'U.S. Forest Service' },
  { value: 'federal-land:NPS', label: 'National Park Service' },
  { value: 'federal-land:BLM', label: 'Bureau of Land Management' },
]);
assert.equal(agencies.get('federal-land:USFS'), 'forest-service');
assert.equal(agencies.get('federal-land:NPS'), 'national-park-service');
assert.equal(agencies.get('federal-land:BLM'), 'bureau-of-land-management');
// a label made only of filler words keeps them
assert.equal(anchorOptionSlugs([{ value: 1, label: 'State Forest' }]).get('1'), 'state-forest');

// types spanning both states prefix every option so shared names stay apart
const counties = anchorOptionSlugs([
  { value: 'county:41003', label: 'Benton', state: 'OR' },
  { value: 'county:53005', label: 'Benton', state: 'WA' },
  { value: 'county:41039', label: 'Lane', state: 'OR' },
]);
assert.equal(counties.get('county:41003'), 'or-benton');
assert.equal(counties.get('county:53005'), 'wa-benton');
assert.equal(counties.get('county:41039'), 'or-lane');
const houses = anchorOptionSlugs([
  { value: 'house:41010', label: 'State House District 10', state: 'OR' },
  { value: 'house:53010', label: 'Legislative (House) District 10', state: 'WA' },
]);
assert.equal(houses.get('house:41010'), 'or-10');
assert.equal(houses.get('house:53010'), 'wa-10');
// the prefix is dropped when the names are already unique without it
const states = anchorOptionSlugs([
  { value: 'state:41', label: 'Oregon', state: 'OR' },
  { value: 'state:53', label: 'Washington', state: 'WA' },
]);
assert.equal(states.get('state:41'), 'oregon');
assert.equal(states.get('state:53'), 'washington');

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
