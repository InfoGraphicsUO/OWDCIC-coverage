import { hideHoverTooltip, showHoverTooltip } from './popups.js';

// layers registered for hover info on each map, keyed by layer id
const HOVER_LAYERS = new WeakMap();

// mouse and pen can hover; touch can only tap, so taps open the clicked box instead
// start from the device's primary pointer until the first pointer event arrives
let lastPointerType = window.matchMedia?.('(hover: hover)').matches ? 'mouse' : 'touch';

export function pointerCanHover() {
  return lastPointerType !== 'touch';
}

/**
 * show a feature's info beside the cursor while the pointer is over it
 * `symbol` and `title` are values, or functions reading them from the hovered feature
 * `background` layers cover wide areas, so they show only when nothing else is under the cursor
 */
export function addHoverLayer(map, layerId, { kind, symbol, title, background = false }) {
  let layers = HOVER_LAYERS.get(map);
  if (!layers) {
    layers = new Map();
    HOVER_LAYERS.set(map, layers);
    bindHoverInfo(map, layers);
  }

  layers.set(layerId, { kind, symbol, title, background });
}

// one map-wide handler lets the topmost of overlapping features own the tooltip
function bindHoverInfo(map, layers) {
  const canvasContainer = map.getCanvasContainer();

  // pointer events say which input moved, unlike the mouse events Mapbox emits
  const trackPointer = (event) => {
    lastPointerType = event.pointerType;
  };
  canvasContainer.addEventListener('pointerdown', trackPointer, { capture: true });
  canvasContainer.addEventListener('pointermove', trackPointer, { capture: true });

  map.on('mousemove', (event) => {
    const entries = hoveredEntries(map, layers, event);
    if (!entries.length) {
      hideHoverTooltip(map);
      return;
    }

    showHoverTooltip(map, event.point, entries);
  });

  // the cursor can leave, or the map can slide under it, without another mousemove
  canvasContainer.addEventListener('mouseleave', () => hideHoverTooltip(map));
  map.on('movestart', () => hideHoverTooltip(map));
}

function hoveredEntries(map, layers, event) {
  if (!pointerCanHover() || map.isMoving()) return [];

  // popups and controls sit over the map but are not part of it
  if (!map.getCanvasContainer().contains(event.originalEvent?.target)) return [];

  // optional layers may not exist yet during startup
  const layerIds = [...layers.keys()].filter((layerId) => map.getLayer(layerId));
  if (!layerIds.length) return [];

  // rendered features come back topmost first, so markers win over the lines beneath them
  const features = map.queryRenderedFeatures(event.point, { layers: layerIds });
  const foreground = features.find(({ layer }) => !layers.get(layer.id).background);
  if (foreground) return [describe(layers, foreground)];

  // overlapping background layers stack in the order they were added, once per title
  const entries = [];
  for (const layerId of layerIds) {
    const feature = features.find(({ layer }) => layer.id === layerId);
    const entry = feature && describe(layers, feature);
    if (entry && !entries.some(({ title }) => title && title === entry.title)) entries.push(entry);
  }
  return entries;
}

function describe(layers, feature) {
  const { kind, symbol, title } = layers.get(feature.layer.id);
  return {
    feature,
    kind,
    symbol: typeof symbol === 'function' ? symbol(feature) : symbol,
    title: typeof title === 'function' ? title(feature) : title,
  };
}
