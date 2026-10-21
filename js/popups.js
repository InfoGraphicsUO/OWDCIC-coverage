import { featurePoint } from './geojson-transform.js';
import { createLegendSymbol } from './legend.js';

const INTEGER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ACRES_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// one visible popup per map without retaining discarded map instances
const ACTIVE_POPUPS = new WeakMap();

// one cursor-following tooltip element per map, reused between hovers
const HOVER_TOOLTIPS = new WeakMap();

// screen-pixel spacing used after projecting the feature onto the map container
const POPUP_MARGIN = 12;
const POPUP_MARKER_GAP = 14;

// the cursor arrow hangs below its hotspot, so a tooltip below it needs more room
const TOOLTIP_GAP_ABOVE = 14;
const TOOLTIP_GAP_BELOW = 26;

// crossing the small gaps between neighbouring lines and markers should not blink the tooltip
const TOOLTIP_HIDE_DELAY_MS = 120;

// unique ids connect each dialog to its generated title
let popupTitleId = 0;

// content builders by the feature kinds map-layers.js binds
const POPUP_CONTENT = Object.freeze({
  camera: createCameraPreview,
  digitizedCamera: createDigitizedCameraPopup,
  fire: createFirePopup,
  fireHistory: createFireHistoryPopup,
  label: createLabelPopup,
  lookout: createLookoutPopup,
  prescribed: createPrescribedPopup,
  transmissionLine: createTransmissionLinePopup,
});

/** box pinned to the clicked or tapped feature, closed with its button, Escape or a map click */
export function showFeaturePopup(map, event, kind, symbol) {
  const feature = event.features?.[0];
  if (!feature) return;

  // polygon clicks fall back to the exact click when no point is available
  const coordinates = featurePoint(feature) || event.lngLat;
  if (!coordinates) return;

  // symbol is the layer's legend symbol, drawn beside the popup title
  const content = POPUP_CONTENT[kind](feature.properties || {}, symbol);

  // replacing in place prevents overlapping dialogs and stale listeners
  ACTIVE_POPUPS.get(map)?.close({ immediate: true });
  hideHoverTooltip(map);

  const popup = new FeaturePopup(map, coordinates, content, { featureKey: hoverKey(feature) });
  ACTIVE_POPUPS.set(map, popup);
  popup.open();
}

/**
 * tooltip beside the cursor carrying the same details as the clicked box
 * each entry is `{ feature, kind, symbol, title }`, and several stack in one tooltip
 */
export function showHoverTooltip(map, point, entries) {
  const key = entries
    .map(({ feature, title }) => `${hoverKey(feature)}:${title ?? ''}`)
    .join('|');

  // the pinned box already shows this feature beside the cursor
  if (entries.length === 1 && ACTIVE_POPUPS.get(map)?.featureKey === hoverKey(entries[0].feature)) {
    hideHoverTooltip(map);
    return;
  }

  let tooltip = HOVER_TOOLTIPS.get(map);
  if (!tooltip) {
    tooltip = new HoverTooltip(map);
    HOVER_TOOLTIPS.set(map, tooltip);
  }

  tooltip.show(point, key, () =>
    entries.map(({ feature, kind, symbol, title }) =>
      POPUP_CONTENT[kind](feature.properties || {}, symbol, { hover: true, title })
    )
  );
}

export function hideHoverTooltip(map) {
  HOVER_TOOLTIPS.get(map)?.hide();
}

// features without ids still differ by their properties, which stay small here
function hoverKey(feature) {
  return `${feature.layer?.id}:${JSON.stringify(feature.properties ?? {})}`;
}

/** reuses one element so moving between features only swaps its content */
class HoverTooltip {
  constructor(map) {
    this.map = map;
    this.key = null;
    this.hideTimer = null;
    this.element = document.createElement('div');
    this.element.className = 'feature-popup feature-popup--hover';

    // it repeats what the pointer is over, with no way to reach it by keyboard
    this.element.setAttribute('aria-hidden', 'true');
    map.getContainer().append(this.element);
  }

  show(point, key, createContent) {
    window.clearTimeout(this.hideTimer);

    if (key !== this.key) {
      this.key = key;
      this.element.replaceChildren(...createContent());
    }

    placeBeside(this.element, this.map.getContainer(), point, {
      gapAbove: TOOLTIP_GAP_ABOVE,
      gapBelow: TOOLTIP_GAP_BELOW,
    });

    // fade in once on entry; moving the cursor only changes left and top
    this.element.classList.add('is-open');
  }

  hide() {
    if (!this.element.classList.contains('is-open')) return;

    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.key = null;
      this.element.classList.remove('is-open');
    }, TOOLTIP_HIDE_DELAY_MS);
  }
}

/** owns a popup DOM element along with its map listeners and screen position */
class FeaturePopup {
  constructor(map, coordinates, content, { featureKey = null } = {}) {
    this.map = map;
    this.coordinates = coordinates;
    this.featureKey = featureKey;
    this.element = createPopupElement(content);
    this.animationFrame = null;
    this.mapClickTimer = null;
    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(this.schedulePositionUpdate)
        : null;
  }

  open() {
    this.map.getContainer().append(this.element);
    this.resizeObserver?.observe(this.element);
    this.map.on('move', this.schedulePositionUpdate);
    this.map.on('resize', this.schedulePositionUpdate);
    document.addEventListener('keydown', this.handleKeyDown);

    this.enableDismissal();

    this.updatePosition();

    // start the transition after the browser has laid out the hidden popup
    requestAnimationFrame(() => {
      this.element.classList.add('is-open');
    });
  }

  enableDismissal() {
    this.element
      .querySelector('.feature-popup__close')
      .addEventListener('click', this.handleCloseClick);

    // wait for the feature click to finish before map clicks can dismiss it
    this.mapClickTimer = window.setTimeout(() => {
      this.map
        .getCanvasContainer()
        .addEventListener('click', this.handleMapClick, { capture: true });
    }, 0);
  }

  close({ immediate = false } = {}) {
    // stop every source that can reposition or dismiss the popup
    window.clearTimeout(this.mapClickTimer);
    this.map
      .getCanvasContainer()
      .removeEventListener('click', this.handleMapClick, { capture: true });
    this.map.off('move', this.schedulePositionUpdate);
    this.map.off('resize', this.schedulePositionUpdate);
    document.removeEventListener('keydown', this.handleKeyDown);
    this.resizeObserver?.disconnect();

    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
    if (ACTIVE_POPUPS.get(this.map) === this) ACTIVE_POPUPS.delete(this.map);

    this.element.classList.remove('is-open');

    // immediate removal keeps a replacement popup from overlapping this one
    if (immediate) {
      this.element.remove();
      return;
    }

    this.element.classList.add('is-closing');
    this.element.addEventListener('transitionend', () => this.element.remove(), {
      once: true,
    });

    // transitionend does not fire when CSS transitions are disabled
    window.setTimeout(() => this.element.remove(), 250);
  }

  schedulePositionUpdate = () => {
    if (this.animationFrame != null) return;

    // map movement can emit faster than the browser can paint
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      this.updatePosition();
    });
  };

  updatePosition() {
    // all measurements stay in map-container pixels
    const container = this.map.getContainer();
    const point = this.map.project(this.coordinates);

    // hiding offscreen content avoids a dialog stranded at the nearest edge
    const isOffscreen =
      point.x < 0 ||
      point.y < 0 ||
      point.x > container.clientWidth ||
      point.y > container.clientHeight;
    this.element.classList.toggle('is-offscreen', isOffscreen);

    placeBeside(this.element, container, point, {
      gapAbove: POPUP_MARKER_GAP,
      gapBelow: POPUP_MARKER_GAP,
    });
  }

  handleMapClick = () => {
    this.close();
  };

  handleCloseClick = () => {
    this.close();
  };

  handleKeyDown = (event) => {
    if (event.key === 'Escape') this.close();
  };
}

function createPopupElement(content) {
  const popup = document.createElement('section');
  popup.className = 'feature-popup';
  popup.setAttribute('role', 'dialog');
  labelPopup(popup, content);
  popup.append(createCloseButton(), content);
  return popup;
}

function createCloseButton() {
  const closeButton = document.createElement('button');
  closeButton.className = 'feature-popup__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close popup');
  closeButton.textContent = '\u00d7';
  return closeButton;
}

// generated title becomes the accessible dialog label
function labelPopup(popup, content) {
  const title = content.querySelector('strong');
  if (!title) return;

  popupTitleId += 1;
  title.id = `feature-popup-title-${popupTitleId}`;
  popup.setAttribute('aria-labelledby', title.id);
}

/** places a popup above a container point, or below it when the lower side has more room */
function placeBeside(element, container, point, { gapAbove, gapBelow }) {
  const width = element.offsetWidth;
  const height = element.offsetHeight;

  if (!width || !height) return;

  const left = clamp(
    point.x - width / 2,
    POPUP_MARGIN,
    container.clientWidth - width - POPUP_MARGIN
  );

  const spaceAbove = point.y - gapAbove;
  const spaceBelow = container.clientHeight - point.y - gapBelow;
  const placeBelow =
    spaceAbove < height + POPUP_MARGIN && spaceBelow > spaceAbove;

  const preferredTop = placeBelow
    ? point.y + gapBelow
    : point.y - height - gapAbove;
  const top = clamp(
    preferredTop,
    POPUP_MARGIN,
    container.clientHeight - height - POPUP_MARGIN
  );

  // keep the animation origin inside popup rounded corners
  const originX = clamp(point.x - left, 18, width - 18);

  element.classList.toggle('feature-popup--below', placeBelow);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.setProperty('--popup-origin-x', `${originX}px`);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

// cameras open the results panel on click, so hover only identifies the camera
function createCameraPreview({ name, state, county, owner }, symbol) {
  const popup = createPopupContainer(name || 'Camera', symbol);

  const location = cameraLocation({ county, state });
  if (location) popup.append(createMetaLine(location));
  if (owner) popup.append(createMetaLine(`Owner: ${owner}`));

  return popup;
}

function createDigitizedCameraPopup({
  name,
  operator,
  status,
  pointSourceName,
  siteType,
  cameraHeightFeet,
}, symbol) {
  const popup = createPopupContainer(name || 'Digitized camera', symbol);

  const operatorStatus = [operator, status].filter(Boolean).join(' · ');
  if (operatorStatus) popup.append(createMetaLine(operatorStatus));

  if (pointSourceName && pointSourceName !== name) {
    popup.append(createMetaLine(`Location source: ${pointSourceName}`));
  }

  const siteDetails = [siteType, cameraHeightFeet && `${cameraHeightFeet} ft`]
    .filter(Boolean)
    .join(' · ');
  if (siteDetails) popup.append(createMetaLine(siteDetails));

  return popup;
}

function cameraLocation({ county, state }) {
  return [county, state].filter(Boolean).join(', ');
}

function createFirePopup(properties, symbol) {
  // point and perimeter services expose the same fields under different names
  const title =
    properties.IncidentName ||
    properties.poly_IncidentName ||
    properties.attr_IncidentName ||
    'Fire';
  const popup = createPopupContainer(title, symbol);

  const acres = formatNumber(
    properties.acres ?? properties.IncidentSize ?? properties.poly_GISAcres,
    ACRES_FORMAT
  );

  if (acres != null) popup.append(createMetaLine(`${acres} acres`));

  const contained = formatNumber(
    properties.PercentContained ?? properties.attr_PercentContained,
    INTEGER_FORMAT
  );

  if (contained != null) popup.append(createMetaLine(`${contained}% contained`));

  const location = [
    properties.POOCounty || properties.attr_POOCounty,
    formatState(properties.POOState || properties.attr_POOState),
  ]
    .filter(Boolean)
    .join(', ');
  if (location) popup.append(createMetaLine(location));

  return popup;
}

// layers like viewsheds only need naming, with the name chosen by the caller
function createLabelPopup(properties, symbol, { title }) {
  return createPopupContainer(title, symbol);
}

function createFireHistoryPopup(properties, symbol) {
  const popup = createPopupContainer(properties.name || 'Unnamed fire', symbol);

  // ignitions carry a discovery date, perimeters only their year
  const date = properties.date ? DATE_FORMAT.format(new Date(`${properties.date}T12:00:00`)) : null;
  if (date) popup.append(createMetaLine(`Discovered ${date}`));
  else if (properties.year) popup.append(createMetaLine(`Burned in ${properties.year}`));

  const acres = formatNumber(properties.acres, ACRES_FORMAT);
  if (acres != null) popup.append(createMetaLine(`${acres} acres`));

  if (properties.cause) popup.append(createMetaLine(`Cause: ${properties.cause}`));

  return popup;
}

function createLookoutPopup(properties, symbol) {
  const popup = createPopupContainer(properties.name || 'Lookout', symbol);

  const location = [properties.County, properties.State].filter(Boolean).join(', ');
  if (location) popup.append(createMetaLine(location));

  const details = [properties.Type, properties.Status].filter(Boolean).join(' · ');
  if (details) popup.append(createMetaLine(details));

  const nhlr = properties['NHLR/FFLOS'];
  if (nhlr) popup.append(createMetaLine(nhlr));

  return popup;
}

function createTransmissionLinePopup(properties, symbol) {
  const popup = createPopupContainer('Transmission line', symbol);

  const owner = availableText(properties.OWNER);
  if (owner) popup.append(createMetaLine(`Owner: ${owner}`));

  // the source marks an unknown voltage with a negative placeholder
  const voltage = Number(properties.VOLTAGE) > 0
    ? `${formatNumber(properties.VOLTAGE, ACRES_FORMAT)} kV`
    : null;
  // TYPE reads like "AC; OVERHEAD"
  const type = availableText(properties.TYPE)?.replace(/;\s*/g, ', ').toLowerCase()
    .replace(/\b[ad]c\b/, (current) => current.toUpperCase());
  const details = [voltage, type].filter(Boolean).join(' · ');
  if (details) popup.append(createMetaLine(details));

  // unnamed ends carry generated ids like TAP123456 or UNKNOWN123456
  const substations = [properties.SUB_1, properties.SUB_2]
    .map(availableText)
    .filter((name) => name && !/^(TAP|UNKNOWN)\d+$/.test(name));
  if (substations.length) {
    const label = substations.length > 1 ? 'Substations' : 'Substation';
    popup.append(createMetaLine(`${label}: ${substations.join(' to ')}`));
  }

  const status = availableText(properties.STATUS);
  if (status) popup.append(createMetaLine(`Status: ${status.toLowerCase()}`));

  return popup;
}

// the transmission line source writes NOT AVAILABLE where a value is unknown
function availableText(value) {
  const text = value == null ? '' : String(value).trim();
  return text && text.toUpperCase() !== 'NOT AVAILABLE' ? text : null;
}

function createPrescribedPopup(properties, symbol, { hover = false } = {}) {
  const popup = createPopupContainer(properties.name || 'Prescribed fire', symbol);

  const acres = formatNumber(properties.acreage, ACRES_FORMAT);
  if (acres != null) popup.append(createMetaLine(`${acres} target acres`));

  const startDate = formatArcGISDate(properties.prescribed_date_start);
  if (startDate) popup.append(createMetaLine(`Scheduled: ${startDate}`));

  // a link cannot be reached in a tooltip that moves with the cursor
  const watchDutyUrl = getHttpsUrl(properties.watchduty_url);
  if (watchDutyUrl && hover) popup.append(createMetaLine('Click for the Watch Duty link'));
  else if (watchDutyUrl) appendExternalLink(popup, watchDutyUrl, 'Open in Watch Duty');

  return popup;
}

function createPopupContainer(titleText, symbol) {
  const popup = document.createElement('div');
  popup.className = 'cam-popup';

  const heading = document.createElement('div');
  heading.className = 'cam-title';

  // the title already names the feature, so its layer symbol stays decorative
  if (symbol) heading.append(createLegendSymbol(symbol));

  const title = document.createElement('strong');
  title.textContent = titleText;
  heading.append(title);
  popup.append(heading);
  return popup;
}

function createMetaLine(text) {
  const line = document.createElement('div');
  line.className = 'cam-meta';
  line.textContent = text;
  return line;
}

function appendExternalLink(container, href, text) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  container.append(link);
}

function getHttpsUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);

    // external links and thumbnails must not introduce mixed-content requests
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatNumber(value, formatter) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? formatter.format(numeric) : null;
}

function formatState(value) {
  return value ? String(value).replace(/^US-/, '') : null;
}

function formatArcGISDate(value) {
  if (value == null || value === '') return null;

  // ArcGIS dates arrive as epoch milliseconds or parseable date strings
  const date = new Date(typeof value === 'number' ? value : Date.parse(value));
  return Number.isNaN(date.getTime()) ? null : DATE_FORMAT.format(date);
}
