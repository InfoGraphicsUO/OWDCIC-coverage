// the editable lists in js/visible-content.js resolve to the filters and legend rows the site builds
import { strict as assert } from 'node:assert';
import {
  FILTER_TYPES,
  LEGEND_LAYERS,
  filterOptionIsVisible,
  filterOptionRank,
  nestedFilterParent,
  unmatchedFilterOptions,
  visibleFilterTypes,
  visibleLegendItems,
} from '../js/config.js';
import { VISIBLE_FILTERS, VISIBLE_LAYERS } from '../js/visible-content.js';

// the shipped lists only name things the code can build
const shippedWarnings = [];
const shipped = visibleFilterTypes(VISIBLE_FILTERS, FILTER_TYPES, (text) => shippedWarnings.push(text));
assert.deepEqual(shippedWarnings, []);

const shippedPaths = shipped.map(({ group, label }) => [...group, label].join(' > '));
assert.deepEqual(shippedPaths, [
  'Federal land',
  'Utility provider',
  'ODF protection district',
  'Camera',
  'Other > Legislative > State House',
  'Other > Legislative > US House',
  'Other > Legislative > State Senate',
  'Other > Tribal land',
  'Other > State',
  'Other > County',
  'National Forest',
]);

// National Forest opens from the Federal land option rather than listing on its own
assert.deepEqual(nestedFilterParent('national-forest', shipped),
  { type: 'federal-land', option: 'federal-land:USFS' });
assert.equal(nestedFilterParent('national-forest', shipped.filter(({ value }) => value !== 'federal-land')), null);
assert.equal(nestedFilterParent('federal-land', shipped), null);

const legendLabels = new Set(Object.values(LEGEND_LAYERS));
for (const label of VISIBLE_LAYERS) {
  assert.ok(legendLabels.has(label), `${label} must be a LEGEND_LAYERS value`);
}

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

// 'none' and blank values remove the group without a warning
const blankWarnings = [];
const kept = visibleFilterTypes(
  {
    State: 'none',
    County: [],
    'State House': '',
    'US House': null,
    'State Senate': undefined,
    'Utility provider': ['', '  '],
    'National Forest': ' None ',
    'Federal land': ['U.S. Forest Service'],
    Camera: 'all',
  },
  FILTER_TYPES,
  (text) => blankWarnings.push(text)
);
assert.deepEqual(kept.map(({ value }) => value), ['federal-land', 'camera']);
assert.deepEqual(blankWarnings, []);

// object values are folders: types keep list order and carry the folder names they sit in
const folderWarnings = [];
const folded = visibleFilterTypes(
  {
    Camera: 'all',
    Outer: {
      Inner: { 'State House': 'all', 'US House': 'none' },
      'Tribal land': ['Some tribe'],
      Empty: { County: 'none' },
    },
    'federal land': 'all',
    Nope: { Missing: 'all' },
  },
  FILTER_TYPES,
  (text) => folderWarnings.push(text)
);
assert.deepEqual(folded.map(({ value }) => value), ['camera', 'house', 'tribal-land', 'federal-land']);
assert.deepEqual(folded.map(({ group }) => group), [[], ['Outer', 'Inner'], ['Outer'], []]);
assert.deepEqual([...folded[2].options], ['some tribe']);
assert.equal(folderWarnings.length, 1);
assert.match(folderWarnings[0], /Missing/);

// options match by label, name, or divisionId; unlisted ones are hidden
const [federal, state] = types;
assert.ok(filterOptionIsVisible(state, { label: 'Oregon' }));
assert.ok(filterOptionIsVisible(federal, { label: 'U.S. Forest Service' }));
assert.ok(!filterOptionIsVisible(federal, { label: 'National Park Service' }));

// listed groups keep list order, 'all' groups have none, unlisted options sort last
const [shippedFederal] = visibleFilterTypes({ 'Federal land': ['National Forest', 'Dept of Interior (BLM, USFWS, NPS)'] });
assert.equal(filterOptionRank(shippedFederal, { label: 'National Forest' }), 0);
assert.equal(filterOptionRank(shippedFederal, { label: 'Dept of Interior (BLM, USFWS, NPS)' }), 1);
assert.equal(filterOptionRank(shippedFederal, { label: 'Other' }), 2);
assert.equal(filterOptionRank(state, { label: 'Oregon' }), 0);

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

// legend rows follow list order; startup-hidden rows stay; the rest are set aside
const items = [
  { label: 'A', layerIds: ['a'] },
  { label: 'Secret', hidden: true, layerIds: ['s'] },
  { label: 'B', layerIds: ['b'] },
  { label: 'C', layerIds: ['c'] },
];

const layerWarnings = [];
const rows = visibleLegendItems(items, ['c', 'A', 'Secret', 'Missing'], (text) => layerWarnings.push(text));
assert.deepEqual(rows.visible.map(({ label }) => label), ['C', 'A', 'Secret']);
assert.deepEqual(rows.removed.map(({ label }) => label), ['B']);
assert.equal(layerWarnings.length, 2);

console.log('visible content tests passed');
