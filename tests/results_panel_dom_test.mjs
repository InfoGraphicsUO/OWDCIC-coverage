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
// start with legacy-style markup so initResultsPanel must add its footer wrapper
const panel = el('aside', { id: 'results-panel' });
panel.append(
  el('h2', { 'data-results-title': '' }),
  el('button', { 'data-results-export': '', type: 'button' }),
  el('div', { 'data-results-content': '' }),
  el('p', { 'data-results-status': '' }),
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
globalThis.URL = URL;
globalThis.requestAnimationFrame = (fn) => queueMicrotask(fn);

const downloads = [];
const originalClick = FakeNode.prototype.click;
FakeNode.prototype.click = function click() {
  // capture anchor downloads while keeping normal click handlers active
  if (this.tagName === 'A' && this.download) downloads.push({ href: this.href, download: this.download });
  originalClick.call(this);
};

const { initResultsPanel } = await import('../js/results-panel.js');

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
const api = initResultsPanel({
  getMap: () => ({
    project: (coordinates) => {
      // record the requested export center and keep its screen point stable
      projectedCoordinates.push(coordinates);
      return { x: 220, y: 120 };
    },
  }),
  getMapCanvas: () => canvas,
  getLegendItems: () => ['Cameras (ALERTWest)', 'Camera viewsheds'],
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
assert.match(textOf(content), /5\.1% covered by fire-spotting cameras/);
assert.match(textOf(content), /sq mi of State House District 1 is covered by fire-spotting cameras, out of total/);
assert.doesNotMatch(textOf(content), /CAMERA COVERAGE|Covered area|Selected area/i);
assert.ok(content.querySelector('[data-results-chart]'), 'house should get a donut host');
assert.match(textOf(content), /40% of area is U\.S\. Forest Service land/);
assert.match(textOf(content), /10% of area is State land/);
assert.match(textOf(content), /Unclassified includes unmapped private land/);

content = show('showPolygon', 'us-house', { properties: { name: 'Congressional District 1', cameraViewshedCoveragePct: 7.2, landMix } });
assert.ok(content.querySelector('[data-results-chart]'), 'US House should get a donut host');

content = show('showPolygon', 'senate', { properties: { name: 'State Senate District 1', cameraViewshedCoveragePct: 6.4, landMix } });
assert.ok(content.querySelector('[data-results-chart]'), 'senate should get a donut host');

content = show('showPolygon', 'state', { properties: { name: 'Oregon', cameraViewshedCoveragePct: 8.93, cameraViewshedAreaSqKm: 22121, landAreaSqKm: 247715, landMix } });
assert.match(textOf(content), /8\.9% covered by fire-spotting cameras/);
assert.equal(content.querySelector('[data-results-chart]'), null, 'state must not get a donut');

content = show('showPolygon', 'county', { properties: { name: 'Baker County', cameraViewshedCoveragePct: 2.85, landMix } });
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
assert.match(textOf(content), /Located in Multnomah, OR/);
assert.match(textOf(content), /Pan 42°/);

content = show('showCamera', { name: 'Missing metrics cam', id: 99 }, null);
assert.match(textOf(content), /Coverage unavailable/);
assert.doesNotMatch(textOf(content), /\b0%/);

content = show('showCamera', { name: 'Covered cam', id: 1 }, { coverageAvailable: true, landAreaSqKm: 12.5, landMix });
assert.ok(content.querySelector('[data-results-chart]'), 'camera viewsheds should get a donut when metrics exist');
assert.match(textOf(content), /40% of area is U\.S\. Forest Service land/);

const exportButton = panel.querySelector('[data-results-export]');
// legacy markup is upgraded without losing the export control
assert.match(exportButton.textContent, /Export as/);
assert.ok(panel.querySelector('[data-results-footer]'), 'export control should live in footer');

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

api.showError('Coverage statistics could not be loaded.');
// error state clears export eligibility and leaves the failure message visible
assert.match(textOf(panel.querySelector('[data-results-content]')), /could not be loaded/);
assert.equal(panel.querySelector('[data-results-export]').disabled, true);

console.log('results panel DOM contract passed');
