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
 * `symbol` is the legend symbol, or a function picking it from the hovered feature
 */
export function addHoverLayer(map, layerId, kind, symbol) {
  let layers = HOVER_LAYERS.get(map);
  if (!layers) {
    layers = new Map();
    HOVER_LAYERS.set(map, layers);
    bindHoverInfo(map, layers);
  }

  layers.set(layerId, { kind, symbol });
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
    const feature = hoveredFeature(map, layers, event);
    if (!feature) {
      hideHoverTooltip(map);
      return;
    }

    const { kind, symbol } = layers.get(feature.layer.id);
    const layerSymbol = typeof symbol === 'function' ? symbol(feature) : symbol;
    showHoverTooltip(map, event.point, feature, kind, layerSymbol);
  });

  // the cursor can leave, or the map can slide under it, without another mousemove
  canvasContainer.addEventListener('mouseleave', () => hideHoverTooltip(map));
  map.on('movestart', () => hideHoverTooltip(map));
}

function hoveredFeature(map, layers, event) {
  if (!pointerCanHover() || map.isMoving()) return null;

  // popups and controls sit over the map but are not part of it
  if (!map.getCanvasContainer().contains(event.originalEvent?.target)) return null;

  // optional layers may not exist yet during startup
  const layerIds = [...layers.keys()].filter((layerId) => map.getLayer(layerId));
  if (!layerIds.length) return null;

  // rendered features come back topmost first, so markers win over the lines beneath them
  return map.queryRenderedFeatures(event.point, { layers: layerIds })[0] ?? null;
}
