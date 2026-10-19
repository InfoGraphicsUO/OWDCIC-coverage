import { openModal } from './modal.js';
import { CAMERA_PROVIDER_COLORS, LEGEND_LAYERS, PANO_VIEWERS } from './config.js';
import { attachInfoTooltip } from './info-tooltip.js';
import { getSetting } from './settings.js';

const LAND_MIX_TITLE = 'Mapped land status';
const LAND_MIX_INFO = 'Tribal areas follow reservation and trust boundaries. Other named types use mapped ownership parcels. Unclassified includes unmapped private land.';

// square-kilometer to square-mile conversion for displayed area values
const SQMI_PER_SQKM = 0.3861021585;
const UTILITY_QUALIFIER = 'Approximate service area boundary';

// the utility filter switches this layer on, so its panel keys the line color too
const TRANSMISSION_LINES_QUALIFIER = 'Transmission lines';

// names what the yellow selection outline traces for each filter group
const BOUNDARY_QUALIFIERS = Object.freeze({
  state: 'State boundary',
  county: 'County boundary',
  house: 'State House district boundary',
  'us-house': 'US House district boundary',
  senate: 'State Senate district boundary',
  utility: UTILITY_QUALIFIER,
  'national-forest': 'Administrative forest boundary; may include non-federal inholdings.',
  'national-park': 'Park boundary; may include land outside NPS ownership.',
  'federal-land': 'Federal land boundary',
  'tribal-land': 'Tribal land boundary',
  'odf-protection-district': 'ODF protection district boundary',
});

const MAP_ATTRIBUTION = 'Map attribution: Mapbox | OpenStreetMap contributors | UO InfoGraphics Lab | OHAZ';

// Mapbox satellite imagery carries its own provider credit
const SATELLITE_MAP_ATTRIBUTION = 'Map attribution: Mapbox | OpenStreetMap contributors | Maxar | UO InfoGraphics Lab | OHAZ';

// only these polygon selections include mapped land shares
const POLYGON_DONUT_TYPES = new Set([
  'house', 'us-house', 'senate', 'utility', 'odf-protection-district',
]);

// shared category colors keep chart slices and text swatches in sync
const LAND_MIX_COLORS = Object.freeze({
  'Tribal reservation/trust area': '#8154BD',
  'Tribal fee land': '#a881cf',
  'National Park Service land': '#9A8B70',
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

// filter groups whose "All" option offers the summary report and CSV, named for report wording
// add a group here to give its "All" option the same export choices
const SUMMARY_REPORT_GROUPS = Object.freeze({
  'odf-protection-district': { unit: 'district', units: 'districts' },
  'national-forest': { unit: 'national forest', units: 'national forests' },
});

// providers split out in the report and CSV, keyed like each area's providerCoverage and colored like their map symbols
const COVERAGE_PROVIDERS = Object.freeze([
  Object.freeze({ key: 'alertwest', label: 'ALERTWest', color: CAMERA_PROVIDER_COLORS.alertWest }),
  Object.freeze({ key: 'pano', label: 'Pano AI', color: CAMERA_PROVIDER_COLORS.pano }),
  Object.freeze({ key: 'envirovision', label: 'EnviroVision', color: CAMERA_PROVIDER_COLORS.enviroVision }),
]);

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/**
 * connects selection updates to the results panel and its export downloads
 * accepts plain feature properties so callers need no data-source details
 * keeps chart and dialog state local to this panel instance
 */
export function initResultsPanel({
  getMapCanvas, getMap, getBasemap, getLegendItems, getSelectionLegendItems, getMemberFeatures,
  onClose = () => {},
} = {}) {
  const element = document.querySelector('#results-panel');
  const title = element.querySelector('[data-results-title]');
  const subtitle = element.querySelector('[data-results-subtitle]');
  const content = element.querySelector('[data-results-content]');
  const exportButton = element.querySelector('[data-results-export]');
  const shareButton = element.querySelector('[data-results-share]');

  // touch devices get the OS share sheet; everything else copies the link
  const useShareSheet = typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const shareIcon = document.createElement('i');
  shareIcon.className = useShareSheet ? 'fa-solid fa-arrow-up-from-bracket' : 'fa-regular fa-copy';
  shareIcon.setAttribute('aria-hidden', 'true');
  const shareLabel = document.createElement('span');
  const shareText = useShareSheet ? 'Share' : 'Copy link';
  shareLabel.textContent = shareText;

  // the label itself confirms a copy, so screen readers need to hear it change
  shareLabel.setAttribute('aria-live', 'polite');
  let shareLabelTimer = null;
  shareButton.replaceChildren(shareIcon, shareLabel);
  const status = element.querySelector('[data-results-status]');
  const infoTooltip = attachInfoTooltip(content);
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
    replaceContent(emptyState());
    status.textContent = '';
    exportButton.disabled = true;
    shareButton.disabled = true;
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
    replaceContent(selfLine('Loading coverage statistics…', 'results-panel__loading'));
    status.textContent = '';
    exportButton.disabled = true;
    shareButton.disabled = true;
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
    replaceContent(selfLine(message || 'Coverage statistics could not be loaded.', 'results-panel__error'));
    status.textContent = message || 'Coverage statistics could not be loaded.';
    exportButton.disabled = true;
    shareButton.disabled = true;
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

    // provider cameras without a locality show their operator instead
    const location = [properties.county, properties.state].filter(Boolean).join(', ') || properties.operator || '';
    presentResult(properties.name || 'Camera', renderCamera(properties, metrics), location);
  }

  function openExportModal() {
    if (!current) {
      // this guard also covers a keyboard activation during a pending selection change
      status.textContent = 'Select a result before exporting.';
      return;
    }

    const members = summaryReportMembers(current);

    // only an "All" option with its member areas loaded offers the report choices
    if (members.length) {
      openExportChooser(current, members);
      return Promise.resolve();
    }

    return openMapExport();
  }

  function openExportChooser(selection, members) {
    const group = SUMMARY_REPORT_GROUPS[selection.type];
    const exportTitle = title.textContent;
    exportButton.disabled = true;
    status.textContent = '';
    exportModal = createExportChooserModal({
      group,
      title: exportTitle,
      onReport: () => {
        closeExportModal();
        openSummaryReport(selection, members, exportTitle);
      },
      onCsv: () => {
        downloadBlob(
          new Blob([summaryCsv(selection, members)], { type: 'text/csv;charset=utf-8' }),
          `owdcic-${slugify(exportTitle)}-summary.csv`,
        );
      },
      onMap: () => {
        closeExportModal();
        openMapExport();
      },
      onClose: () => {
        exportModal = null;
        exportButton.disabled = !current;
        exportButton.focus();
      },
    });
  }

  // composes the map, legend, and results card that both the map export and the report open with
  async function composeSelectionMap(selection, exportTitle) {
    // wait for the current chart before asking Plotly for its image
    await chartReady.catch(() => {});
    if (current !== selection) return null;
    return composeExport({
      // resolve live map and legend state only when the user asks to export
      mapCanvas: await resolveCanvas(getMapCanvas),
      map: typeof getMap === 'function' ? getMap() : null,
      basemap: typeof getBasemap === 'function' ? getBasemap() : null,
      legendItems: placeSelectedViewshedRow(
        await resolveLegendRowsForExport(getLegendItems, typeof getBasemap === 'function' ? getBasemap() : null),
        // selection symbols have no layer row, so the map reports them for this export
        normalizeLegendRows(typeof getSelectionLegendItems === 'function' ? getSelectionLegendItems(selection) : []),
      ),
      title: exportTitle,
      current: selection,
      chart,
    });
  }

  async function openMapExport() {
    if (!current) return;
    const selection = current;
    const exportTitle = title.textContent;

    // hold the panel busy until the preview is ready or export fails
    exportButton.disabled = true;
    element.setAttribute('aria-busy', 'true');
    status.textContent = 'Preparing preview…';
    try {
      const image = await composeSelectionMap(selection, exportTitle);
      if (!image || current !== selection) return;
      status.textContent = '';
      const downloadName = `owdcic-${slugify(exportTitle)}.png`;
      const pdfDownloadName = `owdcic-${slugify(exportTitle)}.pdf`;
      exportModal = createExportModal({
        previewSrcs: [image],
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
          const pdf = await createPdfFromImages([image]);
          if (!modal?.overlay.isConnected || current !== selection) return false;
          downloadBlob(pdf, pdfDownloadName);
          return true;
        },
        onClose: closeToExportButton,
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

  async function openSummaryReport(selection, members, exportTitle) {
    if (current !== selection) return;
    exportButton.disabled = true;
    element.setAttribute('aria-busy', 'true');
    status.textContent = 'Preparing report…';
    try {
      const mapImage = await composeSelectionMap(selection, exportTitle);
      if (!mapImage || current !== selection) return;
      const pages = await composeSummaryPages({
        title: exportTitle,
        group: SUMMARY_REPORT_GROUPS[selection.type],
        total: selection.properties,
        members: members.map((feature) => feature.properties || {}),
        mapImage,
      });

      if (current !== selection) return;
      status.textContent = '';
      const pdfDownloadName = `owdcic-${slugify(exportTitle)}-summary-report.pdf`;
      exportModal = createExportModal({
        title: 'Summary report preview',
        previewSrcs: pages,
        downloadName: pdfDownloadName,
        onDownloadPdf: async () => {
          const modal = exportModal;
          const pdf = await createPdfFromImages(pages);
          if (!modal?.overlay.isConnected || current !== selection) return false;
          downloadBlob(pdf, pdfDownloadName);
          return true;
        },
        onClose: closeToExportButton,
      });
    } catch (error) {
      if (current !== selection) return;
      status.textContent = 'Summary report failed. Try again after the map finishes loading.';
      console.error('OWDCIC summary report failed', error);
      exportButton.disabled = false;
      element.removeAttribute('aria-busy');
    }
  }

  function closeToExportButton() {
    // return keyboard focus to the control that opened the dialog
    exportModal = null;
    exportButton.disabled = !current;
    element.removeAttribute('aria-busy');
    exportButton.focus();
  }

  function summaryReportMembers(selection) {
    const ids = selection?.properties?.memberDivisionIds;
    if (selection?.kind !== 'polygon' || !SUMMARY_REPORT_GROUPS[selection.type] || !Array.isArray(ids)) return [];
    return typeof getMemberFeatures === 'function' ? getMemberFeatures(selection.type, ids) : [];
  }

  async function shareLink() {
    if (!current) return;
    const selection = current;

    // the map keeps the URL query string on the current selection, so the address is the link
    const url = window.location.href;
    if (useShareSheet) {
      try {
        await navigator.share({ title: title.textContent, url });
        return;
      } catch (error) {
        // dismissing the share sheet is not a failure; anything else falls back to copying
        if (error?.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);

      // confirm in place, then hand the button its label back
      shareLabel.textContent = 'Link copied!';
      window.clearTimeout(shareLabelTimer);
      shareLabelTimer = window.setTimeout(() => { shareLabel.textContent = shareText; }, 2500);
    } catch (error) {
      if (current === selection) status.textContent = 'Link could not be copied. Copy it from the address bar instead.';
    }
  }

  exportButton.addEventListener('click', openExportModal);
  shareButton.addEventListener('click', shareLink);

  // the caller owns clearing so the filter panel and map reset together
  element.querySelector('[data-results-close]').addEventListener('click', () => onClose());
  clear();
  return { showPolygon, showCamera, showLoading, showError, clear, element };

  function replaceContent(node) {
    // a removed trigger fires no pointerout, so its tooltip would stay on screen
    if (infoTooltip.isFor(content)) infoTooltip.hide();
    content.replaceChildren(node);
  }

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
    replaceContent(body);
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
    shareButton.disabled = false;
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

// builds the export preview inside the shared modal shell
// reports pass several page images; leaving out onDownload hides the PNG button
function createExportModal({
  title = 'Export preview', previewSrcs, downloadName, onDownload, onDownloadPdf, onClose,
}) {
  const { overlay, backdrop, dialog, closeButton, close } = openModal({
    id: 'results-export',
    title,
    closeLabel: `Close ${title.toLowerCase()}`,
    className: 'results-export-modal',
    onClose,
  });

  backdrop.dataset.exportBackdrop = '';
  closeButton.dataset.exportClose = '';

  const previewWrap = document.createElement('div');
  previewWrap.className = 'results-export-modal__preview-wrap';
  previewSrcs.forEach((src, index) => {
    const preview = document.createElement('img');
    preview.className = 'results-export-modal__preview';
    preview.dataset.exportPreview = '';
    preview.src = src;
    preview.alt = previewSrcs.length > 1
      ? `Page ${index + 1} of ${previewSrcs.length} preview for ${downloadName}`
      : `PNG export preview for ${downloadName}`;
    previewWrap.append(preview);
  });

  const actions = document.createElement('div');
  actions.className = 'modal__footer';
  const downloadButton = onDownload ? document.createElement('button') : null;
  if (downloadButton) {
    downloadButton.type = 'button';
    downloadButton.className = 'modal__button';
    downloadButton.dataset.exportDownload = '';
    downloadButton.textContent = 'Download PNG';
  }

  const pdfDownloadButton = document.createElement('button');
  pdfDownloadButton.type = 'button';
  pdfDownloadButton.className = 'modal__button';
  pdfDownloadButton.dataset.exportPdfDownload = '';
  pdfDownloadButton.textContent = 'Download PDF';
  const status = document.createElement('p');
  status.className = 'modal__status';
  status.dataset.exportStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const buttons = document.createElement('div');
  buttons.className = 'modal__buttons';
  buttons.append(...[downloadButton, pdfDownloadButton].filter(Boolean));
  actions.append(buttons, status);

  dialog.append(previewWrap, actions);

  downloadButton?.addEventListener('click', () => {
    onDownload();
  });

  pdfDownloadButton.addEventListener('click', async () => {
    if (downloadButton) downloadButton.disabled = true;
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
        if (downloadButton) downloadButton.disabled = false;
        pdfDownloadButton.disabled = false;
      }
    }
  });

  return { close, status, overlay };
}

// "All" options pick between the full report, its data, and the single map export
function createExportChooserModal({ group, title, onReport, onCsv, onMap, onClose }) {
  const { dialog, close } = openModal({
    id: 'results-export-chooser',
    title: 'Export as…',
    closeLabel: 'Close export options',
    className: 'results-export-chooser',
    onClose,
  });

  const body = document.createElement('div');
  body.className = 'modal__body results-export-chooser__options';
  const status = document.createElement('p');
  status.className = 'modal__status';
  status.dataset.exportStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const choices = [
    {
      key: 'report',
      icon: 'fa-file-pdf',
      label: 'Full summary report (PDF)',
      detail: `A full summary report including an overview map, a table comparing every ${group.unit}, and coverage and land status for each ${group.unit}, split by camera provider`,
      run: onReport,
    },
    {
      key: 'csv',
      icon: 'fa-file-csv',
      label: 'Summary data (CSV)',
      detail: `Coverage, coverage by camera provider, area, and mapped land status for every ${group.unit}`,
      run: () => {
        onCsv();
        status.textContent = 'CSV downloaded.';
      },
    },
    {
      key: 'map',
      icon: 'fa-map',
      label: 'Map report',
      detail: `The map, legend, and results for ${title} on one page, as PNG or PDF`,
      run: onMap,
    },
  ];
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'results-export-chooser__option';
    button.dataset.exportOption = choice.key;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${choice.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = choice.label;
    const detail = document.createElement('span');
    detail.className = 'results-export-chooser__detail';
    detail.textContent = choice.detail;
    text.append(label, detail);
    button.append(icon, text);
    button.addEventListener('click', choice.run);
    body.append(button);
  }

  body.append(status);
  dialog.append(body);
  return { close, status };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function emptyState() {
  return selfLine('Choose a coverage area or camera to view coverage and land information.', 'results-panel__empty');
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
  const qualifier = type === 'federal-land' && /Department of Defense|Other federal fee manager/.test(name)
    ? 'This source boundary may include planning areas without federal fee ownership.'
    : BOUNDARY_QUALIFIERS[type];
  if (qualifier) wrapper.append(selfLine(qualifier, 'results-panel__qualifier'));
  if (type === 'utility') {
    wrapper.append(selfLine(
      TRANSMISSION_LINES_QUALIFIER,
      'results-panel__qualifier results-panel__qualifier--transmission-lines',
    ));
  }

  wrapper.append(selfLine(coverage == null ? 'Coverage unavailable' : `${formatPercent(coverage)}% covered by fire detection cameras`, 'results-panel__lead'));

  // area totals need valid source values; missing coverage must stay unavailable, not zero
  if (coverage != null && covered != null && total != null) {
    wrapper.append(selfLine(
      `${formatNumber(covered * SQMI_PER_SQKM)} mi² of ${name} is covered by fire detection cameras, out of total ${formatNumber(total * SQMI_PER_SQKM)} mi²`,
    ));
  } else if (total != null) {
    wrapper.append(selfLine(`${formatNumber(total * SQMI_PER_SQKM)} mi² total area`));
  }

  if (polygonShowsDonut(type, properties)) {
    wrapper.append(landMixSection(properties.landMix, 'Mapped land status breakdown'));
  }

  return wrapper;
}

function renderCamera(properties, metrics) {
  const wrapper = document.createElement('div');
  wrapper.className = 'results-panel__body results-panel__camera';

  // each owner's public viewer only carries that owner's own Pano AI cameras
  const viewer = properties.operator === 'Pano AI' || properties.provider === 'pano'
    ? PANO_VIEWERS[properties.owner || 'Portland General Electric']
    : null;
  const isPano = Boolean(viewer);
  const imageUrl = safeHttpsUrl(properties.image);
  const preview = document.createElement('div');
  preview.className = 'results-panel__camera-preview';
  preview.setAttribute('role', 'group');
  preview.setAttribute('aria-label', 'Camera preview');
  const unavailable = document.createElement('span');
  unavailable.className = 'results-panel__camera-placeholder';
  // EnviroVision ForestWatch imagery goes to fire agencies and responders, with no public viewer
  const isEnviroVision = properties.provider === 'envirovision' || /^EnviroVision/.test(properties.operator || '');
  unavailable.textContent = isPano
    ? `Camera view available on ${viewer.name}, provided by Pano AI`
    : isEnviroVision ? 'No public camera preview is available. EnviroVision ForestWatch imagery is limited to approved agencies.' : 'Camera preview unavailable';
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
  const fallbackFeed = isPano ? viewer.url : properties.id == null ? '' : `https://alertwest.live/cam-console/${encodeURIComponent(String(properties.id))}`;
  const feed = safeCameraFeedUrl(properties.feed || properties.url || properties.link || fallbackFeed, viewer);

  // a Pano camera without its own page still opens the viewer's front page
  const feedLabel = isPano && feed === viewer.url ? `Open ${viewer.name}` : 'Open live camera feed';
  if (feed) {
    // links open separately and cannot reach the parent window through window.opener
    const a = document.createElement('a');
    a.className = 'results-panel__feed';
    a.href = feed;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', `${feedLabel} in a new tab`);
    a.innerHTML = `<span>${feedLabel}</span><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i>`;
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
    wrapper.append(selfLine(cameraUnavailableMessage(properties, metrics), 'results-panel__lead'));
    return wrapper;
  }

  const area = finite(metrics.landAreaSqKm);
  if (area != null) {
    wrapper.append(selfLine(`${formatNumber(area * SQMI_PER_SQKM)} mi² camera viewshed`, 'results-panel__lead'));
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
  const heading = document.createElement('div');
  heading.className = 'results-panel__land-mix-heading';
  const title = document.createElement('h3');
  title.className = 'results-panel__land-mix-title';
  title.textContent = LAND_MIX_TITLE;
  const infoButton = document.createElement('button');
  infoButton.type = 'button';
  infoButton.className = 'info-button results-panel__land-info';
  infoButton.dataset.tooltip = LAND_MIX_INFO;
  infoButton.setAttribute('aria-label', LAND_MIX_INFO);
  infoButton.innerHTML = '<i class="fa-regular fa-circle-info" aria-hidden="true"></i>';
  heading.append(title, infoButton);
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
  note.textContent = 'Entries under 1% are not shown.';
  section.append(heading, chart, stats, note);
  return section;
}

function appendLandStats(container, landMix) {
  // filter invalid and sub-1% shares before assigning colors by visible row order
  usableLandMix(landMix).forEach((item, index) => {
    const label = item.label || item.type || 'Other/unclassified';
    const p = document.createElement('p');
    p.className = 'results-panel__land-stat';
    const swatch = document.createElement('span');
    swatch.className = 'results-panel__land-swatch';
    swatch.style.backgroundColor = landMixColor(label, index);
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = `${formatPercent(item.percentage)}% ${label}`;
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
    margin: { t: 8, r: 4, b: 4, l: 4 },
    showlegend: false,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#fff', family: 'Merriweather, sans-serif' },
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

// legend and results cards draw at this share of their design size so more of the map shows
const EXPORT_CARD_SCALE = 0.7;
const EXPORT_FONT = 'Merriweather, "Segoe UI", sans-serif';
const EXPORT_LEGEND_SWATCH_SIZE = 20;
const EXPORT_LEGEND_SWATCH_GAP = 10;
const EXPORT_LEGEND_TEXT_OFFSET = EXPORT_LEGEND_SWATCH_SIZE + EXPORT_LEGEND_SWATCH_GAP;

// selection rows carry place and camera names, which can outgrow one legend line
const EXPORT_LEGEND_LABEL_CHARS = 30;
const EXPORT_LEGEND_LINE_HEIGHT = 18;
const EXPORT_PANEL_FILL = 'rgba(47, 46, 46, 0.9)';

// fallback visuals for integrations that provide labels without DOM swatches
const EXPORT_LEGEND_VISUALS = Object.freeze({
  'ALERTWest cameras': { type: 'icon', src: 'img/camera-marker.svg' },
  'Pano AI cameras': { type: 'icon', src: 'img/pano-camera-marker.svg' },
  'EnviroVision cameras': { type: 'icon', src: 'img/envirovision-camera-marker.svg' },
  'Camera viewsheds': { type: 'swatch', style: 'fill', color: '#F28D05' },
  'ALERTWest camera viewsheds': { type: 'swatch', style: 'fill', color: '#F28D05' },
  'Pano AI camera viewsheds': { type: 'swatch', style: 'fill', color: '#3898ec' },
  'EnviroVision camera viewsheds': { type: 'swatch', style: 'fill', color: '#4fa83d' },
  'Standing lookouts': { type: 'swatch', style: 'circle', color: '#8154BD' },
  'National forests': { type: 'swatch', style: 'outline', color: '#3b7d4f' },
  'BLM lands': { type: 'swatch', style: 'fill', color: '#f6d94a' },
  'OR Burn probability (QWRA)': { type: 'swatch', style: 'burn-probability' },
  'Transmission lines': { type: 'swatch', style: 'line', color: '#c2188f' },
  'Fires (NIFC)': { type: 'icon', src: 'img/fire-marker.svg' },
  'Prescribed fires (Watch Duty)': { type: 'icon', src: 'img/prescribed-marker.svg' },
});

// the export names viewsheds without repeating "camera" on every row
const EXPORT_SHARED_VIEWSHED_LABEL = 'Viewsheds';
const EXPORT_PROVIDER_VIEWSHED_LABELS = Object.freeze({
  [LEGEND_LAYERS.alertWestViewsheds]: 'ALERTWest viewsheds',
  [LEGEND_LAYERS.panoViewsheds]: 'Pano AI viewsheds',
  [LEGEND_LAYERS.enviroVisionViewsheds]: 'EnviroVision viewsheds',
});

// rows drawn in the shared viewshed color get a sample viewshed instead of a flat swatch
const EXPORT_SHARED_COLOR_VIEWSHED_LABELS = new Set([
  EXPORT_SHARED_VIEWSHED_LABEL,
  EXPORT_PROVIDER_VIEWSHED_LABELS[LEGEND_LAYERS.alertWestViewsheds],
]);
const EXPORT_VIEWSHED_ICONS = Object.freeze({
  outdoors: 'img/orange_portland_tower_viewshed.png',
  satellite: 'img/grey_portland_tower_viewshed.png',
});

async function composeExport({ mapCanvas, map, basemap, legendItems, title, current, chart }) {
  // fail early before creating a blank or misleading preview
  if (!mapCanvas || typeof mapCanvas.toDataURL !== 'function' || mapCanvas.width < 2 || mapCanvas.height < 2) {
    throw new Error('Map canvas unavailable');
  }

  const mapImage = await loadImage(mapCanvas.toDataURL('image/png'));
  let chartImage = null;
  if (chart && typeof window.Plotly?.toImage === 'function') {
    try {
      // rasterize Plotly separately so the canvas export does not depend on SVG internals
      // the panel titles the chart in HTML, so the raster needs its own title
      const figure = chart.data ? {
        data: chart.data,
        layout: {
          ...chart.layout,
          margin: { ...chart.layout?.margin, t: 36 },
          title: {
            text: LAND_MIX_TITLE,
            x: 0.5,
            xanchor: 'center',
            font: { color: '#fff', family: 'Merriweather, sans-serif', size: 15 },
          },
        },
      } : chart;
      chartImage = await loadImage(await window.Plotly.toImage(figure, { format: 'png', width: 500, height: 300, scale: 2 }));
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

  // the cards draw in their own smaller frame; margins and attribution keep the full scale
  const cardFrameWidth = frameWidth / EXPORT_CARD_SCALE;
  const cardMargin = EXPORT_MARGIN / EXPORT_CARD_SCALE;
  const maxPanelBottom = (frameHeight - EXPORT_MARGIN - attributionHeight - stackGap) / EXPORT_CARD_SCALE;

  // align both cards to the same bottom edge while keeping each above attribution
  const statsX = cardFrameWidth - cardMargin - EXPORT_STATS_WIDTH;
  const statsY = Math.max(cardMargin, maxPanelBottom - statsLayout.height);
  const legendX = cardMargin;
  const legendY = Math.max(cardMargin, maxPanelBottom - legendLayout.height);

  ctx.save();
  ctx.scale(EXPORT_CARD_SCALE, EXPORT_CARD_SCALE);
  drawLegendOverlay(ctx, legendX, legendY, legendLayout);
  drawStatsOverlay(ctx, statsX, statsY, statsLayout, chartImage);
  ctx.restore();
  drawExportAttribution(ctx, frameWidth, frameHeight, basemap);
  ctx.restore();
  return canvas.toDataURL('image/png');
}

async function createPdfFromImages(pngDataUrls) {
  // each composed image becomes one landscape letter page, fit inside the page
  const pageWidth = 792;
  const pageHeight = 612;
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

  // objects 1 and 2 are the catalog and page tree; each page then adds a page, image, and content object
  const pageObjectIds = pngDataUrls.map((_, index) => 3 + index * 3);
  const objects = [
    encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    encode(`2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>\nendobj\n`),
  ];
  for (const [index, pngDataUrl] of pngDataUrls.entries()) {
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
    const scale = Math.min(pageWidth / canvas.width, pageHeight / canvas.height);
    const imageWidth = canvas.width * scale;
    const imageHeight = canvas.height * scale;
    const imageX = (pageWidth - imageWidth) / 2;
    const imageY = (pageHeight - imageHeight) / 2;
    const imageCommand = `q\n${imageWidth.toFixed(3)} 0 0 ${imageHeight.toFixed(3)} ${imageX.toFixed(3)} ${imageY.toFixed(3)} cm\n/Im0 Do\nQ\n`;
    const pageId = pageObjectIds[index];
    objects.push(
      encode(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>\nendobj\n`),
      joinBytes([
        encode(`${pageId + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`),
        jpegBytes,
        encode('\nendstream\nendobj\n'),
      ]),
      encode(`${pageId + 2} 0 obj\n<< /Length ${encoder.encode(imageCommand).length} >>\nstream\n${imageCommand}endstream\nendobj\n`),
    );
  }

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

// summary report pages are landscape letter, laid out in PDF points and rasterized at REPORT_SCALE
const REPORT_PAGE_WIDTH = 792;
const REPORT_PAGE_HEIGHT = 612;
const REPORT_SCALE = 2.5;
const REPORT_MARGIN = 36;
const REPORT_TEXT = '#2f2e2e';
const REPORT_MUTED = '#686868';
const REPORT_RULE = '#d6d6d6';
const REPORT_STRIPE = '#f4f4f4';
const REPORT_ACCENT = '#f8e109';

// covered bars use the shared viewshed orange from the map
const REPORT_COVERAGE_COLOR = '#F28D05';
const REPORT_BAR_TRACK = '#e8e8e8';

// land seen by more than one provider, kept neutral so it reads apart from every provider color
const REPORT_OVERLAP_COLOR = '#6b6b6b';
const REPORT_OVERLAP_LABEL = 'More than one provider';
const REPORT_CARDS_PER_PAGE = 4;
const REPORT_SITE_URL = 'infographicsuo.github.io/OWDCIC-coverage';
const reportDateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });

// overview map, a comparison table in list order, the same table from most to least covered,
// then four area cards per page
async function composeSummaryPages({ title, group, total, members, mapImage }) {
  // canvas text falls back silently if Merriweather has not finished loading
  await document.fonts?.ready;
  const map = await loadImage(mapImage);
  const ranked = rankByCoverage(members);
  const cardPages = [];
  for (let index = 0; index < members.length; index += REPORT_CARDS_PER_PAGE) {
    cardPages.push(members.slice(index, index + REPORT_CARDS_PER_PAGE));
  }

  const bodies = [
    (ctx, top, bottom) => drawReportMap(ctx, map, top, bottom),
    (ctx, top, bottom) => drawReportTable(ctx, {
      heading: `Coverage by ${group.unit}`, group, total, members, top, bottom,
    }),
    (ctx, top, bottom) => drawReportTable(ctx, {
      heading: `${capitalize(group.units)} from most to least covered`, group, total, members: ranked, top, bottom,
    }),
    ...cardPages.map((cards) => (ctx, top, bottom) => drawReportCards(ctx, { cards, top, bottom })),
  ];
  const header = { title, date: reportDateFormat.format(new Date()), pageCount: bodies.length };
  return bodies.map((drawBody, index) => drawReportPage(header, index + 1, drawBody));
}

function drawReportPage({ title, date, pageCount }, pageNumber, drawBody) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(REPORT_PAGE_WIDTH * REPORT_SCALE);
  canvas.height = Math.round(REPORT_PAGE_HEIGHT * REPORT_SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(REPORT_SCALE, REPORT_SCALE);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, REPORT_PAGE_WIDTH, REPORT_PAGE_HEIGHT);
  const right = REPORT_PAGE_WIDTH - REPORT_MARGIN;

  ctx.fillStyle = REPORT_TEXT;
  ctx.font = `700 18px ${EXPORT_FONT}`;
  ctx.fillText(`${title}: camera coverage summary`, REPORT_MARGIN, REPORT_MARGIN + 14);
  ctx.fillStyle = REPORT_MUTED;
  ctx.font = `10px ${EXPORT_FONT}`;
  ctx.fillText('OWDCIC Camera Coverage Map', REPORT_MARGIN, REPORT_MARGIN + 31);
  ctx.textAlign = 'right';
  ctx.fillText(date, right, REPORT_MARGIN + 31);
  ctx.textAlign = 'left';
  ctx.fillStyle = REPORT_ACCENT;
  ctx.fillRect(REPORT_MARGIN, REPORT_MARGIN + 40, right - REPORT_MARGIN, 3);

  const footerY = REPORT_PAGE_HEIGHT - REPORT_MARGIN + 16;
  ctx.fillStyle = REPORT_MUTED;
  ctx.font = `8px ${EXPORT_FONT}`;
  ctx.fillText(`UO InfoGraphics Lab | OHAZ | ${REPORT_SITE_URL}`, REPORT_MARGIN, footerY);
  ctx.textAlign = 'right';
  ctx.fillText(`Page ${pageNumber} of ${pageCount}`, right, footerY);
  ctx.textAlign = 'left';

  drawBody(ctx, REPORT_MARGIN + 58, REPORT_PAGE_HEIGHT - REPORT_MARGIN - 4);
  return canvas.toDataURL('image/png');
}

function drawReportMap(ctx, image, top, bottom) {
  // the map export already carries its legend, results card, and attribution
  const boxWidth = REPORT_PAGE_WIDTH - REPORT_MARGIN * 2;
  const boxHeight = bottom - top;
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = REPORT_MARGIN + (boxWidth - width) / 2;
  ctx.drawImage(image, x, top, width, height);
  ctx.strokeStyle = REPORT_RULE;
  ctx.lineWidth = 0.75;
  ctx.strokeRect(x, top, width, height);
}

function drawReportTable(ctx, { heading, group, total, members, top, bottom }) {
  const right = REPORT_PAGE_WIDTH - REPORT_MARGIN;
  const coverage = coverageFor(total);
  const covered = finite(total.cameraViewshedAreaSqKm);
  const area = finite(total.landAreaSqKm);
  ctx.fillStyle = REPORT_TEXT;
  ctx.font = `700 14px ${EXPORT_FONT}`;
  ctx.fillText(heading, REPORT_MARGIN, top + 4);
  ctx.font = `11px ${EXPORT_FONT}`;
  if (coverage != null && covered != null && area != null) {
    ctx.fillText(
      `${totalName(total, group)}: ${formatPercent(coverage)}% covered by fire detection cameras, ${formatNumber(covered * SQMI_PER_SQKM)} mi² of ${formatNumber(area * SQMI_PER_SQKM)} mi²`,
      REPORT_MARGIN, top + 22,
    );
  }

  // column positions in points; numbers are right aligned to their column edge
  const columns = {
    name: REPORT_MARGIN + 6,
    bar: 260,
    barWidth: 240,
    covered: 640,
    total: REPORT_PAGE_WIDTH - REPORT_MARGIN - 6,
  };

  // the provider key needs a line of its own above the column headings
  const split = [total, ...members].some(hasProviderCoverage);
  if (split) drawProviderKey(ctx, REPORT_MARGIN, top + 40);
  const headerY = top + (split ? 62 : 50);
  const rows = [...members, { ...total, name: totalName(total, group) }];
  const rowHeight = Math.min(28, (bottom - headerY - 8) / rows.length);

  ctx.fillStyle = REPORT_MUTED;
  ctx.font = `700 9px ${EXPORT_FONT}`;
  ctx.fillText(capitalize(group.unit), columns.name, headerY);
  ctx.fillText('Camera coverage', columns.bar, headerY);
  ctx.textAlign = 'right';
  ctx.fillText('Covered (mi²)', columns.covered, headerY);
  ctx.fillText('Total (mi²)', columns.total, headerY);
  ctx.textAlign = 'left';
  ctx.strokeStyle = REPORT_TEXT;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(REPORT_MARGIN, headerY + 7);
  ctx.lineTo(right, headerY + 7);
  ctx.stroke();

  rows.forEach((row, index) => {
    const isTotal = index === rows.length - 1;
    const rowTop = headerY + 8 + index * rowHeight;
    const textY = rowTop + rowHeight / 2 + 3.5;
    if (isTotal) {
      ctx.strokeStyle = REPORT_TEXT;
      ctx.beginPath();
      ctx.moveTo(REPORT_MARGIN, rowTop);
      ctx.lineTo(right, rowTop);
      ctx.stroke();
    } else if (index % 2 === 1) {
      ctx.fillStyle = REPORT_STRIPE;
      ctx.fillRect(REPORT_MARGIN, rowTop, right - REPORT_MARGIN, rowHeight);
    }

    const rowCoverage = coverageFor(row);
    const rowCovered = finite(row.cameraViewshedAreaSqKm);
    const rowArea = finite(row.landAreaSqKm);
    const weight = isTotal ? '700 ' : '';
    ctx.fillStyle = REPORT_TEXT;
    ctx.font = `${weight}10px ${EXPORT_FONT}`;

    // a name too long for its column, like a forest's state portion, wraps onto a second line
    const nameLines = splitToWidth(ctx, row.name || row.label || '', columns.bar - columns.name - 8);
    if (nameLines.length > 1) {
      ctx.font = `${weight}${rowHeight < 24 ? 9 : 10}px ${EXPORT_FONT}`;
      nameLines.forEach((line, lineIndex) => ctx.fillText(line, columns.name, textY + (lineIndex - 0.5) * 11));
      ctx.font = `${weight}10px ${EXPORT_FONT}`;
    } else {
      ctx.fillText(nameLines[0], columns.name, textY);
    }
    drawCoverageBar(ctx, columns.bar, rowTop + rowHeight / 2 - 4, columns.barWidth, 8, rowCoverage, coverageSegments(row));
    ctx.fillStyle = REPORT_TEXT;
    ctx.fillText(rowCoverage == null ? 'n/a' : `${formatPercent(rowCoverage)}%`, columns.bar + columns.barWidth + 8, textY);
    ctx.textAlign = 'right';
    ctx.fillText(rowCovered == null ? '' : formatNumber(rowCovered * SQMI_PER_SQKM), columns.covered, textY);
    ctx.fillText(rowArea == null ? '' : formatNumber(rowArea * SQMI_PER_SQKM), columns.total, textY);
    ctx.textAlign = 'left';
  });
}

// the selected option names the total, e.g. Oregon National Forests rather than every forest
function totalName(total, group) {
  return total.name || total.label || `All ${group.units}`;
}

function drawReportCards(ctx, { cards, top, bottom }) {
  const gap = 16;

  // the notes under the cards explain the coverage and land status figures they show
  const split = cards.some(hasProviderCoverage);
  const notesHeight = split ? 44 : 28;
  const width = (REPORT_PAGE_WIDTH - REPORT_MARGIN * 2 - gap) / 2;
  const height = (bottom - top - gap - notesHeight) / 2;
  cards.forEach((properties, index) => {
    const x = REPORT_MARGIN + (index % 2) * (width + gap);
    const y = top + Math.floor(index / 2) * (height + gap);
    drawReportCard(ctx, x, y, width, height, properties);
  });

  ctx.fillStyle = REPORT_MUTED;
  ctx.font = `8px ${EXPORT_FONT}`;
  ctx.fillText(
    'Covered area is land inside at least one fire detection camera viewshed. Land status shares come from mapped ownership parcels;',
    REPORT_MARGIN, bottom - 12,
  );

  ctx.fillText('unclassified includes unmapped private land. Shares under 1% are not shown.', REPORT_MARGIN, bottom - 2);
  if (split) drawProviderKey(ctx, REPORT_MARGIN, bottom - 28);
}

function drawReportCard(ctx, x, y, width, height, properties) {
  const pad = 14;
  const coverage = coverageFor(properties);
  const covered = finite(properties.cameraViewshedAreaSqKm);
  const area = finite(properties.landAreaSqKm);
  ctx.strokeStyle = REPORT_RULE;
  ctx.lineWidth = 0.75;
  strokeRoundedRect(ctx, x, y, width, height, 6);

  ctx.fillStyle = REPORT_TEXT;
  const name = properties.name || properties.label || '';
  ctx.font = `700 ${fitFontSize(ctx, name, width - pad * 2, 13, 9, '700')}px ${EXPORT_FONT}`;
  ctx.fillText(name, x + pad, y + 24);
  ctx.font = `600 11px ${EXPORT_FONT}`;
  ctx.fillText(coverage == null ? 'Coverage unavailable' : `${formatPercent(coverage)}% covered by fire detection cameras`, x + pad, y + 44);
  drawCoverageBar(ctx, x + pad, y + 51, width - pad * 2, 8, coverage, coverageSegments(properties));
  if (covered != null && area != null) {
    ctx.fillStyle = REPORT_MUTED;
    ctx.font = `10px ${EXPORT_FONT}`;
    ctx.fillText(`${formatNumber(covered * SQMI_PER_SQKM)} mi² covered of ${formatNumber(area * SQMI_PER_SQKM)} mi² total`, x + pad, y + 76);
  }

  const landMix = usableLandMix(properties.landMix);
  if (!landMix.length) return;
  ctx.fillStyle = REPORT_TEXT;
  ctx.font = `700 10px ${EXPORT_FONT}`;
  ctx.fillText(LAND_MIX_TITLE, x + pad, y + 100);
  const radius = Math.min(52, (height - 116) / 2);
  drawLandMixDonut(ctx, x + pad + radius, y + 110 + radius, radius, landMix);
  const rowsX = x + pad + radius * 2 + 20;
  const rowStep = 14;
  const maxRows = Math.floor((height - 118) / rowStep);
  landMix.slice(0, maxRows).forEach((item, index) => {
    const rowY = y + 124 + index * rowStep;
    ctx.fillStyle = landMixColor(item.label, index);
    ctx.fillRect(rowsX, rowY - 8, 9, 9);
    ctx.fillStyle = REPORT_TEXT;
    ctx.font = `10px ${EXPORT_FONT}`;
    ctx.fillText(`${formatPercent(item.percentage)}% ${item.label}`, rowsX + 15, rowY);
  });
}

// one bar for total coverage; with a provider split it is cut into each provider's segment
// the text as one line, or split at the last space that lets the first line fit
function splitToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  for (let count = words.length - 1; count > 0; count -= 1) {
    const first = words.slice(0, count).join(' ');
    if (ctx.measureText(first).width <= maxWidth) return [first, words.slice(count).join(' ')];
  }
  return [text];
}

// the largest font size from size down to minSize that fits the text in maxWidth
function fitFontSize(ctx, text, maxWidth, size, minSize, weight = '') {
  let fitted = size;
  ctx.font = `${weight} ${fitted}px ${EXPORT_FONT}`;
  while (fitted > minSize && ctx.measureText(text).width > maxWidth) {
    fitted -= 0.5;
    ctx.font = `${weight} ${fitted}px ${EXPORT_FONT}`;
  }
  return fitted;
}

function drawCoverageBar(ctx, x, y, width, height, coverage, segments = null) {
  ctx.fillStyle = REPORT_BAR_TRACK;
  ctx.fillRect(x, y, width, height);
  if (coverage == null) return;
  const parts = segments || [{ color: REPORT_COVERAGE_COLOR, value: coverage }];
  let start = 0;
  for (const { color, value } of parts) {
    // clamp so rounding in the source shares never runs past the track
    const end = Math.min(100, start + Math.max(0, value));
    ctx.fillStyle = color;
    ctx.fillRect(x + width * start / 100, y, width * (end - start) / 100, height);
    start = end;
  }
}

function drawProviderKey(ctx, x, y) {
  const items = [
    ...COVERAGE_PROVIDERS.map(({ label, color }) => ({ label: `${label} only`, color })),
    { label: REPORT_OVERLAP_LABEL, color: REPORT_OVERLAP_COLOR },
  ];
  ctx.font = `9px ${EXPORT_FONT}`;
  ctx.fillStyle = REPORT_MUTED;
  ctx.fillText('Coverage seen by:', x, y);
  let cursor = x + ctx.measureText('Coverage seen by:').width + 10;
  for (const { label, color } of items) {
    ctx.fillStyle = color;
    ctx.fillRect(cursor, y - 7, 8, 8);
    ctx.fillStyle = REPORT_TEXT;
    ctx.fillText(label, cursor + 12, y);
    cursor += 12 + ctx.measureText(label).width + 14;
  }
}

function drawLandMixDonut(ctx, cx, cy, radius, landMix) {
  // shares are normalized like the Plotly donut, which also drops entries under 1%
  const sum = landMix.reduce((total, item) => total + finite(item.percentage), 0);
  if (!(sum > 0)) return;
  let angle = -Math.PI / 2;
  landMix.forEach((item, index) => {
    const sweep = finite(item.percentage) / sum * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = landMixColor(item.label, index);
    ctx.fill();
    angle += sweep;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

// most covered first; areas without coverage keep their list order at the end
function rankByCoverage(members) {
  const covered = members.filter((properties) => coverageFor(properties) != null)
    .sort((a, b) => coverageFor(b) - coverageFor(a));
  return [...covered, ...members.filter((properties) => coverageFor(properties) == null)];
}

function hasProviderCoverage(properties) {
  return Array.isArray(properties?.providerCoverage) && properties.providerCoverage.length > 0;
}

// one provider's coverage of an area, or null when the area has no split for it
function providerCoverageFor(properties, key) {
  const item = hasProviderCoverage(properties)
    ? properties.providerCoverage.find((entry) => entry?.provider === key)
    : null;
  if (!item) return null;
  return {
    coverage: finite(item.cameraViewshedCoveragePct),
    covered: finite(item.cameraViewshedAreaSqKm),
    exclusive: finite(item.exclusiveCoveragePct),
    exclusiveCovered: finite(item.exclusiveAreaSqKm),
  };
}

// what is left of the total once each provider's own share is taken out is seen by more than one provider
function overlapCoverage(properties) {
  const coverage = coverageFor(properties);
  const covered = finite(properties.cameraViewshedAreaSqKm);
  const shares = COVERAGE_PROVIDERS.map(({ key }) => providerCoverageFor(properties, key));
  if (!hasProviderCoverage(properties) || shares.some((share) => share?.exclusive == null)) return null;
  const sum = (field) => shares.reduce((total, share) => total + (share[field] ?? 0), 0);
  return {
    coverage: coverage == null ? null : Math.max(0, coverage - sum('exclusive')),
    covered: covered == null ? null : Math.max(0, covered - sum('exclusiveCovered')),
  };
}

// bar segments in key order: each provider alone, then land several providers see
function coverageSegments(properties) {
  const overlap = overlapCoverage(properties);
  if (overlap?.coverage == null) return null;
  return [
    ...COVERAGE_PROVIDERS.map(({ key, color }) => ({ color, value: providerCoverageFor(properties, key).exclusive })),
    { color: REPORT_OVERLAP_COLOR, value: overlap.coverage },
  ];
}

// one row per member area and a final row for the combined option, with unrounded source values
function summaryCsv(selection, members) {
  const group = SUMMARY_REPORT_GROUPS[selection.type];
  const rows = [...members.map((feature) => feature.properties || {}), selection.properties];
  const present = new Set(rows.flatMap((row) => (Array.isArray(row.landMix) ? row.landMix : []).map((item) => item.label)));

  // named categories keep the panel's order, and any new source labels follow
  const labels = [
    ...Object.keys(LAND_MIX_COLORS).filter((label) => present.has(label)),
    ...[...present].filter((label) => label && !(label in LAND_MIX_COLORS)),
  ];
  const header = [
    capitalize(group.unit), 'Coverage (%)', 'Covered area (sq mi)', 'Total area (sq mi)',
    'Covered area (sq km)', 'Total area (sq km)',
    ...COVERAGE_PROVIDERS.flatMap(({ label }) => [
      `${label} coverage (%)`, `${label} covered area (sq mi)`, `${label} only (%)`, `${label} only (sq mi)`,
    ]),
    `${REPORT_OVERLAP_LABEL} (%)`, `${REPORT_OVERLAP_LABEL} (sq mi)`,
    ...labels.flatMap((label) => [`${label} (%)`, `${label} (sq mi)`]),
  ];
  const lines = rows.map((row) => {
    const mix = new Map((Array.isArray(row.landMix) ? row.landMix : []).map((item) => [item.label, item]));
    const covered = finite(row.cameraViewshedAreaSqKm);
    const area = finite(row.landAreaSqKm);
    return [
      row.name || row.label || '',
      csvNumber(coverageFor(row)),
      csvNumber(covered == null ? null : covered * SQMI_PER_SQKM),
      csvNumber(area == null ? null : area * SQMI_PER_SQKM),
      csvNumber(covered),
      csvNumber(area),
      ...COVERAGE_PROVIDERS.flatMap(({ key }) => {
        // an area without a provider split stays blank rather than 0
        const split = providerCoverageFor(row, key);
        return [
          csvNumber(split?.coverage), csvNumber(sqMiles(split?.covered)),
          csvNumber(split?.exclusive), csvNumber(sqMiles(split?.exclusiveCovered)),
        ];
      }),
      csvNumber(overlapCoverage(row)?.coverage), csvNumber(sqMiles(overlapCoverage(row)?.covered)),
      ...labels.flatMap((label) => {
        const item = mix.get(label);
        const share = finite(item?.areaSqKm);

        // a category missing from an area's mix is none of its land, not unknown
        return [csvNumber(finite(item?.percentage) ?? 0), csvNumber(share == null ? 0 : share * SQMI_PER_SQKM)];
      }),
    ];
  });

  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
}

function sqMiles(sqKm) {
  return sqKm == null ? null : sqKm * SQMI_PER_SQKM;
}

function csvNumber(value) {
  return value == null ? '' : String(Math.round(value * 100) / 100);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
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
  const titleHeight = 18;
  const rowHeight = 26;
  const labelLines = rows.map((row) => wrapExportLines([row.label], EXPORT_LEGEND_LABEL_CHARS));
  const extraLines = labelLines.reduce((total, lines) => total + lines.length - 1, 0);

  // leave room for the empty-legend fallback label
  const contentHeight = titleHeight + Math.max(rows.length, 1) * rowHeight + extraLines * EXPORT_LEGEND_LINE_HEIGHT;
  return {
    width,
    height: padY + contentHeight + padBottom,
    padX,
    padY,
    titleHeight,
    rowHeight,
    textOffset: EXPORT_LEGEND_TEXT_OFFSET,
    rows,
    labelLines,
  };
}

function exportStatsContent(current) {
  const lines = exportSummary(current);
  return {
    leadLine: lines[0] || '',
    bodyLines: wrapExportLines(lines.slice(1), 38),
    landMixRows: exportLandMixRows(current),
  };
}

function layoutStatsPanel({ ctx, width, title, leadLine, bodyLines, landMixRows, chartHeight }) {
  const padX = 16;
  const padY = 16;
  const titleSize = 18;
  const leadSize = 16;
  const bodySize = 14;
  const lineGap = 4;
  ctx.font = `700 ${titleSize}px ${EXPORT_FONT}`;
  const titleLines = wrapExportLines([title], 30);
  ctx.font = `${bodySize}px ${EXPORT_FONT}`;

  // wrap land labels with the same width used when drawing the stats panel
  const landLines = landMixRows.map((row) =>
    wrapExportLines([`${formatPercent(row.percentage)}% ${row.label}`], 38));
  // compute card height from the exact rows the draw pass will paint
  let contentHeight = padY + titleLines.length * (titleSize + 4) + 8;
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
    leadLine,
    bodyLines,
    landMixRows,
    landLines,
    chartHeight,
    titleSize,
    leadSize,
    bodySize,
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
  ctx.fillText('OWDCIC Camera Coverage', x + layout.padX, textY);
  textY += layout.titleHeight - 8;
  ctx.font = `15px ${EXPORT_FONT}`;
  ctx.fillStyle = '#f0f0f0';
  if (!layout.rows.length) {
    ctx.fillStyle = '#c8c8c8';
    ctx.fillText('No visible layers', x + layout.padX, textY + 17);
    return;
  }

  // text is drawn from its baseline, so capital height locates the middle of a line
  const capHeight = ctx.measureText('H').actualBoundingBoxAscent || 11;

  // draw each visible layer with the same visual parsed from the map legend
  layout.rows.forEach((row, index) => {
    textY += layout.rowHeight;
    const swatchX = x + layout.padX;

    // the swatch centers on the whole label, including wrapped lines
    const lineCount = layout.labelLines[index].length;
    const labelMiddle = textY + (lineCount - 1) * EXPORT_LEGEND_LINE_HEIGHT / 2 - capHeight / 2;
    const swatchY = labelMiddle - EXPORT_LEGEND_SWATCH_SIZE / 2;
    drawLegendVisual(ctx, row.visual, swatchX, swatchY);
    ctx.fillStyle = '#f0f0f0';
    layout.labelLines[index].forEach((line, lineIndex) => {
      if (lineIndex) textY += EXPORT_LEGEND_LINE_HEIGHT;
      ctx.fillText(line, swatchX + layout.textOffset, textY);
    });
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
      drawExportLegendIcon(ctx, visual, x, y);
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

function drawExportLegendIcon(ctx, { image, size = EXPORT_LEGEND_SWATCH_SIZE, outline }, x, y) {
  if (!image) return;

  // larger icons grow evenly around the normal slot so centering holds
  const inset = (EXPORT_LEGEND_SWATCH_SIZE - size) / 2;

  // large raster icons such as the viewshed samples blur with the default low-quality scaling
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x + inset, y + inset, size, size);
  if (!outline) return;

  // round outline follows the circular sample viewshed
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + EXPORT_LEGEND_SWATCH_SIZE / 2, y + EXPORT_LEGEND_SWATCH_SIZE / 2, size / 2 - 0.5, 0, Math.PI * 2);
  ctx.stroke();
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

  if (style === 'line') {
    // linear features read as a stroke across the middle of the swatch slot
    ctx.strokeStyle = color || '#777';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + size / 2);
    ctx.lineTo(x + size, y + size / 2);
    ctx.stroke();
    return;
  }

  if (style === 'border') {
    // a selected area is drawn as an outline with no fill
    ctx.strokeStyle = color || '#777';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
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

function drawExportAttribution(ctx, width, height, basemap) {
  const attribution = basemap === 'satellite' ? SATELLITE_MAP_ATTRIBUTION : MAP_ATTRIBUTION;

  // dark stroke keeps the small attribution readable over light map tiles
  ctx.font = `11px ${EXPORT_FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeText(attribution, EXPORT_MARGIN, height - EXPORT_MARGIN);
  ctx.fillText(attribution, EXPORT_MARGIN, height - EXPORT_MARGIN);
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
      lines.push(cameraUnavailableMessage(properties, metrics));
      return lines;
    }

    const area = finite(metrics?.landAreaSqKm);
    if (area != null) lines.push(`${formatNumber(area * SQMI_PER_SQKM)} mi² camera viewshed`);
    return lines;
  }

  const coverage = coverageFor(properties);
  const covered = finite(properties.cameraViewshedAreaSqKm);
  const selected = finite(properties.landAreaSqKm);
  const name = properties?.name || properties?.label || 'selected area';

  // the export legend names the approximate utility boundary instead of a line here
  const lines = [];
  lines.push(coverage == null ? 'Coverage unavailable' : `${formatPercent(coverage)}% covered by fire detection cameras`);
  if (coverage != null && covered != null && selected != null) {
    lines.push(`${formatNumber(covered * SQMI_PER_SQKM)} mi² of ${name} is covered by fire detection cameras, out of total ${formatNumber(selected * SQMI_PER_SQKM)} mi²`);
  } else if (selected != null) {
    lines.push(`${formatNumber(selected * SQMI_PER_SQKM)} mi² total area`);
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
  // only supported polygon kinds with at least one share of 1% or more get chart space
  return POLYGON_DONUT_TYPES.has(type) && usableLandMix(properties.landMix).length > 0;
}

function usableLandMix(landMix) {
  // discard absent, nonnumeric, and sub-1% shares, then order largest first for charting and export
  return Array.isArray(landMix)
    ? landMix
      .filter((item) => finite(item?.percentage) != null && finite(item.percentage) >= 1)
      .sort((a, b) => finite(b.percentage) - finite(a.percentage))
    : [];
}

// separates cameras that have no viewshed from viewsheds whose coverage failed
function cameraUnavailableMessage(properties, metrics) {
  if (!metrics && !properties?.viewshed_id) {
    return 'Coverage unavailable: no viewshed has been generated for this camera.';
  }

  if (metrics?.status === 'skipped_missing_height') {
    return 'Coverage unavailable: viewshed not generated because the camera height is missing.';
  }

  return 'Coverage unavailable: a viewshed exists but its land coverage could not be calculated.';
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
  return numberFormat.format(Math.round(Number(value) || 0));
}

function formatPercent(value) {
  // clamp displayed percentages so malformed source values cannot exceed 0–100%
  const number = Number(value);
  return numberFormat.format(Math.round(Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0))));
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

function safeCameraFeedUrl(value, viewer) {
  try {
    const url = new URL(value);
    const allowedHost = viewer
      ? url.hostname === new URL(viewer.url).hostname
      : url.hostname === 'alertwest.live' || url.hostname === 'alertwest.com' || url.hostname.endsWith('.alertwest.com');
    return url.protocol === 'https:' && allowedHost
      ? url.href
      : '';
  } catch (_) {
    return '';
  }
}

async function resolveLegendRowsForExport(getLegendItems, basemap) {
  // current DOM state wins so hidden and unchecked layers stay out of the image
  const domRows = readLegendRowsFromDom();
  const rows = domRows.length
    ? domRows
    : normalizeLegendRows(typeof getLegendItems === 'function' ? getLegendItems() : []);
  const condensed = condenseCameraLegendRows(rows, {
    separateViewshedColors: Boolean(getSetting('separateViewshedColors')),
  });

  const viewshedIcon = EXPORT_VIEWSHED_ICONS[basemap] ?? EXPORT_VIEWSHED_ICONS.outdoors;
  return condensed.map((row) => (EXPORT_SHARED_COLOR_VIEWSHED_LABELS.has(row.label)
    ? { ...row, visual: { type: 'icon', src: viewshedIcon, outline: '#808080', size: 22 } }
    : row));
}

// a selected camera's viewshed sits under the viewshed rows; other selection rows follow the layers
function placeSelectedViewshedRow(layerRows, selectionRows) {
  const viewshedLabels = [EXPORT_SHARED_VIEWSHED_LABEL, ...Object.values(EXPORT_PROVIDER_VIEWSHED_LABELS)];
  const lastViewshedIndex = layerRows.findLastIndex(({ label }) => viewshedLabels.includes(label));
  const selectedViewsheds = selectionRows.filter(({ label }) => label.endsWith(' viewshed'));
  if (lastViewshedIndex < 0 || !selectedViewsheds.length) return [...layerRows, ...selectionRows];
  return [
    ...layerRows.slice(0, lastViewshedIndex + 1),
    ...selectedViewsheds,
    ...layerRows.slice(lastViewshedIndex + 1),
    ...selectionRows.filter((row) => !selectedViewsheds.includes(row)),
  ];
}

// the map legend nests provider rows under group checkboxes; the export lists each symbol once
export function condenseCameraLegendRows(rows, { separateViewshedColors = false } = {}) {
  const labels = new Set(rows.map(({ label }) => label));
  const hasProviderCameras = labels.has(LEGEND_LAYERS.alertWestCameras) ||
    labels.has(LEGEND_LAYERS.panoCameras) ||
    labels.has(LEGEND_LAYERS.enviroVisionCameras);
  const providerViewsheds = rows.filter(({ label }) => label in EXPORT_PROVIDER_VIEWSHED_LABELS);

  const condensed = [];
  let sharedViewshedsAdded = false;
  for (const row of rows) {
    // provider rows already carry the camera symbology
    if (row.label === LEGEND_LAYERS.cameras && hasProviderCameras) continue;

    const isViewshedGroup = row.label === LEGEND_LAYERS.viewsheds;
    const isProviderViewshed = row.label in EXPORT_PROVIDER_VIEWSHED_LABELS;
    if (!isViewshedGroup && !isProviderViewshed) {
      condensed.push(row);
      continue;
    }

    if (separateViewshedColors) {
      // each provider keeps its own color, so the group row adds nothing
      if (isProviderViewshed) {
        condensed.push({ ...row, label: EXPORT_PROVIDER_VIEWSHED_LABELS[row.label] });
      } else if (!providerViewsheds.length) {
        condensed.push({ ...row, label: EXPORT_SHARED_VIEWSHED_LABEL });
      }

      continue;
    }

    // matching colors need a single row, drawn with the swatch the map is using
    if (sharedViewshedsAdded) continue;
    sharedViewshedsAdded = true;
    condensed.push({
      label: EXPORT_SHARED_VIEWSHED_LABEL,
      visual: providerViewsheds[0]?.visual || row.visual,
    });
  }

  return condensed;
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

    if (swatch.classList.contains('legend-swatch--line')) {
      return { type: 'swatch', style: 'line', color };
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
