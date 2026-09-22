import { strict as assert } from 'node:assert';
import { initLegend } from '../js/legend.js';

// model just the node operations used by legend construction and group toggles
class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.className = '';
    this.style = { setProperty() {} };
    this.classList = { add() {}, toggle() {} };
    this.textContent = '';
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }

  insertBefore(child, next) {
    const index = next ? this.children.indexOf(next) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }

  setAttribute() {}
  addEventListener() {}
}

const legend = new Node('aside');
// keep the fixture scoped to the legend root expected by initLegend
globalThis.document = {
  getElementById(id) { return id === 'legend' ? legend : null; },
  createElement(tag) { return new Node(tag); },
};

const control = initLegend([
  { label: 'Cameras (ALERTWest)', layerIds: [] },
  {
    label: 'Digitized Camera Sources',
    hidden: true,
    layerIds: [],
    children: [
      { label: 'EnviroVision Solutions', layerIds: [] },
      { label: 'Pano AI', layerIds: [] },
    ],
  },
  { label: 'Camera viewsheds', layerIds: [] },
]);

// a hidden group and its children must stay out of the initial layer list
assert.equal(legend.children.length, 3, 'hidden camera group must not enter the Layers DOM');
assert.equal(legend.children.some((child) => child.className === 'legend-group'), false);

// revealing inserts the group between the rows that preceded and followed it
control.setHidden('Digitized Camera Sources', false);
assert.deepEqual(legend.children.map((child) => child.className), [
  'legend-title', 'legend-row', 'legend-group', 'legend-row',
]);

// repeated state application is idempotent instead of appending another group
control.setHidden('Digitized Camera Sources', false);
assert.equal(legend.children.length, 4, 'repeat reveal must not duplicate the group');

// hiding removes the whole group from the visible legend tree
control.setHidden('Digitized Camera Sources', true);
assert.equal(legend.children.some((child) => child.className === 'legend-group'), false);

console.log('legend hidden group DOM contract passed');
