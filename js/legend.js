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
  const topLevelBindings = [];
  let activeMap;

  const title = document.createElement('h2');
  title.className = 'legend-title';
  title.textContent = 'Map layers';
  legend.append(title);

  const groupBindings = [];
  for (const item of items) {
    if (Array.isArray(item.children) && item.children.length > 0) {
      const group = createLegendGroup(item, () => activeMap);
      bindings.push(group.parent, ...group.children);
      groupBindings.push(group);
      group.element.hidden = item.hidden === true;
      topLevelBindings.push({ item, element: group.element });
      legend.append(group.element);
      continue;
    }

    const binding = createLegendRow(item, () => activeMap);
    bindings.push(binding);
    binding.row.hidden = item.hidden === true;
    topLevelBindings.push({ item, element: binding.row });
    legend.append(binding.row);
  }

  const findBinding = (label) =>
    bindings.find(({ item }) => item.label === label);

  return {
    connect(map) {
      activeMap = map;

      // honor the current checkbox state, including changes made while loading
      for (const { checkbox, item } of bindings) {
        setLayersVisible(map, item.layerIds, checkbox.checked);
      }
      for (const group of groupBindings) group.syncParent();
    },

    setHidden(label, hidden) {
      const binding = topLevelBindings.find(({ item }) => item.label === label);
      if (!binding) return;
      binding.element.hidden = hidden;
    },

    updateInfo(label, text) {
    // info button for layers that require additional info
      const infoButton = findBinding(label)?.infoButton;
      if (!infoButton) return;
      infoButton.dataset.tooltip = text;
      infoButton.setAttribute('aria-label', text);
    },

    updateSwatchColor(label, color, { darkOutline = false } = {}) {
    // switch color, primarily used for camera viewsheds when switching to satellite
      const swatch = findBinding(label)?.swatch;
      if (!swatch) return;
      swatch.style.setProperty('--legend-swatch-color', color);
      swatch.classList.toggle('legend-swatch--dark-outline', darkOutline);
    },

    setLoading(label, loading) {
      // set loading if we're having trouble pinging a layer
      const visual = findBinding(label)?.visual;
      if (!visual) return;

      visual.classList.toggle('legend-visual--loading', loading);
      if (loading) {
        visual.setAttribute('role', 'status');
        visual.setAttribute('aria-label', `Loading ${label}`);
      } else if (!visual.classList.contains('legend-visual--error')) {
        visual.removeAttribute('role');
        visual.removeAttribute('aria-label');
      }
    },

    setError(label, message) {
      // set an error symbol if the layer failed to load
      const visual = findBinding(label)?.visual;
      if (!visual) return;

      visual.classList.remove('legend-visual--loading');
      visual.classList.add('legend-visual--error');
      visual.dataset.tooltip = message;
      visual.setAttribute('aria-label', message);
      visual.removeAttribute('role');
      visual.tabIndex = 0;
    },
  };
}

function createLegendGroup(item, getMap) {
  // create groups in the legend
  // currently being used for digitized camera operations
  const element = document.createElement('section');
  element.className = 'legend-group';

  let children = [];

  const parent = createLegendRow(item, getMap, (checked, map) => {
    for (const child of children) {
      child.checkbox.checked = checked;

      if (map) setLayersVisible(map, child.item.layerIds, checked);
    }
    syncParent();
  });
  
  parent.row.classList.add('legend-group__parent');
  element.append(parent.row);

  if (Array.isArray(item.keyItems)) {
    const key = document.createElement('div');
    key.className = 'legend-group__key';

    for (const keyItem of item.keyItems) {
      const entry = document.createElement('span');
      entry.className = 'legend-group__key-item';

      const symbol = document.createElement('span');
      symbol.className =
        `legend-camera-symbol legend-camera-symbol--${keyItem.shape}`;
      symbol.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.textContent = keyItem.label;
      entry.append(symbol, label);
      key.append(entry);
    }

    element.append(key);
  }

  const childContainer = document.createElement('div');
  childContainer.className = 'legend-group__children';
  children = item.children.map((childItem) => {
    const child = createLegendRow(childItem, getMap, (checked, map) => {
      if (map) setLayersVisible(map, childItem.layerIds, checked);
      syncParent();
    });
    child.row.classList.add('legend-group__child');
    childContainer.append(child.row);
    return child;
  });
  element.append(childContainer);

  parent.checkbox.setAttribute(
    'aria-controls',
    children.map(({ checkbox }) => checkbox.id).join(' ')
  );

  function syncParent() {
    const checkedCount = children.filter(({ checkbox }) => checkbox.checked).length;
    parent.checkbox.checked = checkedCount === children.length;
    parent.checkbox.indeterminate = checkedCount > 0 && checkedCount < children.length;
  }

  syncParent();
  return { element, parent, children, syncParent };
}

// builds the paired boundary controls
export function initDivisionFilter(config) {
  const legend = document.getElementById('legend');
  if (!legend) {
    throw new Error('Legend container #legend is missing');
  }

  const {
    types,
    loadOptions,
    onTypeSelected = () => {},
    onDivisionSelected,
    onClear,
  } = config;
  const control = document.createElement('div');
  control.className = 'legend-division-filter';

  const parentRow = createDivisionFilterRow(
    'Filter by',
    'legend-division-filter-type',
    'Select a boundary'
  );
  const divisionRow = createDivisionFilterRow(
    'Division/County',
    'legend-division-filter-division',
    'Select a filter first'
  );
  divisionRow.select.disabled = true;
  const status = document.createElement('div');
  status.className = 'legend-division-filter__status';
  status.id = 'legend-division-filter-status';
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  parentRow.select.setAttribute('aria-describedby', status.id);
  divisionRow.select.setAttribute('aria-describedby', status.id);

  for (const type of types) {
    const option = document.createElement('option');
    option.value = type.value;
    option.textContent = type.label;
    parentRow.select.append(option);
  }
  parentRow.select.value = '';

  control.append(parentRow.row, divisionRow.row, status);
  legend.append(control);

  let activeMap;
  let requestId = 0;

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle('legend-division-filter__status--error', isError);
    if (isError) {
      status.setAttribute('role', 'alert');
    } else {
      status.setAttribute('role', 'status');
    }
  };

  const resetDivision = (placeholder = 'Select a filter first') => {
    divisionRow.select.replaceChildren(createOption('', placeholder));
    divisionRow.select.disabled = true;
  };

  const clearFilter = () => {
    requestId += 1;
    parentRow.select.value = '';
    resetDivision();
    setStatus('');
  };

  const loadDivisions = async () => {
    const typeValue = parentRow.select.value;
    const map = activeMap;
    const currentRequestId = ++requestId;

    resetDivision(typeValue ? 'Loading…' : 'Select a filter first');
    setStatus(typeValue ? 'Loading…' : '');
    if (!typeValue) {
      if (map) onClear(map);
      return;
    }
    if (!map) return;
    onClear(map);

    try {
      const options = await loadOptions(map, typeValue);
      if (currentRequestId !== requestId) return;

      divisionRow.select.replaceChildren(
        createOption('', 'Select a county'),
        ...options.map((optionItem) =>
          createOption(optionItem.value, optionItem.label)
        )
      );
      divisionRow.select.disabled = false;
      setStatus('');
      onTypeSelected(map, typeValue);
    } catch {
      if (currentRequestId !== requestId) return;

      resetDivision('County data unavailable');
      setStatus('County data unavailable', true);
      onClear(map);
    }
  };

  parentRow.select.addEventListener('change', loadDivisions);
  divisionRow.select.addEventListener('change', () => {
    if (!activeMap) return;
    onDivisionSelected(
      activeMap,
      parentRow.select.value,
      divisionRow.select.value
    );
  });

  return {
    connect(map) {
      activeMap = map;
      if (parentRow.select.value) loadDivisions();
    },

    reset() {
      clearFilter();
      if (activeMap) onClear(activeMap);
    },

    select(typeValue, divisionValue) {
      if (
        !activeMap ||
        parentRow.select.value !== typeValue ||
        divisionRow.select.disabled
      ) {
        return false;
      }

      const hasOption = Array.from(divisionRow.select.options).some(
        (option) => option.value === divisionValue
      );
      if (!hasOption) return false;

      divisionRow.select.value = divisionValue;
      onDivisionSelected(activeMap, typeValue, divisionValue);
      return true;
    },
  };
}

function createDivisionFilterRow(labelText, id, placeholder) {
  const row = document.createElement('div');
  row.className = 'legend-division-filter__row';

  const label = document.createElement('label');
  label.className = 'legend-division-filter__label';
  label.htmlFor = id;
  label.textContent = labelText;

  const select = document.createElement('select');
  select.className = 'legend-division-filter__control';
  select.id = id;
  select.append(createOption('', placeholder));

  row.append(label, select);
  return { row, select };
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function createLegendRow(item, getMap, onToggle) {
  const row = document.createElement('div');
  row.className = 'legend-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `legend-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  checkbox.checked = item.visible !== false;
  checkbox.addEventListener('change', () => {
    const map = getMap();
    if (onToggle) {
      onToggle(checkbox.checked, map);
    } else if (map) {
      setLayersVisible(map, item.layerIds, checkbox.checked);
    }
  });

  const swatch = item.swatchColor ? createLegendSwatch(item) : null;
  const icon =
    createCameraLegendIcon(item) ?? swatch ?? createLegendIcon(item.iconUrl);
  const visual = createLegendVisual(icon, item.loading === true, item.label);

  const label = document.createElement('span');
  label.textContent = item.label;

  const labelText = document.createElement('label');
  labelText.htmlFor = checkbox.id;
  labelText.className = 'legend-label';
  labelText.append(label);

  row.append(checkbox, visual);

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
  return { checkbox, infoButton, item, row, swatch, visual };
}

function createCameraLegendIcon(item) {
  if (Array.isArray(item.groupColors)) {
    const icon = document.createElement('span');
    icon.className = 'legend-camera-group-symbol';
    icon.setAttribute('aria-hidden', 'true');
    for (const color of item.groupColors) {
      const colorBlock = document.createElement('span');
      colorBlock.style.background = color;
      icon.append(colorBlock);
    }
    return icon;
  }

  if (!item.markerColor) return null;

  const icon = document.createElement('span');
  icon.className = 'legend-camera-symbols';
  icon.style.setProperty('--legend-marker-color', item.markerColor);
  icon.setAttribute('aria-hidden', 'true');

  for (const shape of item.markerShapes || ['triangle', 'circle']) {
    const symbol = document.createElement('span');
    symbol.className = `legend-camera-symbol legend-camera-symbol--${shape}`;
    icon.append(symbol);
  }
  return icon;
}

function createLegendVisual(icon, loading, label) {
  const visual = document.createElement('span');
  visual.className = 'legend-visual';

  const loader = document.createElement('span');
  loader.className = 'legend-loader';
  loader.setAttribute('aria-hidden', 'true');

  const error = document.createElement('span');
  error.className = 'legend-error';
  error.textContent = '!';
  error.setAttribute('aria-hidden', 'true');

  visual.append(icon, loader, error);
  if (loading) {
    visual.classList.add('legend-visual--loading');
    visual.setAttribute('role', 'status');
    visual.setAttribute('aria-label', `Loading ${label}`);
  }

  return visual;
}

function createLegendIcon(iconUrl) {
  const icon = document.createElement('img');
  icon.className = 'legend-icon';
  icon.src = iconUrl;
  icon.alt = '';
  return icon;
}

function createLegendSwatch(item) {
  const swatch = document.createElement('span');
  const classes = ['legend-swatch'];
  if (item.swatchShape === 'circle') classes.push('legend-swatch--circle');
  if (item.swatchBorder === false) classes.push('legend-swatch--fill');
  if (item.swatchClass) classes.push(item.swatchClass);
  swatch.className = classes.join(' ');
  swatch.style.setProperty('--legend-swatch-color', item.swatchColor);
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
