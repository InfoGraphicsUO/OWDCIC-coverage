// filter layer presets resolve from config and toggle legend rows through the checkbox path
import { strict as assert } from 'node:assert';
import { LEGEND_LAYERS, FILTER_LAYER_PRESETS, layerPresetForFilter } from '../js/config.js';
import { initLegend } from '../js/legend.js';

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.style = { setProperty() {} };
    this.classList = { add() {}, toggle() {} };
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  addEventListener() {}
}

const legend = new Node('aside');
globalThis.document = {
  getElementById() { return legend; },
  createElement(tag) { return new Node(tag); },
};

// unknown filter types have no preset; known ones only name real legend rows
assert.equal(layerPresetForFilter('county'), null);
assert.equal(layerPresetForFilter('toString'), null);
assert.deepEqual(layerPresetForFilter('utility').layersOn, [LEGEND_LAYERS.transmissionLines]);
const labels = new Set(Object.values(LEGEND_LAYERS));
for (const preset of Object.values(FILTER_LAYER_PRESETS)) {
  for (const label of [...(preset.layersOn ?? []), ...(preset.layersOff ?? [])]) {
    assert.ok(labels.has(label), `${label} must be a LEGEND_LAYERS value`);
  }
}

// fake map records visibility so the toggle must reach Mapbox
const visibility = {};
const map = {
  getLayer: () => true,
  setLayoutProperty: (id, _prop, value) => { visibility[id] = value; },
};
const control = initLegend([
  { label: 'Solo', visible: false, layerIds: ['solo'] },
  {
    label: 'Group',
    layerIds: [],
    children: [
      { label: 'Child A', layerIds: ['a'] },
      { label: 'Child B', layerIds: ['b'] },
    ],
  },
]);

// before connect only the checkbox changes; connect then applies it
assert.equal(control.setVisible('Solo', true), true);
control.connect(map);
assert.equal(visibility.solo, 'visible');

control.setVisible('Solo', false);
assert.equal(visibility.solo, 'none');

// a child toggle updates its layers
control.setVisible('Child A', false);
assert.equal(visibility.a, 'none');

// a parent toggle reaches every child
control.setVisible('Group', false);
assert.equal(visibility.b, 'none');

assert.equal(control.setVisible('Missing', true), false);

console.log('layer preset contract passed');
