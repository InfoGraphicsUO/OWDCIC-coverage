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
    this.attributes = {};
    this.listeners = {};
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

  setAttribute(name, value) { this.attributes[name] = `${value}`; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  click() { this.listeners.click?.(); }
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

// sections: one with a layer on starts open, whatever its place in the list
const sectioned = initLegend([
  { label: 'National forests', section: 'Land management', visible: false, layerIds: [] },
  { label: 'BLM lands', section: 'Land management', visible: false, layerIds: [] },
  { label: 'Cameras', section: 'Camera data', layerIds: [] },
]);
const [, landSection, cameraSection] = legend.children;
const sectionItems = (section) => section.children[1];
assert.equal(sectionItems(cameraSection).hidden, false, 'a section with a layer on starts open');
assert.equal(sectionItems(landSection).hidden, true, 'a section with every layer off starts closed');

// a layer switched on by code opens its section
sectioned.setVisible('National forests', true);
sectioned.setVisible('BLM lands', true);
assert.equal(sectionItems(landSection).hidden, false);

// switching one off keeps the section open while another layer in it is on
sectioned.setVisible('National forests', false);
assert.equal(sectionItems(landSection).hidden, false);

// switching the last one off closes it again
sectioned.setVisible('BLM lands', false);
assert.equal(sectionItems(landSection).hidden, true);

// a section the user opened stays open when code switches its layer back off
landSection.children[0].click();
sectioned.setVisible('National forests', true);
sectioned.setVisible('National forests', false);
assert.equal(sectionItems(landSection).hidden, false, 'a section the user opened stays open');

// a hidden row comes back inside its own section, between the rows around it there
const withHiddenRow = initLegend([
  { label: 'Cameras', section: 'Camera data', layerIds: [] },
  { label: 'Hidden cameras', section: 'Camera data', hidden: true, layerIds: [] },
  { label: 'Camera viewsheds', section: 'Camera data', layerIds: [] },
  { label: 'Fire history', section: 'Fire data', visible: false, layerIds: [] },
]);
const cameraRows = sectionItems(legend.children[1]).children;
const [firstRow, lastRow] = cameraRows;
assert.equal(cameraRows.length, 2, 'a hidden row stays out of its section');

withHiddenRow.setHidden('Hidden cameras', false);
assert.equal(legend.children.length, 3, 'a revealed row must not land outside its section');
assert.equal(cameraRows.length, 3);
assert.equal(cameraRows[0], firstRow);
assert.equal(cameraRows[2], lastRow);

withHiddenRow.setHidden('Hidden cameras', false);
assert.equal(cameraRows.length, 3, 'repeat reveal must not duplicate the row');

withHiddenRow.setHidden('Hidden cameras', true);
assert.deepEqual(cameraRows, [firstRow, lastRow]);

console.log('legend hidden group DOM contract passed');
