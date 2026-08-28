/**
 * renders controls immediately, then connects them after Mapbox layers exist
 * one item may control several Mapbox layer IDs
 */
export function initLegend(items) {
  const legend = document.getElementById('legend');
  if (!legend) {
    throw new Error('Legend container #legend is missing');
  }

  legend.replaceChildren();
  const bindings = [];
  let activeMap;

  const title = document.createElement('h2');
  title.className = 'legend-title';
  title.textContent = 'Map layers';
  legend.append(title);

  for (const item of items) {
    const binding = createLegendRow(item, () => activeMap);
    bindings.push(binding);
    legend.append(binding.row);
  }

  return {
    connect(map) {
      activeMap = map;

      // honor the current checkbox state, including changes made while loading
      for (const { checkbox, item } of bindings) {
        setLayersVisible(map, item.layerIds, checkbox.checked);
      }
    },
    updateInfo(label, text) {
      const binding = bindings.find(({ item }) => item.label === label);
      if (!binding?.infoButton) return;
      binding.infoButton.dataset.tooltip = text;
      binding.infoButton.setAttribute('aria-label', text);
    },
  };
}

function createLegendRow(item, getMap) {
  const row = document.createElement('div');
  row.className = 'legend-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `legend-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  checkbox.checked = item.visible !== false;
  checkbox.addEventListener('change', () => {
    const map = getMap();
    if (map) setLayersVisible(map, item.layerIds, checkbox.checked);
  });

  const icon = item.swatchColor
    ? createLegendSwatch(item.swatchColor)
    : createLegendIcon(item.iconUrl);

  const label = document.createElement('span');
  label.textContent = item.label;

  const labelText = document.createElement('label');
  labelText.htmlFor = checkbox.id;
  labelText.className = 'legend-label';
  labelText.append(label);

  row.append(checkbox, icon);

  let infoButton;
  if (item.infoText !== undefined) {
    infoButton = document.createElement('button');
    infoButton.type = 'button';
    infoButton.className = 'legend-info';
    infoButton.innerHTML = '<i class="fa-regular fa-circle-info" aria-hidden="true"></i>';
    infoButton.dataset.tooltip = item.infoText;
    infoButton.setAttribute('aria-label', item.infoText);
    infoButton.addEventListener('click', (event) => event.stopPropagation());
  }

  row.append(labelText);
  if (infoButton) row.append(infoButton);
  return { checkbox, infoButton, item, row };
}

function createLegendIcon(iconUrl) {
  const icon = document.createElement('img');
  icon.className = 'legend-icon';
  icon.src = iconUrl;
  icon.alt = '';
  return icon;
}

function createLegendSwatch(color) {
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.setProperty('--legend-swatch-color', color);
  swatch.setAttribute('aria-hidden', 'true');
  return swatch;
}

function setLayersVisible(map, layerIds, visible) {
  const visibility = visible ? 'visible' : 'none';

  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}
