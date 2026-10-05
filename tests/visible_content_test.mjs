// the editable list in js/visible-content.js resolves to the filters the site builds
import { strict as assert } from 'node:assert';
import {
  FILTER_TYPES,
  filterOptionIsVisible,
  unmatchedFilterOptions,
  visibleFilterTypes,
} from '../js/config.js';
import { VISIBLE_FILTERS } from '../js/visible-content.js';

// the shipped list only names things the code can build
const shippedWarnings = [];
const shipped = visibleFilterTypes(VISIBLE_FILTERS, FILTER_TYPES, (text) => shippedWarnings.push(text));
assert.deepEqual(shippedWarnings, []);
assert.equal(shipped.length, Object.keys(VISIBLE_FILTERS).length);

// groups follow list order, ignore case, and drop unknown names with a warning
const warnings = [];
const types = visibleFilterTypes(
  { 'federal land': ['Bureau of Land Management', ' u.s. forest service '], State: 'all', Nope: 'all' },
  FILTER_TYPES,
  (text) => warnings.push(text)
);
assert.deepEqual(types.map(({ value }) => value), ['federal-land', 'state']);
assert.equal(types[1].options, null);
assert.equal(warnings.length, 1);
assert.match(warnings[0], /Nope/);

// options match by label, name, or divisionId; unlisted ones are hidden
const [federal, state] = types;
assert.ok(filterOptionIsVisible(state, { label: 'Oregon' }));
assert.ok(filterOptionIsVisible(federal, { label: 'U.S. Forest Service' }));
assert.ok(!filterOptionIsVisible(federal, { label: 'National Park Service' }));
const [county] = visibleFilterTypes({ County: ['Baker County', 'county:41009'] });
assert.ok(filterOptionIsVisible(county, { label: 'Baker', name: 'Baker County', divisionId: 'county:41001' }));
assert.ok(filterOptionIsVisible(county, { label: 'Columbia', divisionId: 'county:41009' }));
assert.ok(!filterOptionIsVisible(county, { label: 'Columbia', divisionId: 'county:53013' }));

// listed options that match nothing are reported so typos surface
assert.deepEqual(
  unmatchedFilterOptions(county, [{ properties: { label: 'Baker', name: 'Baker County' } }]),
  ['county:41009']
);
assert.deepEqual(unmatchedFilterOptions(state, []), []);

console.log('visible content tests passed');
