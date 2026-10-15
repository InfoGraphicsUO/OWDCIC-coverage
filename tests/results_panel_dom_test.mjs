// exercise the results panel API against a minimal DOM mock
import { strict as assert } from 'node:assert';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

class ClassList {
  constructor(el) { this.el = el; this._set = new Set(); }
  add(...names) { names.forEach((n) => this._set.add(n)); this.el.className = [...this._set].join(' '); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); this.el.className = [...this._set].join(' '); }
  contains(name) { return this._set.has(name); }
}

// expose only browser behavior the panel needs, while recording export drawing calls
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.attributes = {};
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.classList = new ClassList(this);
    this._text = '';
    this._html = '';
    this.width = 400;
    this.height = 200;
    this.href = '';
    this.download = '';
    this.target = '';
    this.rel = '';
    this.src = '';
    this.alt = '';
    this.loading = '';
    this.decoding = '';
    this.id = '';
    this.offsetParent = this;
  }
  // text nodes and child elements both contribute to the observed text content
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children.length = 0; }
  get innerHTML() { return this._html || this.textContent; }
  set innerHTML(value) { this._html = String(value ?? ''); this.children.length = 0; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    // enough aria-hidden behavior for panel visibility assertions
    if (name === 'aria-hidden' && value === 'true') this.hidden = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'aria-busy') delete this.attributes['aria-busy'];
    if (name === 'aria-hidden') this.hidden = false;
  }
  // attached nodes trace their parents back to the document body
  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node === globalThis.document?.body;
  }
  querySelector(selector) { return queryAll(this, selector)[0] || null; }
  querySelectorAll(selector) { return queryAll(this, selector); }
  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      const child = typeof node === 'string' ? textNode(node) : node;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    this.children.splice(0, this.children.length);
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement?.children) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.parentElement = null;
  }
  addEventListener(type, handler) {
    this._listeners ??= {};
    (this._listeners[type] ??= []).push(handler);
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  click() {
    (this._listeners?.click || []).forEach((handler) => handler());
  }
  getContext() {
    // record export drawing calls without rasterizing pixels in node
    const noop = () => {};
    const context = {
      fillStyle: '',
      strokeStyle: '',
      font: '',
      lineWidth: 1,
      lineJoin: 'round',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: noop,
      restore: noop,
      scale: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      quadraticCurveTo: noop,
      stroke: noop,
      fill: () => { (this.fills ??= []).push(this._context?.fillStyle); },
      fillRect: noop,
      strokeRect: noop,
      drawImage: (...args) => { (this.drawImageCalls ??= []).push(args); },
      fillText: (value) => { (this.drawnText ??= []).push(value); },
      strokeText: noop,
      arc: noop,
      closePath: noop,
      createLinearGradient() {
        return { addColorStop: noop };
      },
      measureText(text) {
        return { width: String(text).length * 7 };
      },
    };
    this._context = context;
    return context;
  }
  toDataURL() { return PNG; }
}

function textNode(value) {
  const node = new FakeNode('#text');
  node.textContent = value;
  return node;
}

function queryAll(root, selector) {
  // walk descendants and include the root for document-level selector queries
  const matches = [];
  const visit = (node) => {
    if (matchesSelector(node, selector)) matches.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const child of root.children || []) visit(child);
  if (matchesSelector(root, selector)) matches.unshift(root);
  return matches;
}

function matchesSelector(node, selector) {
  // cover the selector forms used by the panel's markup and export path
  if (selector.startsWith('#')) return node.id === selector.slice(1) || node.attributes.id === selector.slice(1);
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1);
    const [rawName, rawValue] = body.split('=');
    const name = rawName.trim();
    if (rawValue == null) return Object.prototype.hasOwnProperty.call(node.attributes, name) || (name.startsWith('data-') && node.dataset[camel(name.slice(5))] != null);
    return node.attributes[name] === rawValue.replace(/"/g, '');
  }
  if (selector.includes('.')) {
    const [tag, cls] = selector.split('.');
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    return node.classList.contains(cls) || node.className.split(/\s+/).includes(cls);
  }
  return node.tagName === selector.toUpperCase();
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function el(tag, attrs = {}) {
  const node = new FakeNode(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  });
  return node;
}

const body = new FakeNode('body');
// mirror the panel markup in index.html, which initResultsPanel expects as-is
const panel = el('aside', { id: 'results-panel' });
const footer = el('div', { 'data-results-footer': '' });
footer.append(
  el('button', { 'data-results-export': '', type: 'button' }),
  el('button', { 'data-results-share': '', type: 'button' }),
  el('p', { 'data-results-status': '' }),
);
panel.append(
  el('h2', { 'data-results-title': '' }),
  el('p', { 'data-results-subtitle': '' }),
  el('button', { 'data-results-close': '', type: 'button' }),
  el('div', { 'data-results-content': '' }),
  footer,
);
body.append(panel);

globalThis.window = globalThis;
globalThis.document = {
  body,
  activeElement: panel.querySelector('[data-results-export]'),
  querySelector(selector) {
    if (selector === '#results-panel') return panel;
    return body.querySelector(selector);
  },
  createElement(tag) { return new FakeNode(tag); },
  addEventListener(type, handler) {
    globalThis.document._docListeners ??= {};
    (globalThis.document._docListeners[type] ??= []).push(handler);
  },
  removeEventListener(type, handler) {
    const list = globalThis.document._docListeners?.[type] || [];
    globalThis.document._docListeners[type] = list.filter((item) => item !== handler);
  },
};
// resolve generated images on the next microtask, matching the async export path
globalThis.Image = class {
  constructor() { this.width = 400; this.height = 240; }
  // let export observe image loading after the src assignment
  set src(value) { this._src = value; queueMicrotask(() => this.onload && this.onload()); }
};
globalThis.matchMedia = () => ({ matches: false });
const copiedLinks = [];
// capture the label reset so the test can run it without waiting
const shareLabelTimers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => (ms === 2500 ? shareLabelTimers.push(fn) : realSetTimeout(fn, ms, ...args));
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (text) => { copiedLinks.push(text); } } },
});
globalThis.location = { href: 'https://example.test/?coverage=county&selection=or-lane' };
globalThis.URL = URL;
globalThis.requestAnimationFrame = (fn) => queueMicrotask(fn);

const downloads = [];
const originalClick = FakeNode.prototype.click;
FakeNode.prototype.click = function click() {
  // capture anchor downloads while keeping normal click handlers active
  if (this.tagName === 'A' && this.download) downloads.push({ href: this.href, download: this.download });
  originalClick.call(this);
};

const { initResultsPanel, condenseCameraLegendRows } = await import('../js/results-panel.js');

// the export legend drops group rows and collapses viewsheds that share a color
const mapLegendRows = [
  'Cameras', 'ALERTWest cameras', 'Pano AI cameras',
  'Camera viewsheds', 'ALERTWest camera viewsheds', 'Pano AI camera viewsheds',
  'Standing lookouts',
].map((label) => ({ label, visual: { type: 'swatch', style: 'fill', color: label } }));
const sharedRows = condenseCameraLegendRows(mapLegendRows);
assert.deepEqual(sharedRows.map(({ label }) => label),
  ['ALERTWest cameras', 'Pano AI cameras', 'Viewsheds', 'Standing lookouts']);
assert.equal(sharedRows[2].visual.color, 'ALERTWest camera viewsheds',
  'shared viewshed row should reuse the provider swatch shown on the map');
assert.deepEqual(
  condenseCameraLegendRows(mapLegendRows, { separateViewshedColors: true }).map(({ label }) => label),
  ['ALERTWest cameras', 'Pano AI cameras', 'ALERTWest viewsheds', 'Pano AI viewsheds', 'Standing lookouts']);
// one provider switched off still follows the color setting
const panoOnly = mapLegendRows.filter(({ label }) => !label.startsWith('ALERTWest'));
assert.deepEqual(condenseCameraLegendRows(panoOnly).map(({ label }) => label),
  ['Pano AI cameras', 'Viewsheds', 'Standing lookouts']);
assert.deepEqual(
  condenseCameraLegendRows(panoOnly, { separateViewshedColors: true }).map(({ label }) => label),
  ['Pano AI cameras', 'Pano AI viewsheds', 'Standing lookouts']);

// a third provider joins the same rows
const threeProviders = [
  'Cameras', 'ALERTWest cameras', 'Pano AI cameras', 'EnviroVision cameras',
  'Camera viewsheds', 'ALERTWest camera viewsheds', 'Pano AI camera viewsheds', 'EnviroVision camera viewsheds',
].map((label) => ({ label }));
assert.deepEqual(condenseCameraLegendRows(threeProviders).map(({ label }) => label),
  ['ALERTWest cameras', 'Pano AI cameras', 'EnviroVision cameras', 'Viewsheds']);
assert.deepEqual(
  condenseCameraLegendRows(threeProviders, { separateViewshedColors: true }).map(({ label }) => label).slice(3),
  ['ALERTWest viewsheds', 'Pano AI viewsheds', 'EnviroVision viewsheds']);

// retain map and export canvas inputs so the crop math can be checked directly
const canvas = new FakeNode('canvas');
canvas.width = 1200;
canvas.height = 720;
// keep generated export canvases available for size and crop assertions
const exportCanvases = [];
const originalCreateElement = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.createElement = (tag) => {
  const node = originalCreateElement(tag);
  if (tag === 'canvas') exportCanvases.push(node);
  return node;
};
const projectedCoordinates = [];
// member areas behind combined options, looked up the way the map's division data is
const memberFeatures = new Map();
const api = initResultsPanel({
  getMemberFeatures: (type, ids) => ids.map((id) => memberFeatures.get(id)).filter(Boolean),
  getMap: () => ({
    project: (coordinates) => {
      // record the requested export center and keep its screen point stable
      projectedCoordinates.push(coordinates);
      return { x: 220, y: 120 };
    },
  }),
  getMapCanvas: () => canvas,
  getLegendItems: () => ['ALERTWest cameras', 'ALERTWest camera viewsheds'],
  // the map names selection symbols that have no layer row
  getSelectionLegendItems: (selection) => (selection.kind === 'polygon' ? [
    { label: `${selection.properties.name} border`, visual: { type: 'swatch', style: 'border', color: '#f8e109' } },
    { label: 'Confederated Tribes Lookout Camera viewshed', visual: { type: 'swatch', style: 'fill', color: '#ffee00' } },
  ] : []),
});

const landMix = [
  { label: 'U.S. Forest Service land', percentage: 40 },
  { label: 'State land', percentage: 10 },
  { label: 'Other/unclassified', percentage: 50 },
];

function textOf(node) {
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
}

function show(kind, ...args) {
  api[kind](...args);
  return panel.querySelector('[data-results-content]');
}

// polygon donut eligibility follows the allowed district and utility types
let content = show('showPolygon', 'house', { properties: { name: 'State House District 1', cameraViewshedCoveragePct: 5.05, cameraViewshedAreaSqKm: 446.9, landAreaSqKm: 8850.7, landMix } });
assert.match(textOf(content), /5% covered by fire detection cameras/);
assert.match(textOf(content), /mi² of State House District 1 is covered by fire detection cameras, out of total/);
assert.doesNotMatch(textOf(content), /CAMERA COVERAGE|Covered area|Selected area/i);
assert.ok(content.querySelector('[data-results-chart]'), 'house should get a donut host');
assert.match(textOf(content), /40% U\.S\. Forest Service land/);
assert.match(textOf(content), /10% State land/);
// the land status explanation lives in the heading's info tooltip
assert.match(content.querySelector('[data-tooltip]')?.dataset.tooltip || '', /Unclassified includes unmapped private land/);
assert.match(textOf(content), /Entries under 1% are not shown/);

content = show('showPolygon', 'us-house', { properties: { name: 'Congressional District 1', cameraViewshedCoveragePct: 7.2, landMix } });
assert.ok(content.querySelector('[data-results-chart]'), 'US House should get a donut host');

content = show('showPolygon', 'senate', { properties: { name: 'State Senate District 1', cameraViewshedCoveragePct: 6.4, landMix } });
assert.ok(content.querySelector('[data-results-chart]'), 'senate should get a donut host');

content = show('showPolygon', 'odf-protection-district', { properties: { name: 'Central Oregon District', cameraViewshedCoveragePct: 9.1, landMix } });
assert.ok(content.querySelector('[data-results-chart]'), 'ODF protection district should get a donut host');

content = show('showPolygon', 'state', { properties: { name: 'Oregon', cameraViewshedCoveragePct: 8.93, cameraViewshedAreaSqKm: 22121, landAreaSqKm: 247715, landMix } });
assert.match(textOf(content), /9% covered by fire detection cameras/);
// every filter group names the boundary its yellow outline traces
assert.match(textOf(content.querySelector('.results-panel__qualifier')), /^State boundary$/);
assert.equal(content.querySelector('[data-results-chart]'), null, 'state must not get a donut');

content = show('showPolygon', 'county', { properties: { name: 'Baker County', cameraViewshedCoveragePct: 2.85, landMix } });
assert.match(textOf(content.querySelector('.results-panel__qualifier')), /^County boundary$/);
assert.equal(content.querySelector('[data-results-chart]'), null, 'county must not get a donut');

for (const kind of ['national-forest', 'national-park', 'federal-land', 'tribal-land']) {
  // missing source metrics stay unavailable instead of being formatted as zero
  content = show('showPolygon', kind, { properties: { name: kind, cameraViewshedCoveragePct: null, landAreaSqKm: null, landMix } });
  assert.match(textOf(content), /Coverage unavailable/);
  assert.doesNotMatch(textOf(content), /\b0%/);
  assert.equal(content.querySelector('[data-results-chart]'), null, `${kind} must not get a donut`);
}

content = show('showPolygon', 'utility', { properties: { name: 'Eugene Water & Electric Board', cameraViewshedCoveragePct: null, landMix: [] } });
assert.match(textOf(content), /Approximate service area boundary/);
assert.match(textOf(content), /Transmission lines/);
assert.match(textOf(content), /Coverage unavailable/);
assert.equal(content.querySelector('[data-results-chart]'), null, 'utility without landMix has no donut');

content = show('showPolygon', 'utility', { properties: { name: 'Pacific Power', cameraViewshedCoveragePct: 12, landMix } });
assert.match(textOf(content), /Approximate service area boundary/);
assert.ok(content.querySelector('[data-results-chart]'), 'utility with landMix should get a donut');

// camera metadata remains useful even when coverage metrics are unavailable
content = show('showCamera', { name: 'Portland Tower', county: 'Multnomah', state: 'OR', pan: 42, id: 12, image: 'https://alertwest.live/preview.jpg' }, { coverageAvailable: false, landAreaSqKm: null, landMix: [] });
assert.match(textOf(content), /Coverage unavailable/);
assert.doesNotMatch(textOf(content), /\b0%/);
assert.equal(content.querySelector('[data-results-chart]'), null);
// camera locality is shown in the panel header rather than the body
assert.equal(panel.querySelector('[data-results-subtitle]').textContent, 'Multnomah, OR');
assert.match(textOf(content), /Pan 42°/);

content = show('showCamera', { name: 'Missing metrics cam', id: 99 }, null);
assert.match(textOf(content), /Coverage unavailable/);
assert.match(textOf(content), /no viewshed has been generated/);

// cameras with a viewshed get distinct wording from cameras without one
content = show('showCamera', { name: 'Phoenix', id: 98, viewshed_id: 'phoenix-water-tank' }, { coverageAvailable: false, status: 'skipped_missing_height', landMix: [] });
assert.match(textOf(content), /camera height is missing/);
content = show('showCamera', { name: 'Broken', id: 97, viewshed_id: 'x' }, null);
assert.match(textOf(content), /viewshed exists but/);
assert.doesNotMatch(textOf(content), /\b0%/);

content = show('showCamera', { name: 'Covered cam', id: 1 }, { coverageAvailable: true, landAreaSqKm: 12.5, landMix });
assert.ok(content.querySelector('[data-results-chart]'), 'camera viewsheds should get a donut when metrics exist');
assert.match(textOf(content), /40% U\.S\. Forest Service land/);

const exportButton = panel.querySelector('[data-results-export]');

api.showPolygon('house', {
  properties: { name: 'State House District 1', cameraViewshedCoveragePct: 5.05, cameraViewshedAreaSqKm: 10, landAreaSqKm: 100, landMix },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 40], [0, 40], [0, 0]]] },
});
// export waits for preview composition before attaching its accessible dialog
await exportButton._listeners.click[0]();
const modal = body.querySelector('.results-export-modal');
assert.ok(modal, 'Export as should open a modal');
const exportCanvas = exportCanvases.at(-1);
assert.ok(exportCanvas, 'export should allocate a canvas');
assert.equal(exportCanvas.width, 1000, 'export canvas width should scale map to at least 1000px');
assert.equal(exportCanvas.height, 600, 'export canvas height should match map aspect ratio without a bottom appendix');
// polygon crop center comes from the bounds midpoint, not the ring's first vertex
assert.deepEqual(projectedCoordinates[0], [10, 20], 'export should center its crop on the selected polygon');
assert.ok(exportCanvas.drawImageCalls[0][3] < 400, 'export should crop the map for a closer view');
assert.equal(exportCanvas.fills.filter((fill) => fill === 'rgba(47, 46, 46, 0.9)').length, 2,
  'legend and results should each use one translucent dark panel fill');
// selection rows follow the layer rows, and long names wrap inside the legend card
assert.ok(exportCanvas.drawnText.includes('State House District 1 border'),
  'export legend should name the selected area border');
assert.ok(exportCanvas.drawnText.includes('Confederated Tribes Lookout') &&
  exportCanvas.drawnText.includes('Camera viewshed'),
  'export legend should wrap a long highlighted viewshed label');
assert.ok(exportCanvas.drawnText.indexOf('Viewsheds') < exportCanvas.drawnText.indexOf('State House District 1 border'),
  'selection rows should follow the layer rows');
// the selected camera viewshed moves up under the viewshed rows while the border stays at the end
assert.ok(exportCanvas.drawnText.indexOf('Viewsheds') < exportCanvas.drawnText.indexOf('Camera viewshed') &&
  exportCanvas.drawnText.indexOf('Camera viewshed') < exportCanvas.drawnText.indexOf('State House District 1 border'),
  'a selected camera viewshed should sit right after the viewshed rows');
// the preview is a modal dialog and its download reuses the exact composed PNG
assert.equal(modal.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true');
assert.ok(modal.querySelector('[data-export-preview]'), 'modal should include preview image');
modal.querySelector('[data-export-download]').click();
assert.equal(downloads.length, 1, 'Download PNG in modal should trigger a download');
assert.match(downloads[0].download, /owdcic-state-house-district-1\.png/);
assert.match(downloads[0].href, /^data:image\/png/);
modal.querySelector('[data-export-close]').click();
assert.equal(body.querySelector('.results-export-modal'), null, 'close button should remove modal');

api.showCamera({ name: 'Camera One' }, null, {
  geometry: { type: 'Point', coordinates: [-120, 44] },
});
// camera exports use the point geometry as the crop focus
await exportButton._listeners.click[0]();
assert.deepEqual(projectedCoordinates.at(-1), [-120, 44], 'camera export should center on the camera point');
const modal2 = body.querySelector('.results-export-modal');
const escHandler = globalThis.document._docListeners.keydown.at(-1);
// escape key follows the same teardown path as the close button
escHandler({ key: 'Escape', preventDefault() {} });
assert.equal(body.querySelector('.results-export-modal'), null, 'Escape should close modal');

// record generated files so CSV and PDF contents can be read back
const blobs = [];
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  blobs.push(blob);
  return originalCreateObjectURL(blob);
};
const odfMembers = [
  { divisionId: 'odf:a', name: 'Alpha District', cameraViewshedCoveragePct: 40, cameraViewshedAreaSqKm: 40, landAreaSqKm: 100, landMix },
  // the comma checks CSV quoting
  { divisionId: 'odf:b', name: 'Beta FPA, North', cameraViewshedCoveragePct: 10, cameraViewshedAreaSqKm: 20, landAreaSqKm: 200,
    landMix: [{ label: 'State land', percentage: 100, areaSqKm: 200 }] },
  { divisionId: 'odf:c', name: 'Gamma District', cameraViewshedCoveragePct: 25, cameraViewshedAreaSqKm: 25, landAreaSqKm: 100, landMix },
  { divisionId: 'odf:d', name: 'Delta District', cameraViewshedCoveragePct: null, landMix: [] },
  { divisionId: 'odf:e', name: 'Epsilon District', cameraViewshedCoveragePct: 5, cameraViewshedAreaSqKm: 5, landAreaSqKm: 100, landMix },
];
odfMembers.forEach((properties) => memberFeatures.set(properties.divisionId, { properties }));
const allOdf = {
  divisionId: 'odf:all', name: 'All ODF districts', cameraViewshedCoveragePct: 18, cameraViewshedAreaSqKm: 90,
  landAreaSqKm: 500, landMix, memberDivisionIds: odfMembers.map(({ divisionId }) => divisionId),
};
// the fake DOM matches data attributes by name only, so pick chooser options by key here
const exportOption = (key) => body.querySelectorAll('[data-export-option]')
  .find((button) => button.dataset.exportOption === key);
const showAllOdf = () => api.showPolygon('odf-protection-district', {
  properties: allOdf,
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 40], [0, 40], [0, 0]]] },
});

// the "All" option of a report group asks what to export instead of opening the map preview
showAllOdf();
await exportButton._listeners.click[0]();
let chooser = body.querySelector('.results-export-chooser');
assert.ok(chooser, 'All ODF districts should open the export chooser');
assert.equal(body.querySelector('.results-export-modal'), null, 'the chooser should not open the map preview');
assert.deepEqual(chooser.querySelectorAll('[data-export-option]').map((button) => button.dataset.exportOption),
  ['report', 'csv', 'map']);
assert.equal(exportButton.disabled, true, 'export stays disabled while the chooser is open');

// the CSV downloads straight from the chooser, one row per district and a total row last
const downloadsBeforeCsv = downloads.length;
exportOption('csv').click();
assert.equal(downloads.length, downloadsBeforeCsv + 1, 'CSV option should download a file');
assert.equal(downloads.at(-1).download, 'owdcic-all-odf-districts-summary.csv');
assert.equal(textOf(chooser.querySelector('[data-export-status]')), 'CSV downloaded.');
const csvLines = (await blobs.at(-1).text()).split('\r\n');
const csvHeader = csvLines[0].split(',');
assert.deepEqual(csvHeader.slice(0, 6), ['District', 'Coverage (%)', 'Covered area (sq mi)', 'Total area (sq mi)',
  'Covered area (sq km)', 'Total area (sq km)']);
// land status columns keep the panel's category order
assert.deepEqual(csvHeader.slice(6), ['U.S. Forest Service land (%)', 'U.S. Forest Service land (sq mi)',
  'State land (%)', 'State land (sq mi)', 'Other/unclassified (%)', 'Other/unclassified (sq mi)']);
assert.equal(csvLines.length, odfMembers.length + 2, 'CSV should have a header, every district, and a total row');
assert.match(csvLines[1], /^Alpha District,40,15\.44,38\.61,40,100,40,0,10,0,50,0$/,
  'areas convert to sq mi; land shares without an area stay 0 sq mi');
assert.match(csvLines[2], /^"Beta FPA, North",10,/, 'names with commas should be quoted');
assert.match(csvLines[2], /,0,0,100,77\.22,0,0$/, 'categories missing from a district count as 0');
assert.match(csvLines[4], /^Delta District,,,,,,/, 'unavailable coverage should stay blank, not 0');
assert.match(csvLines.at(-1), /^All ODF districts,18,/);
chooser.querySelector('button.modal__close').click();
assert.equal(body.querySelector('.results-export-chooser'), null, 'close should remove the chooser');
assert.equal(exportButton.disabled, false, 'closing the chooser should re-enable export');

// the report opens a page-by-page preview: overview map, two tables, then four district cards per page
await exportButton._listeners.click[0]();
const canvasesBeforeReport = exportCanvases.length;
exportOption('report').click();
for (let tries = 0; tries < 50 && !body.querySelector('.results-export-modal'); tries += 1) {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}
const reportModal = body.querySelector('.results-export-modal');
assert.ok(reportModal, 'report option should open the report preview');
assert.equal(body.querySelector('.results-export-chooser'), null, 'the chooser should close when the report opens');
assert.equal(textOf(reportModal.querySelector('h2')), 'Summary report preview');
assert.equal(reportModal.querySelectorAll('[data-export-preview]').length, 5, '5 districts should make 5 pages');
assert.equal(reportModal.querySelector('[data-export-download]'), null, 'the report has no PNG download');
const reportPages = exportCanvases.slice(canvasesBeforeReport).filter((node) => node.drawnText?.length);
const reportText = reportPages.flatMap((node) => node.drawnText);
const pageWith = (heading) => reportPages.find((node) => node.drawnText.includes(heading)).drawnText;
const districtOrder = (text) => odfMembers.map(({ name }) => name).filter((name) => text.includes(name))
  .sort((a, b) => text.indexOf(a) - text.indexOf(b));
assert.ok(reportText.includes('All ODF districts: camera coverage summary'), 'pages should carry the report title');
// page 2 keeps list order, page 3 goes from most to least covered with unavailable coverage last
assert.deepEqual(districtOrder(pageWith('Coverage by district')),
  ['Alpha District', 'Beta FPA, North', 'Gamma District', 'Delta District', 'Epsilon District']);
assert.deepEqual(districtOrder(pageWith('Districts from most to least covered')),
  ['Alpha District', 'Gamma District', 'Beta FPA, North', 'Epsilon District', 'Delta District']);
assert.ok(pageWith('Districts from most to least covered').includes('All districts'), 'the ranked table should keep its total row');
assert.ok(!reportText.some((text) => /rank/i.test(text)), 'district cards should not show a coverage rank');
assert.ok(reportText.includes('Page 5 of 5'));

// the PDF holds one page per preview image
reportModal.querySelector('[data-export-pdf-download]').click();
for (let tries = 0; tries < 50 && downloads.at(-1).download !== 'owdcic-all-odf-districts-summary-report.pdf'; tries += 1) {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}
assert.equal(downloads.at(-1).download, 'owdcic-all-odf-districts-summary-report.pdf');
const pdfText = Buffer.from(await blobs.at(-1).arrayBuffer()).toString('latin1');
assert.equal(blobs.at(-1).type, 'application/pdf');
assert.match(pdfText, /\/Kids \[3 0 R 6 0 R 9 0 R 12 0 R 15 0 R\] \/Count 5/);
assert.equal(pdfText.match(/\/Type \/Page \/Parent/g).length, 5);
reportModal.querySelector('[data-export-close]').click();

// the map report option is the existing single-page export
await exportButton._listeners.click[0]();
exportOption('map').click();
for (let tries = 0; tries < 50 && !body.querySelector('.results-export-modal'); tries += 1) {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}
const mapModal = body.querySelector('.results-export-modal');
assert.ok(mapModal?.querySelector('[data-export-download]'), 'map report should keep its PNG download');
assert.equal(mapModal.querySelectorAll('[data-export-preview]').length, 1);
mapModal.querySelector('[data-export-close]').click();

// groups left out of SUMMARY_REPORT_GROUPS keep the map export for their "All" option
api.showPolygon('national-forest', { properties: { ...allOdf, name: 'All National Forests' } });
await exportButton._listeners.click[0]();
assert.equal(body.querySelector('.results-export-chooser'), null, 'other groups should not get the chooser');
assert.ok(body.querySelector('.results-export-modal'), 'other groups should open the map preview');
body.querySelector('[data-export-close]').click();

// without a touch share sheet the button copies the current address, hash included
const shareButton = panel.querySelector('[data-results-share]');
assert.equal(shareButton.textContent, 'Copy link');
assert.equal(shareButton.disabled, false, 'a result should enable sharing');
await shareButton._listeners.click[0]();
assert.deepEqual(copiedLinks, ['https://example.test/?coverage=county&selection=or-lane'], 'share should copy the anchor link');
// the button confirms the copy in place, then takes its label back
assert.equal(shareButton.textContent, 'Link copied!');
shareLabelTimers.at(-1)();
assert.equal(shareButton.textContent, 'Copy link');

api.showError('Coverage statistics could not be loaded.');
assert.equal(shareButton.disabled, true);
// error state clears export eligibility and leaves the failure message visible
assert.match(textOf(panel.querySelector('[data-results-content]')), /could not be loaded/);
assert.equal(panel.querySelector('[data-results-export]').disabled, true);

console.log('results panel DOM contract passed');
