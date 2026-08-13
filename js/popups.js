import { featurePoint } from './geojson-transform.js';

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
// screen-pixel spacing used after projecting the feature onto the map container
const POPUP_MARGIN = 12;
const POPUP_MARKER_GAP = 14;

// unique ids connect each dialog to its generated title
let popupTitleId = 0;

export function showCameraPopup(map, event) {
  showPopup(map, event, createCameraPopup);
}

export function showFirePopup(map, event) {
  showPopup(map, event, createFirePopup);
}

export function showPrescribedPopup(map, event) {
  showPopup(map, event, createPrescribedPopup);
}

function showPopup(map, event, createContent) {
  const feature = event.features?.[0];
  if (!feature) return;

  // polygon clicks fall back to the exact click when no point is available
  const coordinates = featurePoint(feature) || event.lngLat;
  if (!coordinates) return;

  // replacing in place prevents overlapping dialogs and stale listeners
  ACTIVE_POPUPS.get(map)?.close({ immediate: true });

  const popup = new FeaturePopup(
    map,
    coordinates,
    createContent(feature.properties || {})
  );
  ACTIVE_POPUPS.set(map, popup);
  popup.open();
}

/** owns a popup DOM element along with its map listeners and screen position */
class FeaturePopup {
  constructor(map, coordinates, content) {
    this.map = map;
    this.coordinates = coordinates;
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

    this.element
      .querySelector('.feature-popup__close')
      .addEventListener('click', this.handleCloseClick);

    // wait for the feature click to finish before map clicks can dismiss it
    this.mapClickTimer = window.setTimeout(() => {
      this.map
        .getCanvasContainer()
        .addEventListener('click', this.handleMapClick, { capture: true });
    }, 0);

    this.updatePosition();

    // start the transition after the browser has laid out the hidden popup
    requestAnimationFrame(() => {
      this.element.classList.add('is-open');
    });
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

function createPopupElement(content) {
  const popup = document.createElement('section');
  popup.className = 'feature-popup';
  popup.setAttribute('role', 'dialog');

  const title = content.querySelector('strong');
  if (title) {
    // generated title becomes the accessible dialog label
    popupTitleId += 1;
    title.id = `feature-popup-title-${popupTitleId}`;
    popup.setAttribute('aria-labelledby', title.id);
  }

  const closeButton = document.createElement('button');
  closeButton.className = 'feature-popup__close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close popup');
  closeButton.textContent = '\u00d7';

  popup.append(closeButton, content);
  return popup;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function createCameraPopup({ name, id, pan, image, state, county }) {
  const popup = createPopupContainer(name || 'Camera');

  const location = [county, state].filter(Boolean).join(', ');
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

function createFirePopup(properties) {
  // point and perimeter services expose the same fields under different names
  const title =
    properties.IncidentName ||
    properties.poly_IncidentName ||
    properties.attr_IncidentName ||
    'Fire';
  const popup = createPopupContainer(title);

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

function createPrescribedPopup(properties) {
  const popup = createPopupContainer(properties.name || 'Prescribed fire');

  const acres = formatNumber(properties.acreage, ACRES_FORMAT);
  if (acres != null) popup.append(createMetaLine(`${acres} target acres`));

  const startDate = formatArcGISDate(properties.prescribed_date_start);
  if (startDate) popup.append(createMetaLine(`Scheduled: ${startDate}`));

  const watchDutyUrl = getHttpsUrl(properties.watchduty_url);
  if (watchDutyUrl) appendExternalLink(popup, watchDutyUrl, 'Open in Watch Duty');

  return popup;
}

function createPopupContainer(titleText) {
  const popup = document.createElement('div');
  popup.className = 'cam-popup';

  const title = document.createElement('strong');
  title.textContent = titleText;
  popup.append(title);
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
