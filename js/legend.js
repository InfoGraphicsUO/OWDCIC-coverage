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
  };
}

function createLegendRow(item, getMap) {
  const row = document.createElement('label');
  row.className = 'legend-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = item.visible !== false;
  checkbox.addEventListener('change', () => {
    const map = getMap();
    if (map) setLayersVisible(map, item.layerIds, checkbox.checked);
  });

  // legend reuses each layer's map marker file so the two always match
  const icon = document.createElement('img');
  icon.className = 'legend-icon';
  icon.src = item.iconUrl;
  icon.alt = '';

  const label = document.createElement('span');
  label.textContent = item.label;

  row.append(checkbox, icon, label);
  return { checkbox, item, row };
}

function setLayersVisible(map, layerIds, visible) {
  const visibility = visible ? 'visible' : 'none';

  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}
