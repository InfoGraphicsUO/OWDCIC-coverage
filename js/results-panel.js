// square-kilometer to square-mile conversion for displayed area values
const SQMI_PER_SQKM = 0.3861021585;
const UTILITY_QUALIFIER = 'Approximate service area boundary';
const MAP_ATTRIBUTION = 'Map attribution: Mapbox | OpenStreetMap contributors | UO InfoGraphics Lab | OHAZ';
// only these polygon selections include mapped land shares
const POLYGON_DONUT_TYPES = new Set([
  'house', 'us-house', 'senate', 'utility',
]);
// shared category colors keep chart slices and text swatches in sync
const LAND_MIX_COLORS = Object.freeze({
  'Tribal reservation/trust area': '#8154BD',
  'Tribal fee land': '#a881cf',
  'National Park Service land': '#3c6b03',
  'U.S. Forest Service land': '#3b7d4f',
  'Other federal land': '#f6d94a',
  'State land': '#348bb0',
  'Local government land': '#708ac6',
  'Nonprofit open space': '#d47f3e',
  'Mapped private open space': '#aa6a52',
  'Other/unclassified': '#727272',
});
// cycle these colors for source labels outside the named category palette
const LAND_MIX_FALLBACK_COLORS = ['#3b7d4f', '#f6d94a', '#3c6b03', '#8154BD', '#727272', '#008fb3'];

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/**
 * connects selection updates to the results panel and its export downloads
 * accepts plain feature properties so callers need no data-source details
 * keeps chart and dialog state local to this panel instance
 */
export function initResultsPanel({ getMapCanvas, getMap, getLegendItems } = {}) {
  // reuse server markup when present and make the panel usable on standalone pages
  const element = document.querySelector('#results-panel') || createPanel();
  if (!element.parentElement) document.body.append(element);
  ensurePanelMarkup(element);
  const title = element.querySelector('[data-results-title]');
  const subtitle = element.querySelector('[data-results-subtitle]');
  const content = element.querySelector('[data-results-content]');
  const exportButton = element.querySelector('[data-results-export]');
  const status = element.querySelector('[data-results-status]');
  let chart = null;
  let chartReady = Promise.resolve();
  // stale plot promises must not restore a chart after the selection changes
  let chartGeneration = 0;
  let current = null;
  let exportModal = null;

  function clear() {
    // discard the selected feature before async chart work or export can reuse it
    current = null;
    destroyChart();
    closeExportModal();
    // keep an empty panel out of both visual and accessibility navigation
    title.textContent = 'Select an area or camera';
    subtitle.textContent = '';
    content.replaceChildren(emptyState());
    status.textContent = '';
    exportButton.disabled = true;
    element.classList.remove('results-panel--has-result', 'results-panel--loading');
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    element.removeAttribute('aria-busy');
  }

  function showLoading(label = 'Loading coverage…') {
    // a new request immediately invalidates the old selection and its export preview
    current = null;
    destroyChart();
    closeExportModal();
    element.hidden = false;
    element.removeAttribute('aria-hidden');
    element.classList.add('results-panel--has-result', 'results-panel--loading');
    element.setAttribute('aria-busy', 'true');
    title.textContent = label;
    subtitle.textContent = '';
    content.replaceChildren(messageState('Loading coverage statistics…', 'results-panel__loading'));
    status.textContent = '';
    exportButton.disabled = true;
  }

  function showError(message) {
    // clear stale results but leave the failure exposed through the live status region
    current = null;
    destroyChart();
    closeExportModal();
    element.hidden = false;
    element.removeAttribute('aria-hidden');
    element.classList.add('results-panel--has-result');
    element.classList.remove('results-panel--loading');
    element.removeAttribute('aria-busy');
    title.textContent = 'Coverage unavailable';
    subtitle.textContent = '';
    content.replaceChildren(messageState(message || 'Coverage statistics could not be loaded.', 'results-panel__error'));
    status.textContent = message || 'Coverage statistics could not be loaded.';
    exportButton.disabled = true;
  }

  function showPolygon(type, feature) {
    // callers may pass GeoJSON or its properties object directly
    const properties = feature?.properties || feature || {};
    current = { kind: 'polygon', type, properties, geometry: feature?.geometry, bbox: feature?.bbox };
    presentResult(properties.name || properties.label || 'Selected area', renderPolygon(type, properties));
  }

  function showCamera(properties = {}, metrics = null, feature = null) {
    // camera location comes from geometry while descriptive fields stay in properties
    current = { kind: 'camera', properties, metrics, geometry: feature?.geometry };
    const location = [properties.county, properties.state].filter(Boolean).join(', ');
    presentResult(properties.name || 'Camera', renderCamera(properties, metrics), location);
  }

  async function openExportModal() {
    if (!current) {
      // this guard also covers a keyboard activation during a pending selection change
      status.textContent = 'Select a result before exporting.';
      return;
    }
    const selection = current;
    const exportTitle = title.textContent;
    // hold the panel busy until the preview is ready or export fails
    exportButton.disabled = true;
    element.setAttribute('aria-busy', 'true');
    status.textContent = 'Preparing preview…';
    try {
      // wait for the current chart before asking Plotly for its image
      await chartReady.catch(() => {});
      if (current !== selection) return;
      const image = await composeExport({
        // resolve live map and legend state only when the user asks to export
        mapCanvas: await resolveCanvas(getMapCanvas),
        map: typeof getMap === 'function' ? getMap() : null,
        legendItems: await resolveLegendRowsForExport(getLegendItems),
        title: exportTitle,
        current: selection,
        chart,
      });
      if (current !== selection) return;
      status.textContent = '';
      const downloadName = `owdcic-${slugify(exportTitle)}.png`;
      const pdfDownloadName = `owdcic-${slugify(exportTitle)}.pdf`;
      exportModal = createExportModal({
        previewSrc: image,
        downloadName,
        onDownload: () => {
          // use the rendered preview so download and preview always match
          const anchor = document.createElement('a');
          anchor.download = downloadName;
          anchor.href = image;
          anchor.click();
          if (exportModal?.status) exportModal.status.textContent = 'PNG downloaded.';
        },
        onDownloadPdf: async () => {
          // convert the same preview image so PDF and PNG contain identical results
          const modal = exportModal;
          const pdf = await createPdfFromImage(image);
          if (!modal?.overlay.isConnected || current !== selection) return false;
          const url = URL.createObjectURL(pdf);
          const anchor = document.createElement('a');
          anchor.download = pdfDownloadName;
          anchor.href = url;
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          return true;
        },
        onClose: () => {
          // return keyboard focus to the control that opened the dialog
          exportModal = null;
          exportButton.disabled = !current;
          element.removeAttribute('aria-busy');
          exportButton.focus();
        },
      });
    } catch (error) {
      if (current !== selection) return;
      // keep the result available for a retry and expose failure in the panel status
      status.textContent = 'Export preview failed. Try again after the map finishes loading.';
      console.error('OWDCIC export preview failed', error);
      exportButton.disabled = false;
      element.removeAttribute('aria-busy');
    }
  }

  exportButton.addEventListener('click', openExportModal);
  clear();
  return { showPolygon, showCamera, showLoading, showError, clear, element };

  function presentResult(heading, body, detail = '') {
    // each result owns at most one chart and one export dialog
    destroyChart();
    closeExportModal();
    element.hidden = false;
    element.removeAttribute('aria-hidden');
    element.classList.add('results-panel--has-result');
    element.classList.remove('results-panel--loading');
    element.removeAttribute('aria-busy');
    title.textContent = heading;
    subtitle.textContent = detail;
    content.replaceChildren(body);
    const chartHost = content.querySelector('[data-results-chart]');
    // a Plotly promise may settle after a newer selection has replaced this host
    const generation = chartGeneration;
    chartReady = chartHost
      ? Promise.resolve(renderDonut(chartHost, current.kind === 'camera' ? current.metrics?.landMix : current.properties?.landMix))
          .then((node) => {
            if (generation === chartGeneration) chart = node;
          })
          .catch(() => {
            if (generation === chartGeneration) chart = chartHost;
          })
      : Promise.resolve();
    status.textContent = '';
    exportButton.disabled = false;
  }

  function destroyChart() {
    // bump first so an already queued render callback cannot restore the old chart
    chartGeneration += 1;
    if (chart && typeof window.Plotly?.purge === 'function') {
      try { window.Plotly.purge(chart); } catch (_) { /* purge can fail during chart teardown */ }
    }
    chart = null;
    chartReady = Promise.resolve();
  }

  function closeExportModal() {
    if (!exportModal) return;
    exportModal.close();
    exportModal = null;
  }
}

function ensurePanelMarkup(element) {
  // treat the four data slots as one contract so partial legacy markup is rebuilt
  const complete = element.querySelector('[data-results-title]')
    && element.querySelector('[data-results-content]')
    && element.querySelector('[data-results-export]')
    && element.querySelector('[data-results-status]');
  if (!complete) {
    // replace partial legacy markup with the panel's expected control slots
    const scaffold = createPanel();
    element.replaceChildren(...scaffold.childNodes);
  }
  if (!element.querySelector('[data-results-handle]')) {
    // decorative handle is hidden from assistive tech and only used for panel styling
    const handle = document.createElement('div');
    handle.className = 'results-panel__handle';
    handle.dataset.resultsHandle = '';
    handle.setAttribute('aria-hidden', 'true');
    element.prepend(handle);
  }
  if (!element.querySelector('[data-results-subtitle]')) {
    // older page markup gets the camera locality slot without rebuilding the panel
    const subtitle = document.createElement('p');
    subtitle.className = 'results-panel__subtitle';
    subtitle.dataset.resultsSubtitle = '';
    const title = element.querySelector('[data-results-title]');
    title?.parentElement?.append(subtitle);
  }
  const exportButton = element.querySelector('[data-results-export]');
  if (exportButton) {
    // normalize older markup and supply a useful accessible name when absent
    exportButton.textContent = 'Export as…';
    if (!exportButton.getAttribute('aria-label')) {
      exportButton.setAttribute('aria-label', 'Export map, legend, and coverage results as PNG');
    }
  }
  if (!element.querySelector('[data-results-footer]')) {
    // keep export and status controls together for existing page markup
    const footer = document.createElement('div');
    footer.className = 'results-panel__footer';
    footer.dataset.resultsFooter = '';
    const status = element.querySelector('[data-results-status]');
    if (exportButton) {
      exportButton.remove();
      footer.append(exportButton);
    }
    if (status) {
      status.remove();
      footer.append(status);
    }
    element.append(footer);
  }
}

function createPanel() {
  const panel = document.createElement('aside');
  panel.id = 'results-panel';
  panel.className = 'results-panel';
  panel.setAttribute('aria-label', 'Selection results');
  panel.innerHTML = `
    <div class="results-panel__handle" data-results-handle aria-hidden="true"></div>
    <div class="results-panel__header">
      <h2 data-results-title>Select an area or camera</h2>
      <p class="results-panel__subtitle" data-results-subtitle></p>
    </div>
    <div class="results-panel__content" data-results-content></div>
    <div class="results-panel__footer" data-results-footer>
      <button class="results-panel__export" data-results-export type="button" aria-label="Export map, legend, and coverage results as PNG">Export as…</button>
      <p class="results-panel__status" data-results-status role="status" aria-live="polite"></p>
    </div>`;
  return panel;
}

// builds a focus-trapped preview dialog and restores focus when it closes
function createExportModal({ previewSrc, downloadName, onDownload, onDownloadPdf, onClose }) {
  // remember the opener before moving focus into the modal
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'results-export-modal';

  const backdrop = document.createElement('div');
  backdrop.className = 'results-export-modal__backdrop';
  backdrop.dataset.exportBackdrop = '';

  const dialog = document.createElement('div');
  dialog.className = 'results-export-modal__dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'results-export-title');
  dialog.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'results-export-modal__header';
  const heading = document.createElement('h2');
  heading.id = 'results-export-title';
  heading.textContent = 'Export preview';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'results-export-modal__close';
  closeButton.dataset.exportClose = '';
  closeButton.setAttribute('aria-label', 'Close export preview');
  closeButton.textContent = '×';
  header.append(heading, closeButton);

  const previewWrap = document.createElement('div');
  previewWrap.className = 'results-export-modal__preview-wrap';
  const preview = document.createElement('img');
  preview.className = 'results-export-modal__preview';
  preview.dataset.exportPreview = '';
  preview.src = previewSrc;
  preview.alt = `PNG export preview for ${downloadName}`;
  previewWrap.append(preview);

  const actions = document.createElement('div');
  actions.className = 'results-export-modal__actions';
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'results-export-modal__download';
  downloadButton.dataset.exportDownload = '';
  downloadButton.textContent = 'Download PNG';
  const pdfDownloadButton = document.createElement('button');
  pdfDownloadButton.type = 'button';
  pdfDownloadButton.className = 'results-export-modal__download';
  pdfDownloadButton.dataset.exportPdfDownload = '';
  pdfDownloadButton.textContent = 'Download PDF';
  const status = document.createElement('p');
  status.className = 'results-export-modal__status';
  status.dataset.exportStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const buttons = document.createElement('div');
  buttons.className = 'results-export-modal__buttons';
  buttons.append(downloadButton, pdfDownloadButton);
  actions.append(buttons, status);

  dialog.append(header, previewWrap, actions);
  overlay.append(backdrop, dialog);
  document.body.append(overlay);

  // exclude hidden controls so Tab only cycles through targets users can reach
  const focusables = () => [...dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === dialog);

  function close() {
    // remove the document key handler before returning to the page
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    onClose();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    // cycle keyboard focus within the modal
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // button, backdrop, and Escape all share the same teardown and focus restore
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  downloadButton.addEventListener('click', () => {
    onDownload();
  });
  pdfDownloadButton.addEventListener('click', async () => {
    downloadButton.disabled = true;
    pdfDownloadButton.disabled = true;
    status.textContent = 'Preparing PDF…';
    try {
      const downloaded = await onDownloadPdf();
      if (overlay.isConnected) status.textContent = downloaded ? 'PDF downloaded.' : '';
    } catch (error) {
      if (overlay.isConnected) status.textContent = 'PDF export failed. Try again after the map finishes loading.';
      console.error('OWDCIC PDF export failed', error);
    } finally {
      if (overlay.isConnected) {
        downloadButton.disabled = false;
        pdfDownloadButton.disabled = false;
      }
    }
  });
  document.addEventListener('keydown', onKeyDown);
  // defer focus until the dialog has been attached to the document
  requestAnimationFrame(() => dialog.focus());

  return { close, status, overlay };
}

function emptyState() {
  return messageState('Choose a filter or camera to view coverage and land information.', 'results-panel__empty');
}

function messageState(text, className) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function selfLine(text, className = 'results-panel__line') {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function renderPolygon(type, properties) {
  const wrapper = document.createElement('div');
  const coverage = coverageFor(properties);
  const total = finite(properties.landAreaSqKm);
  const covered = finite(properties.cameraViewshedAreaSqKm);
  const name = properties.name || properties.label || 'selected area';
  wrapper.className = 'results-panel__body';
  // source-specific caveats keep approximate or administrative boundaries clear
  if (type === 'utility') {
    // utility outlines describe approximate service coverage
    wrapper.append(selfLine(UTILITY_QUALIFIER, 'results-panel__qualifier'));
  } else if (type === 'national-forest') {
    wrapper.append(selfLine('Administrative forest boundary; may include non-federal inholdings.', 'results-panel__qualifier'));
  } else if (type === 'national-park') {
    wrapper.append(selfLine('Park boundary; may include land outside NPS ownership.', 'results-panel__qualifier'));
  } else if (type === 'federal-land' && /Department of Defense|Other federal fee manager/.test(name)) {
    wrapper.append(selfLine('This source boundary may include planning areas without federal fee ownership.', 'results-panel__qualifier'));
  }
  wrapper.append(selfLine(coverage == null ? 'Coverage unavailable' : `${formatPercent(coverage)}% covered by fire-spotting cameras`, 'results-panel__lead'));
  // area totals need valid source values; missing coverage must stay unavailable, not zero
  if (coverage != null && covered != null && total != null) {
    wrapper.append(selfLine(
      `${formatNumber(covered * SQMI_PER_SQKM)} sq mi of ${name} is covered by fire-spotting cameras, out of total ${formatNumber(total * SQMI_PER_SQKM)} sq mi`,
    ));
  } else if (total != null) {
    wrapper.append(selfLine(`${formatNumber(total * SQMI_PER_SQKM)} sq mi total area`));
  }
  if (polygonShowsDonut(type, properties)) {
    wrapper.append(landMixSection(properties.landMix, 'Mapped land status breakdown'));
  }
  return wrapper;
}

function renderCamera(properties, metrics) {
  const wrapper = document.createElement('div');
  wrapper.className = 'results-panel__body results-panel__camera';
  const imageUrl = safeHttpsUrl(properties.image);
  const preview = document.createElement('div');
  preview.className = 'results-panel__camera-preview';
  preview.setAttribute('role', 'group');
  preview.setAttribute('aria-label', 'Camera preview');
  const unavailable = document.createElement('span');
  unavailable.className = 'results-panel__camera-placeholder';
  unavailable.textContent = 'Camera preview unavailable';
  if (imageUrl) {
    // remove failed remote thumbnails instead of showing a broken image
    const image = document.createElement('img');
    image.className = 'results-panel__camera-image';
    image.src = imageUrl;
    image.alt = `${properties.name || 'Camera'} preview`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.remove();
      preview.prepend(unavailable);
    }, { once: true });
    preview.append(image);
  } else {
    preview.append(unavailable);
  }
  const pan = formatPan(properties.pan);
  const overlay = document.createElement('div');
  overlay.className = 'results-panel__camera-overlay';
  const fallbackFeed = properties.id == null ? '' : `https://alertwest.live/cam-console/${encodeURIComponent(String(properties.id))}`;
  // allow only AlertWest hosts, including generated camera-console links
  const feed = safeAlertWestUrl(properties.feed || properties.url || properties.link || fallbackFeed);
  if (feed) {
    // links open separately and cannot reach the parent window through window.opener
    const a = document.createElement('a');
    a.className = 'results-panel__feed';
    a.href = feed;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Open live camera feed in a new tab');
    a.innerHTML = '<span>Open live camera feed</span><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i>';
    overlay.append(a);
  }
  if (pan) {
    const panLabel = document.createElement('span');
    panLabel.className = 'results-panel__camera-pan';
    panLabel.textContent = `Pan ${pan}`;
    overlay.append(panLabel);
  }
  if (overlay.children.length) preview.append(overlay);
  wrapper.append(preview);
  if (!cameraCoverageAvailable(metrics)) {
    wrapper.append(selfLine('Coverage unavailable', 'results-panel__lead'));
    return wrapper;
  }
  const area = finite(metrics.landAreaSqKm);
  if (area != null) {
    wrapper.append(selfLine(`${formatNumber(area * SQMI_PER_SQKM)} sq mi camera viewshed`, 'results-panel__lead'));
  }
  if (Array.isArray(metrics.landMix) && metrics.landMix.length > 0) {
    wrapper.append(landMixSection(metrics.landMix, 'Viewshed mapped land status breakdown'));
  }
  return wrapper;
}

function landMixSection(landMix, chartLabel) {
  const section = document.createElement('section');
  section.className = 'results-panel__land-mix';
  section.setAttribute('aria-label', chartLabel);
  const chart = document.createElement('div');
  chart.className = 'results-panel__chart';
  chart.dataset.resultsChart = '';
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', chartLabel);
  // stat rows remain the readable source of truth if chart rendering is unavailable
  const stats = document.createElement('div');
  stats.className = 'results-panel__land-stats';
  stats.dataset.resultsLandStats = '';
  appendLandStats(stats, landMix);
  const note = document.createElement('p');
  note.className = 'results-panel__land-note';
  note.textContent = 'Tribal areas follow reservation and trust boundaries. Other named types use mapped ownership parcels. Unclassified includes unmapped private land.';
  section.append(chart, stats, note);
  return section;
}

function appendLandStats(container, landMix) {
  // filter invalid and zero shares before assigning colors by visible row order
  usableLandMix(landMix).forEach((item, index) => {
    const label = item.label || item.type || 'Other/unclassified';
    const p = document.createElement('p');
    p.className = 'results-panel__land-stat';
    const swatch = document.createElement('span');
    swatch.className = 'results-panel__land-swatch';
    swatch.style.backgroundColor = landMixColor(label, index);
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = `${formatPercent(item.percentage)}% of area is ${label}`;
    p.append(swatch, text);
    container.append(p);
  });
}

function landMixColor(label, index = 0) {
  return LAND_MIX_COLORS[label] || LAND_MIX_FALLBACK_COLORS[index % LAND_MIX_FALLBACK_COLORS.length];
}

function renderDonut(host, landMix) {
  // the text breakdown survives both missing data and a missing Plotly bundle
  const rows = usableLandMix(landMix);
  if (!rows.length) {
    host.textContent = 'Mapped land status data unavailable.';
    return host;
  }
  if (typeof window.Plotly?.newPlot !== 'function') {
    host.textContent = 'Chart unavailable. Land shares are listed below.';
    return host;
  }
  // reduced motion keeps the chart static and non-interactive
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // keep data order stable so slice colors match the adjacent text swatches
  return window.Plotly.newPlot(host, [{
    type: 'pie',
    hole: 0.6,
    labels: rows.map(x => x.label || x.type || 'Other/unclassified'),
    values: rows.map(x => x.percentage),
    textinfo: 'none',
    hoverinfo: reducedMotion ? 'skip' : 'label+percent',
    hovertemplate: reducedMotion ? null : '%{label}: %{percent}<extra></extra>',
    marker: { colors: rows.map((row, i) => landMixColor(row.label || row.type || 'Other/unclassified', i)) },
    sort: false,
  }], {
    margin: { t: 36, r: 4, b: 4, l: 4 },
    showlegend: false,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#fff', family: 'Merriweather, sans-serif' },
    title: {
      text: 'Mapped land status',
      x: 0.5,
      xanchor: 'center',
      font: { color: '#fff', family: 'Merriweather, sans-serif', size: 15 },
    },
  }, {
    displayModeBar: false,
    responsive: true,
    staticPlot: reducedMotion,
  }).then(() => host, () => {
    host.textContent = 'Chart unavailable. Land shares are listed below.';
    return host;
  });
}

// export overlay measurements are CSS pixels before canvas scaling
const EXPORT_MARGIN = 16;
const EXPORT_STATS_WIDTH = 360;
const EXPORT_LEGEND_WIDTH = 320;
const EXPORT_FONT = 'Merriweather, "Segoe UI", sans-serif';
const EXPORT_LEGEND_SWATCH_SIZE = 20;
const EXPORT_LEGEND_SWATCH_GAP = 10;
const EXPORT_LEGEND_TEXT_OFFSET = EXPORT_LEGEND_SWATCH_SIZE + EXPORT_LEGEND_SWATCH_GAP;
const EXPORT_PANEL_FILL = 'rgba(47, 46, 46, 0.9)';
// fallback visuals for integrations that provide labels without DOM swatches
const EXPORT_LEGEND_VISUALS = Object.freeze({
  'Cameras (ALERTWest)': { type: 'icon', src: 'img/camera-marker.svg' },
  'Camera viewsheds': { type: 'swatch', style: 'fill', color: '#F28D05' },
  'Standing lookouts': { type: 'swatch', style: 'circle', color: '#8154BD' },
  'National forests': { type: 'swatch', style: 'outline', color: '#3b7d4f' },
  'BLM lands': { type: 'swatch', style: 'fill', color: '#f6d94a' },
  'ODF protection districts': { type: 'swatch', style: 'outline', color: '#008fb3' },
  'OR Burn probability (QWRA)': { type: 'swatch', style: 'burn-probability' },
  'Fires (NIFC)': { type: 'icon', src: 'img/fire-marker.svg' },
  'Prescribed fires (Watch Duty)': { type: 'icon', src: 'img/prescribed-marker.svg' },
});

async function composeExport({ mapCanvas, map, legendItems, title, current, chart }) {
  // fail early before creating a blank or misleading preview
  if (!mapCanvas || typeof mapCanvas.toDataURL !== 'function' || mapCanvas.width < 2 || mapCanvas.height < 2) {
    throw new Error('Map canvas unavailable');
  }
  const mapImage = await loadImage(mapCanvas.toDataURL('image/png'));
  let chartImage = null;
  if (chart && typeof window.Plotly?.toImage === 'function') {
    try {
      // rasterize Plotly separately so the canvas export does not depend on SVG internals
      chartImage = await loadImage(await window.Plotly.toImage(chart, { format: 'png', width: 500, height: 300, scale: 2 }));
    } catch (_) { /* text rows still carry the land shares when rasterization fails */ }
  }
  // preserve the map aspect ratio while enforcing a readable minimum export width
  const width = Math.max(1000, mapImage.width || 1000);
  const height = Math.round((mapImage.height || 600) * width / (mapImage.width || width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  drawExportMap(ctx, mapImage, width, height, mapCanvas, map, current);

  // map canvas dimensions use device pixels while overlays use CSS pixels
  // 1200 CSS px is the overlay design width; larger map rasters scale the cards up
  const overlayScale = Math.max(1, width / 1200);
  const frameWidth = width / overlayScale;
  const frameHeight = height / overlayScale;
  ctx.save();
  ctx.scale(overlayScale, overlayScale);
  drawExportTitle(ctx);

  // resolve legend visuals before layout so loaded icons and labels share one pass
  const legendRows = await preloadLegendVisuals((legendItems || []).filter((row) => row?.label));
  // reserve chart space only when Plotly produced a raster image
  const statsContent = exportStatsContent(current);
  const statsLayout = layoutStatsPanel({
    ctx,
    width: EXPORT_STATS_WIDTH,
    title,
    ...statsContent,
    chartHeight: chartImage ? 180 : 0,
  });
  const legendLayout = layoutLegendPanel({ ctx, width: EXPORT_LEGEND_WIDTH, rows: legendRows });
  const attributionHeight = 18;
  const stackGap = 12;
  const maxPanelBottom = frameHeight - EXPORT_MARGIN - attributionHeight - stackGap;
  // align both cards to the same bottom edge while keeping each above attribution
  const statsX = frameWidth - EXPORT_MARGIN - EXPORT_STATS_WIDTH;
  const statsY = Math.max(EXPORT_MARGIN, maxPanelBottom - statsLayout.height);
  const legendX = EXPORT_MARGIN;
  const legendY = Math.max(EXPORT_MARGIN, maxPanelBottom - legendLayout.height);

  drawLegendOverlay(ctx, legendX, legendY, legendLayout);
  drawStatsOverlay(ctx, statsX, statsY, statsLayout, chartImage);
  drawExportAttribution(ctx, frameWidth, frameHeight);
  ctx.restore();
  return canvas.toDataURL('image/png');
}

async function createPdfFromImage(pngDataUrl) {
  // preserve the composed PNG artwork while placing it on a printable letter page
  const image = await loadImage(pngDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PDF image canvas unavailable');
  ctx.drawImage(image, 0, 0);

  // JPEG is embedded directly in the PDF so no PDF library or extra request is needed
  const jpegData = canvas.toDataURL('image/jpeg', 0.98).split(',')[1];
  const jpegBinary = atob(jpegData);
  const jpegBytes = Uint8Array.from(jpegBinary, (character) => character.charCodeAt(0));
  const pageWidth = 792;
  const pageHeight = 612;
  const scale = Math.min(pageWidth / canvas.width, pageHeight / canvas.height);
  const imageWidth = canvas.width * scale;
  const imageHeight = canvas.height * scale;
  const imageX = (pageWidth - imageWidth) / 2;
  const imageY = (pageHeight - imageHeight) / 2;
  const encoder = new TextEncoder();
  const encode = (text) => encoder.encode(text);
  const joinBytes = (parts) => {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  };
  const imageCommand = `q\n${imageWidth.toFixed(3)} 0 0 ${imageHeight.toFixed(3)} ${imageX.toFixed(3)} ${imageY.toFixed(3)} cm\n/Im0 Do\nQ\n`;
  const objects = [
    encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    encode('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`),
    joinBytes([
      encode(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`),
      jpegBytes,
      encode('\nendstream\nendobj\n'),
    ]),
    encode(`5 0 obj\n<< /Length ${encoder.encode(imageCommand).length} >>\nstream\n${imageCommand}endstream\nendobj\n`),
  ];
  const header = encode('%PDF-1.4\n');
  const offsets = [0];
  let byteOffset = header.length;
  for (const object of objects) {
    offsets.push(byteOffset);
    byteOffset += object.length;
  }
  const xrefOffset = byteOffset;
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([header, ...objects, encode(xref)], { type: 'application/pdf' });
}

function drawExportMap(ctx, image, width, height, mapCanvas, map, current) {
  // zoom in slightly and keep the selected feature near the center
  const focus = exportFocusPoint(map, current, mapCanvas, image);
  const scale = 1.18;
  // use the same source crop ratio on both axes before stretching to the export frame
  const cropWidth = image.width / scale;
  const cropHeight = image.height / scale;
  const cropX = Math.max(0, Math.min(image.width - cropWidth, focus.x - cropWidth / 2));
  const cropY = Math.max(0, Math.min(image.height - cropHeight, focus.y - cropHeight / 2));
  ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
}

function exportFocusPoint(map, current, mapCanvas, image) {
  const fallback = { x: image.width / 2, y: image.height / 2 };
  if (!map || typeof map.project !== 'function') return fallback;
  let coordinates = null;
  if (current?.kind === 'polygon') {
    // polygon bounds avoid biasing the crop toward the first ring coordinate
    const bounds = exportFeatureBounds(current);
    if (bounds) coordinates = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  } else if (
    Array.isArray(current?.geometry?.coordinates)
    && current.geometry.coordinates.length >= 2
    && current.geometry.coordinates.slice(0, 2).every(Number.isFinite)
  ) {
    // camera coordinates are already longitude and latitude
    coordinates = current.geometry.coordinates;
  } else if (typeof map.getCenter === 'function') {
    // use the live viewport center when selection geometry is absent or malformed
    coordinates = map.getCenter();
  }
  if (!coordinates) return fallback;
  const point = map.project(coordinates);
  // convert map-container CSS pixels to the captured canvas pixel grid
  const clientWidth = mapCanvas.clientWidth || image.width;
  const clientHeight = mapCanvas.clientHeight || image.height;
  const x = point?.x * image.width / clientWidth;
  const y = point?.y * image.height / clientHeight;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : fallback;
}

function exportFeatureBounds(current) {
  if (Array.isArray(current.bbox) && current.bbox.length === 4 && current.bbox.every(Number.isFinite)) {
    return current.bbox;
  }
  // walk nested GeoJSON coordinates without assuming geometry type
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      // GeoJSON positions begin with longitude and latitude; ignore later dimensions
      bounds[0] = Math.min(bounds[0], node[0]);
      bounds[1] = Math.min(bounds[1], node[1]);
      bounds[2] = Math.max(bounds[2], node[0]);
      bounds[3] = Math.max(bounds[3], node[1]);
      return;
    }
    node.forEach(visit);
  };
  visit(current.geometry?.coordinates);
  return bounds.every(Number.isFinite) ? bounds : null;
}

function layoutLegendPanel({ ctx, width, rows }) {
  const padX = 16;
  const padY = 14;
  const padBottom = 30;
  const titleHeight = 28;
  const rowHeight = 26;
  // leave room for the empty-legend fallback label
  const contentHeight = titleHeight + Math.max(rows.length, 1) * rowHeight;
  return {
    width,
    height: padY + contentHeight + padBottom,
    padX,
    padY,
    titleHeight,
    rowHeight,
    textOffset: EXPORT_LEGEND_TEXT_OFFSET,
    rows,
  };
}

function exportStatsContent(current) {
  const summaryLines = exportSummary(current);
  let qualifier = null;
  let lines = summaryLines;
  // utility qualifier gets its own visual treatment above the coverage line
  if (lines[0] === UTILITY_QUALIFIER) {
    qualifier = lines[0];
    lines = lines.slice(1);
  }
  return {
    qualifier,
    leadLine: lines[0] || '',
    bodyLines: wrapExportLines(lines.slice(1), 38),
    landMixRows: exportLandMixRows(current),
  };
}

function layoutStatsPanel({ ctx, width, title, qualifier, leadLine, bodyLines, landMixRows, chartHeight }) {
  const padX = 16;
  const padY = 16;
  const titleSize = 18;
  const leadSize = 16;
  const bodySize = 14;
  const qualifierSize = 13;
  const lineGap = 4;
  ctx.font = `700 ${titleSize}px ${EXPORT_FONT}`;
  const titleLines = wrapExportLines([title], 30);
  ctx.font = `${bodySize}px ${EXPORT_FONT}`;
  // wrap land labels with the same width used when drawing the stats panel
  const landLines = landMixRows.map((row) =>
    wrapExportLines([`${formatPercent(row.percentage)}% of area is ${row.label}`], 38));
  // compute card height from the exact rows the draw pass will paint
  let contentHeight = padY + titleLines.length * (titleSize + 4) + 8;
  if (qualifier) contentHeight += qualifierSize + 10;
  if (leadLine) contentHeight += leadSize + lineGap;
  contentHeight += bodyLines.length * (bodySize + lineGap);
  if (chartHeight) contentHeight += chartHeight + 12;
  if (landLines.length) {
    contentHeight += 12 + landLines.reduce((height, lines) =>
      height + lines.length * (bodySize + 6), 0);
  }
  contentHeight += padY;
  return {
    width,
    height: contentHeight,
    padX,
    padY,
    titleLines,
    qualifier,
    leadLine,
    bodyLines,
    landMixRows,
    landLines,
    chartHeight,
    titleSize,
    leadSize,
    bodySize,
    qualifierSize,
  };
}

function drawLegendOverlay(ctx, x, y, layout) {
  drawFloatingPanel(ctx, x, y, layout.width, layout.height, {
    fill: EXPORT_PANEL_FILL,
    border: '#555',
    radius: 12,
    shadow: true,
  });
  let textY = y + layout.padY + 18;
  ctx.fillStyle = '#fff';
  ctx.font = `700 18px ${EXPORT_FONT}`;
  ctx.fillText('Legend', x + layout.padX, textY);
  textY += layout.titleHeight - 8;
  ctx.font = `15px ${EXPORT_FONT}`;
  ctx.fillStyle = '#f0f0f0';
  if (!layout.rows.length) {
    ctx.fillStyle = '#c8c8c8';
    ctx.fillText('No visible layers', x + layout.padX, textY + 17);
    return;
  }
  // draw each visible layer with the same visual parsed from the map legend
  layout.rows.forEach((row) => {
    textY += layout.rowHeight;
    const swatchX = x + layout.padX;
    const swatchY = textY - 17;
    drawLegendVisual(ctx, row.visual, swatchX, swatchY);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillText(row.label, swatchX + layout.textOffset, textY);
  });
}

function drawLegendVisual(ctx, visual, x, y) {
  // visuals are normalized during DOM parsing or label fallback resolution
  if (!visual) return;
  switch (visual.type) {
    case 'swatch':
      drawExportLegendSwatch(ctx, visual, x, y);
      break;
    case 'icon':
      if (visual.image) ctx.drawImage(visual.image, x, y, EXPORT_LEGEND_SWATCH_SIZE, EXPORT_LEGEND_SWATCH_SIZE);
      break;
    case 'markers':
      drawExportLegendMarkers(ctx, visual, x, y);
      break;
    case 'group':
      drawExportLegendGroup(ctx, visual, x, y);
      break;
    default:
      break;
  }
}

function drawExportLegendSwatch(ctx, { style, color }, x, y) {
  const size = EXPORT_LEGEND_SWATCH_SIZE;
  if (style === 'burn-probability') {
    // the map ramp runs from lower to higher burn probability
    const gradient = ctx.createLinearGradient(x, y, x + size, y);
    gradient.addColorStop(0, '#f2774f');
    gradient.addColorStop(1, '#b83745');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, size, size);
    return;
  }
  if (style === 'circle') {
    // two strokes preserve the white edge and subtle dark halo used on the map
    const radius = 5.5;
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    ctx.fillStyle = color || '#777';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(31, 41, 51, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  if (style === 'fill') {
    ctx.fillStyle = color || '#777';
    ctx.fillRect(x, y, size, size);
    return;
  }
  ctx.fillStyle = colorToRgba(color || '#777', 0.24);
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = color || '#777';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
}

function drawExportLegendMarkers(ctx, { color, shapes }, x, y) {
  const markerColor = color || '#777';
  const drawShapes = Array.isArray(shapes) && shapes.length ? shapes : ['triangle', 'circle'];
  const slotWidth = EXPORT_LEGEND_SWATCH_SIZE / drawShapes.length;
  // split the swatch evenly so mixed camera symbols remain distinct
  drawShapes.forEach((shape, index) => {
    const slotX = x + index * slotWidth + (slotWidth - 7) / 2;
    const slotY = y + (EXPORT_LEGEND_SWATCH_SIZE - 7) / 2;
    if (shape === 'circle') {
      ctx.fillStyle = markerColor;
      ctx.beginPath();
      ctx.arc(slotX + 3.5, slotY + 3.5, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colorToRgba(markerColor, 0.45);
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.moveTo(slotX + 3.5, slotY);
    ctx.lineTo(slotX + 7, slotY + 7);
    ctx.lineTo(slotX, slotY + 7);
    ctx.closePath();
    ctx.fill();
  });
}

function drawExportLegendGroup(ctx, { colors }, x, y) {
  // grouped cameras use up to four dots like the compact map symbol
  const palette = (colors || []).slice(0, 4);
  if (!palette.length) return;
  const cell = 6;
  const gap = 1;
  // use a two-column grid like the grouped marker displayed in the map legend
  palette.forEach((color, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(
      x + col * (cell + gap) + cell / 2,
      y + row * (cell + gap) + cell / 2,
      cell / 2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  });
}

function drawStatsOverlay(ctx, x, y, layout, chartImage) {
  drawFloatingPanel(ctx, x, y, layout.width, layout.height, {
    fill: EXPORT_PANEL_FILL,
    border: '#444',
    radius: 12,
    shadow: true,
  });
  let textY = y + layout.padY + layout.titleSize;
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${layout.titleSize}px ${EXPORT_FONT}`;
  layout.titleLines.forEach((line) => {
    ctx.fillText(line, x + layout.padX, textY);
    textY += layout.titleSize + 4;
  });
  textY += 4;
  if (layout.qualifier) {
    // boundary caveat gets a slim marker so it stays distinct from the coverage lead
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(x + layout.padX, textY - 10, 3, layout.qualifierSize + 6);
    ctx.font = `${layout.qualifierSize}px ${EXPORT_FONT}`;
    ctx.fillText(layout.qualifier, x + layout.padX + 10, textY);
    textY += layout.qualifierSize + 10;
  }
  if (layout.leadLine) {
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${layout.leadSize}px ${EXPORT_FONT}`;
    ctx.fillText(layout.leadLine, x + layout.padX, textY);
    textY += layout.leadSize + 6;
  }
  ctx.font = `${layout.bodySize}px ${EXPORT_FONT}`;
  ctx.fillStyle = '#e8e8e8';
  layout.bodyLines.forEach((line) => {
    ctx.fillText(line, x + layout.padX, textY);
    textY += layout.bodySize + 4;
  });
  if (layout.chartHeight && chartImage) {
    // chart sits between the coverage summary and mapped land rows
    textY += 8;
    const chartX = x + layout.padX;
    const chartW = layout.width - layout.padX * 2;
    ctx.drawImage(chartImage, chartX, textY, chartW, layout.chartHeight);
    textY += layout.chartHeight + 8;
  }
  if (layout.landLines.length) {
    // separate mapped ownership shares from the coverage summary above
    ctx.strokeStyle = '#444';
    ctx.beginPath();
    ctx.moveTo(x + layout.padX, textY);
    ctx.lineTo(x + layout.width - layout.padX, textY);
    ctx.stroke();
    textY += 14;
    layout.landMixRows.forEach((row, index) => {
      const swatchX = x + layout.padX;
      const swatchY = textY - 9;
      ctx.fillStyle = landMixColor(row.label, index);
      ctx.fillRect(swatchX, swatchY, 12, 12);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.strokeRect(swatchX, swatchY, 12, 12);
      ctx.fillStyle = '#fff';
      ctx.font = `${layout.bodySize}px ${EXPORT_FONT}`;
      layout.landLines[index].forEach((line) => {
        ctx.fillText(line, swatchX + 20, textY);
        textY += layout.bodySize + 6;
      });
    });
  }
}

function drawExportAttribution(ctx, width, height) {
  // dark stroke keeps the small attribution readable over light map tiles
  ctx.font = `11px ${EXPORT_FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeText(MAP_ATTRIBUTION, EXPORT_MARGIN, height - EXPORT_MARGIN);
  ctx.fillText(MAP_ATTRIBUTION, EXPORT_MARGIN, height - EXPORT_MARGIN);
}

function drawExportTitle(ctx) {
  // outline the title for contrast across both bright and dark map regions
  ctx.font = `700 20px ${EXPORT_FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fillStyle = '#fff';
  ctx.strokeText('OWDCIC Camera Coverage Map', EXPORT_MARGIN, EXPORT_MARGIN + 20);
  ctx.fillText('OWDCIC Camera Coverage Map', EXPORT_MARGIN, EXPORT_MARGIN + 20);
}

function drawFloatingPanel(ctx, x, y, width, height, { fill, border, radius, shadow }) {
  ctx.save();
  if (shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
  }
  fillRoundedRect(ctx, x, y, width, height, radius, fill);
  ctx.restore();
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    strokeRoundedRect(ctx, x, y, width, height, radius);
  }
}

function fillRoundedRect(ctx, x, y, width, height, radius, fill) {
  ctx.beginPath();
  traceRoundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  traceRoundedRect(ctx, x, y, width, height, radius);
  ctx.stroke();
}

function traceRoundedRect(ctx, x, y, width, height, radius) {
  // clamp radius so small panels cannot cross their own corners
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function exportSummary({ kind, type, properties, metrics }) {
  if (kind === 'camera') {
    // mirror the on-screen camera summary order and unavailable-state wording
    const lines = [];
    const location = [properties?.county, properties?.state].filter(Boolean).join(', ');
    if (location) lines.push(`Located in ${location}`);
    const pan = formatPan(properties?.pan);
    if (pan) lines.push(`Pan ${pan}`);
    if (!cameraCoverageAvailable(metrics)) {
      // keep the export state aligned with the interactive panel
      lines.push('Coverage unavailable');
      return lines;
    }
    const area = finite(metrics?.landAreaSqKm);
    if (area != null) lines.push(`${formatNumber(area * SQMI_PER_SQKM)} sq mi camera viewshed`);
    return lines;
  }
  const coverage = coverageFor(properties);
  const covered = finite(properties.cameraViewshedAreaSqKm);
  const selected = finite(properties.landAreaSqKm);
  const name = properties?.name || properties?.label || 'selected area';
  const lines = [];
  if (type === 'utility') lines.push(UTILITY_QUALIFIER);
  lines.push(coverage == null ? 'Coverage unavailable' : `${formatPercent(coverage)}% covered by fire-spotting cameras`);
  if (coverage != null && covered != null && selected != null) {
    lines.push(`${formatNumber(covered * SQMI_PER_SQKM)} sq mi of ${name} is covered by fire-spotting cameras, out of total ${formatNumber(selected * SQMI_PER_SQKM)} sq mi`);
  } else if (selected != null) {
    lines.push(`${formatNumber(selected * SQMI_PER_SQKM)} sq mi total area`);
  }
  return lines;
}

function exportLandMixRows({ kind, type, properties, metrics }) {
  // exported land breakdowns follow the same selection rules as the donut
  if (kind === 'polygon' && !POLYGON_DONUT_TYPES.has(type)) return [];
  const mix = kind === 'camera' ? metrics?.landMix : properties?.landMix;
  if (kind === 'camera' && !cameraCoverageAvailable(metrics)) return [];
  return usableLandMix(mix)
    .map((item) => ({
      label: item.label || item.type || 'Other/unclassified',
      percentage: item.percentage,
    }));
}

function polygonShowsDonut(type, properties) {
  // only supported polygon kinds with at least one positive share get chart space
  return POLYGON_DONUT_TYPES.has(type) && usableLandMix(properties.landMix).length > 0;
}

function usableLandMix(landMix) {
  // discard absent, nonnumeric, zero, and negative shares before charting or export
  return Array.isArray(landMix)
    ? landMix.filter((item) => finite(item?.percentage) != null && finite(item.percentage) > 0)
    : [];
}

function cameraCoverageAvailable(metrics) {
  // metrics without an area are incomplete even when a response object exists
  return Boolean(metrics)
    && metrics.coverageAvailable !== false
    && finite(metrics.landAreaSqKm) != null;
}

function coverageFor(p) {
  if (!p) return null;
  if (finite(p.cameraViewshedCoveragePct) != null) return p.cameraViewshedCoveragePct;
  // derive coverage only when the source did not provide a percentage
  const covered = finite(p.cameraViewshedAreaSqKm);
  const total = finite(p.landAreaSqKm);
  return covered != null && total > 0 ? Math.min(100, covered / total * 100) : null;
}

function finite(value) {
  // reject booleans and empty strings before numeric coercion
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
  // number formatting is for already validated display values
  return numberFormat.format(Number(value) || 0);
}

function formatPercent(value) {
  // clamp displayed percentages so malformed source values cannot exceed 0–100%
  const number = Number(value);
  return numberFormat.format(Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0)));
}

function formatPan(value) {
  const number = finite(value);
  // camera pan values are degrees
  return number == null ? '' : `${numberFormat.format(number)}°`;
}

function slugify(value) {
  // keep generated filenames portable and bounded even for long selection labels
  return String(value || 'selection').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'selection';
}

function safeHttpsUrl(value) {
  // reject malformed and non-HTTPS thumbnail URLs
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function safeAlertWestUrl(value) {
  // feed links may use the live site or its legacy .com hosts
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'alertwest.live' || url.hostname === 'alertwest.com' || url.hostname.endsWith('.alertwest.com'))
      ? url.href
      : '';
  } catch (_) {
    return '';
  }
}

async function resolveLegendRowsForExport(getLegendItems) {
  // current DOM state wins so hidden and unchecked layers stay out of the image
  const domRows = readLegendRowsFromDom();
  if (domRows.length) return domRows;
  return normalizeLegendRows(typeof getLegendItems === 'function' ? getLegendItems() : []);
}

function readLegendRowsFromDom() {
  if (typeof document?.getElementById !== 'function') return [];
  const legend = document.getElementById('legend');
  if (!legend) return [];
  // include only rows users can see and have enabled
  return [...legend.querySelectorAll('.legend-row')]
    .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
    .filter((row) => !row.hidden && !row.closest('.legend-group[hidden]'))
    .map(parseLegendRowFromDom)
    .filter((row) => row?.label);
}

function parseLegendRowFromDom(row) {
  const label = row.querySelector('.legend-label')?.textContent?.trim();
  if (!label) return null;
  const visualRoot = row.querySelector('.legend-visual');
  const visual = visualRoot ? parseLegendVisualFromDom(visualRoot) : exportLegendVisualForLabel(label);
  return { label, visual: visual || exportLegendVisualForLabel(label) };
}

function parseLegendVisualFromDom(visualRoot) {
  // prefer actual legend classes and colors so the PNG follows current styling
  const swatch = visualRoot.querySelector('.legend-swatch');
  if (swatch) {
    const color = readCssColor(swatch, '--legend-swatch-color');
    if (swatch.classList.contains('legend-swatch--burn-probability')) {
      return { type: 'swatch', style: 'burn-probability' };
    }
    if (swatch.classList.contains('legend-swatch--circle')) {
      return { type: 'swatch', style: 'circle', color };
    }
    if (swatch.classList.contains('legend-swatch--fill')) {
      return { type: 'swatch', style: 'fill', color };
    }
    return { type: 'swatch', style: 'outline', color };
  }

  const icon = visualRoot.querySelector('.legend-icon');
  if (icon?.getAttribute('src')) {
    // load icon pixels later so a missing asset does not drop its label
    return { type: 'icon', src: icon.getAttribute('src') };
  }

  const markers = visualRoot.querySelector('.legend-camera-symbols');
  if (markers) {
    const color = readCssColor(markers, '--legend-marker-color');
    const shapes = [...markers.querySelectorAll('.legend-camera-symbol')].map((node) => (
      node.classList.contains('legend-camera-symbol--circle') ? 'circle' : 'triangle'
    ));
    return { type: 'markers', color, shapes: shapes.length ? shapes : ['triangle', 'circle'] };
  }

  const group = visualRoot.querySelector('.legend-camera-group-symbol');
  if (group) {
    const colors = [...group.children]
      .map((node) => node.style.background || readComputedBackground(node))
      .filter(Boolean);
    return { type: 'group', colors };
  }

  return null;
}

function normalizeLegendRows(items) {
  // accept labels and small object shapes from map integrations
  return (items || []).map((item) => {
    if (typeof item === 'string' || typeof item === 'number') {
      const label = String(item).trim();
      return label ? { label, visual: exportLegendVisualForLabel(label) } : null;
    }
    if (item && typeof item === 'object') {
      const label = String(item.label || item.textContent || item.title || '').trim();
      if (!label) return null;
      return {
        label,
        visual: item.visual || exportLegendVisualForLabel(label),
      };
    }
    return null;
  }).filter(Boolean);
}

function exportLegendVisualForLabel(label) {
  // known labels provide a stable visual when the legend DOM is not available
  return EXPORT_LEGEND_VISUALS[label] ? { ...EXPORT_LEGEND_VISUALS[label] } : null;
}

async function preloadLegendVisuals(rows) {
  // canvas drawing needs icon images fully loaded before the export pass
  return Promise.all(rows.map(async (row) => {
    if (row.visual?.type !== 'icon' || !row.visual.src) return row;
    try {
      const image = await loadImage(resolveAssetUrl(row.visual.src));
      return { ...row, visual: { ...row.visual, image } };
    } catch (_) {
      // retain the text row when its icon asset cannot be loaded
      return row;
    }
  }));
}

function readCssColor(node, variableName) {
  // use inline values first, then the active stylesheet value
  const inline = node.style?.getPropertyValue(variableName)?.trim();
  if (inline) return inline;
  if (typeof getComputedStyle === 'function') {
    return getComputedStyle(node).getPropertyValue(variableName).trim();
  }
  return '';
}

function readComputedBackground(node) {
  if (typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(node).backgroundColor;
}

function resolveAssetUrl(src) {
  try {
    return new URL(src, window.location.href).href;
  } catch (_) {
    return src;
  }
}

function colorToRgba(color, alpha) {
  // normalize RGB and short or long hex colors for translucent canvas fills
  const value = String(color || '').trim();
  if (!value) return `rgba(119, 119, 119, ${alpha})`;
  if (value.startsWith('rgb')) {
    const channels = value.match(/\d+/g);
    if (channels?.length >= 3) return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }
  const hex = value.replace('#', '');
  // expand shorthand hex and normalize malformed lengths before channel parsing
  const normalized = hex.length === 3
    ? hex.split('').map((char) => char + char).join('')
    : hex.padStart(6, '0').slice(0, 6);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return `rgba(119, 119, 119, ${alpha})`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function wrapExportLines(lines, maxChars) {
  // fit text to fixed-width canvas panels without measuring every glyph
  const wrapped = [];
  lines.forEach((line) => {
    const text = String(line);
    if (text.length <= maxChars) {
      wrapped.push(text);
      return;
    }
    const indent = text.match(/^\s*/)?.[0] || '';
    let remaining = text.trimStart();
    while (remaining.length) {
      if (remaining.length <= maxChars - indent.length) {
        wrapped.push(indent + remaining);
        break;
      }
      const slice = remaining.slice(0, maxChars - indent.length);
      const breakAt = slice.lastIndexOf(' ');
      // prefer a word boundary unless it would leave an awkward tiny first line
      const take = breakAt > 12 ? slice.slice(0, breakAt) : slice;
      wrapped.push(indent + take);
      remaining = remaining.slice(take.length).trimStart();
    }
  });
  return wrapped;
}

function resolveCanvas(value) {
  // callers can pass a canvas or a getter for a changing map
  return typeof value === 'function' ? value() : value;
}

// resolves after image load or rejects on a browser load error
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}
