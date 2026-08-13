/**
 * rebuilds layer controls and applies each initial visibility
 * one item may control several Mapbox layer IDs
 */
export function initLegend(map, items) {
  const legend = document.getElementById('legend');
  if (!legend) {
    throw new Error('Legend container #legend is missing');
  }

  legend.replaceChildren();

  const title = document.createElement('h2');
  title.className = 'legend-title';
  title.textContent = 'Layers';
  legend.append(title);

  for (const item of items) {
    legend.append(createLegendRow(map, item));
  }
}

function createLegendRow(map, item) {
  const row = document.createElement('label');
  row.className = 'legend-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = item.visible !== false;
  checkbox.addEventListener('change', () => {
    setLayersVisible(map, item.layerIds, checkbox.checked);
  });

  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.dataset.shape = item.shape || 'circle';
  swatch.style.setProperty('--swatch-color', item.color);

  if (item.icon) {
    const icon = document.createElement('i');
    icon.className = item.icon;
    icon.setAttribute('aria-hidden', 'true');
    swatch.append(icon);
  }

  const label = document.createElement('span');
  label.textContent = item.label;

  row.append(checkbox, swatch, label);

  // keep controls and Mapbox state aligned from first render
  setLayersVisible(map, item.layerIds, checkbox.checked);

  return row;
}

function setLayersVisible(map, layerIds, visible) {
  const visibility = visible ? 'visible' : 'none';

  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}
