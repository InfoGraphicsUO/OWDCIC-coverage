import { featurePoint } from './geojson-transform.js';
import { createLegendSymbol } from './legend.js';

const INTEGER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ACRES_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// one visible popup per map without retaining discarded map instances
const ACTIVE_POPUPS = new WeakMap();
// screen-pixel spacing used after projecting the feature onto the map container
const POPUP_MARGIN = 12;
const POPUP_MARKER_GAP = 14;

// unique ids connect each dialog to its generated title
let popupTitleId = 0;

export function showCameraPopup(map, event) {
  const feature = event.features?.[0];
  if (!feature) return;

  const active = ACTIVE_POPUPS.get(map);
  const key = featureKey(feature);

  // upgrading the hover preview in place avoids a close and reopen flash
  if (key != null && active?.isPreview && active.featureKey === key) {
    active.promote(createCameraPopup(feature.properties || {}));
    return;
  }

  showPopup(map, event, createCameraPopup);
}

export function showDigitizedCameraPopup(map, event, symbol) {
  showPopup(map, event, createDigitizedCameraPopup, { symbol });
}

/** lightweight hover popup carrying only the camera name and locality */
export function showCameraPreview(map, event, symbol) {
  const feature = event.features?.[0];
  if (!feature) return;

  const active = ACTIVE_POPUPS.get(map);

  // a clicked popup outranks previews so hovering cannot discard it
  if (active && !active.isPreview) return;

  const key = featureKey(feature);
  if (active?.isPreview && active.featureKey === key) return;

  showPopup(map, event, createCameraPreview, { preview: true, featureKey: key, symbol });
}

export function hideCameraPreview(map) {
  const active = ACTIVE_POPUPS.get(map);
  if (active?.isPreview) active.close();
}

export function showFirePopup(map, event, symbol) {
  showPopup(map, event, createFirePopup, { symbol });
}

export function showPrescribedPopup(map, event, symbol) {
  showPopup(map, event, createPrescribedPopup, { symbol });
}

export function showLookoutPopup(map, event, symbol) {
  showPopup(map, event, createLookoutPopup, { symbol });
}

export function showTransmissionLinePopup(map, event, symbol) {
  showPopup(map, event, createTransmissionLinePopup, { symbol });
}

export function showDivisionPopup(map, properties) {
  const coordinates = properties?.labelPoint;
  if (!validCoordinates(coordinates)) return;

  showPopupAt(
    map,
    coordinates,
    createDivisionPopup(properties),
    { closeOnMapClick: false, kind: 'division' }
  );
}

export function hideDivisionPopup(map) {
  const active = ACTIVE_POPUPS.get(map);
  if (active?.kind === 'division') active.close({ immediate: true });
}

function showPopup(map, event, createContent, options = {}) {
  const feature = event.features?.[0];
  if (!feature) return;

  // polygon clicks fall back to the exact click when no point is available
  const coordinates = featurePoint(feature) || event.lngLat;
  if (!coordinates) return;

  // symbol is the layer's legend symbol, drawn beside the popup title
  const { symbol, ...popupOptions } = options;
  showPopupAt(map, coordinates, createContent(feature.properties || {}, symbol), popupOptions);
}

function showPopupAt(map, coordinates, content, options = {}) {
  // replacing in place prevents overlapping dialogs and stale listeners
  ACTIVE_POPUPS.get(map)?.close({ immediate: true });

  const popup = new FeaturePopup(map, coordinates, content, options);
  ACTIVE_POPUPS.set(map, popup);
  popup.open();
}

function validCoordinates(coordinates) {
  return (
    Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    coordinates.every(Number.isFinite)
  );
}

// identifies a hovered feature so its preview can be matched on click
function featureKey(feature) {
  return feature.properties?.id ?? feature.id ?? null;
}

/** owns a popup DOM element along with its map listeners and screen position */
class FeaturePopup {
  constructor(
    map,
    coordinates,
    content,
    {
      closeOnMapClick = true,
      featureKey = null,
      kind = 'feature',
      preview = false,
    } = {}
  ) {
    this.map = map;
    this.coordinates = coordinates;
    this.closeOnMapClick = closeOnMapClick;
    this.isPreview = preview;
    this.featureKey = featureKey;
    this.kind = kind;
    this.element = createPopupElement(content, { preview });
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

    // previews are dismissed by leaving the feature rather than by the user
    if (!this.isPreview) this.enableDismissal();

    this.updatePosition();

    // start the transition after the browser has laid out the hidden popup
    requestAnimationFrame(() => {
      this.element.classList.add('is-open');
    });
  }

  /** swaps preview content for the full dialog without reopening it */
  promote(content) {
    if (!this.isPreview) return;

    this.isPreview = false;
    this.element.classList.remove('feature-popup--preview');
    this.element.replaceChildren(createCloseButton(), content);
    labelPopup(this.element, content);
    this.enableDismissal();
    this.schedulePositionUpdate();
  }

  enableDismissal() {
    this.element
      .querySelector('.feature-popup__close')
      .addEventListener('click', this.handleCloseClick);

    if (!this.closeOnMapClick) return;

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
    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;

    if (!width || !height) return;

    // hiding offscreen content avoids a dialog stranded at the nearest edge
    const isOffscreen =
      point.x < 0 ||
      point.y < 0 ||
      point.x > container.clientWidth ||
      point.y > container.clientHeight;
    this.element.classList.toggle('is-offscreen', isOffscreen);

    const left = clamp(
      point.x - width / 2,
      POPUP_MARGIN,
      container.clientWidth - width - POPUP_MARGIN
    );

    // prefer above the marker unless the lower side has more usable room
    const spaceAbove = point.y - POPUP_MARKER_GAP;
    const spaceBelow = container.clientHeight - point.y - POPUP_MARKER_GAP;
    const placeBelow =
      spaceAbove < height + POPUP_MARGIN && spaceBelow > spaceAbove;

    const preferredTop = placeBelow
      ? point.y + POPUP_MARKER_GAP
      : point.y - height - POPUP_MARKER_GAP;
    const top = clamp(
      preferredTop,
      POPUP_MARGIN,
      container.clientHeight - height - POPUP_MARGIN
    );

    // keep the pointer and animation origin inside popup rounded corners
    const originX = clamp(point.x - left, 18, width - 18);

    this.element.classList.toggle('feature-popup--below', placeBelow);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.setProperty('--popup-origin-x', `${originX}px`);
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

function createPopupElement(content, { preview = false } = {}) {
  const popup = document.createElement('section');
  popup.className = preview ? 'feature-popup feature-popup--preview' : 'feature-popup';
  popup.setAttribute('role', 'dialog');
  labelPopup(popup, content);

  // a preview closes on mouseleave, so a close button would be unreachable
  if (preview) {
    popup.append(content);
    return popup;
  }

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

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

// hover preview stays limited to what identifies the camera at a glance
function createCameraPreview({ name, state, county }, symbol) {
  const popup = createPopupContainer(name || 'Camera', symbol);

  const location = cameraLocation({ county, state });
  if (location) popup.append(createMetaLine(location));

  return popup;
}

function createCameraPopup({ name, id, pan, image, state, county }) {
  const popup = createPopupContainer(name || 'Camera');

  const location = cameraLocation({ county, state });
  if (location) popup.append(createMetaLine(location));

  const numericPan = Number(pan);
  const formattedPan = Number.isFinite(numericPan) ? `${numericPan}\u00b0` : '\u2014';
  popup.append(createMetaLine(`Pan: ${formattedPan}`));

  const imageUrl = getHttpsUrl(image);
  if (imageUrl) {
    const thumbnail = document.createElement('img');
    thumbnail.className = 'cam-thumb';
    thumbnail.src = imageUrl;
    thumbnail.alt = name || 'Camera';
    thumbnail.width = 240;
    thumbnail.height = 135;
    thumbnail.loading = 'lazy';
    thumbnail.decoding = 'async';
    thumbnail.addEventListener('error', () => thumbnail.remove(), { once: true });
    popup.append(thumbnail);
  }

  if (id) {
    appendExternalLink(
      popup,
      `https://alertwest.live/cam-console/${encodeURIComponent(id)}`,
      'Open camera feed'
    );
  }

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

function createPrescribedPopup(properties, symbol) {
  const popup = createPopupContainer(properties.name || 'Prescribed fire', symbol);

  const acres = formatNumber(properties.acreage, ACRES_FORMAT);
  if (acres != null) popup.append(createMetaLine(`${acres} target acres`));

  const startDate = formatArcGISDate(properties.prescribed_date_start);
  if (startDate) popup.append(createMetaLine(`Scheduled: ${startDate}`));

  const watchDutyUrl = getHttpsUrl(properties.watchduty_url);
  if (watchDutyUrl) appendExternalLink(popup, watchDutyUrl, 'Open in Watch Duty');

  return popup;
}

function createDivisionPopup({ name, stateName, cameraViewshedCoveragePct }) {
  const popup = createPopupContainer(name || 'County');
  if (stateName) popup.append(createMetaLine(stateName));

  const coverage = formatNumber(cameraViewshedCoveragePct, PERCENT_FORMAT);
  if (coverage != null) {
    popup.append(createMetaLine(`Camera viewshed coverage: ${coverage}%`));
  }
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
