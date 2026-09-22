/**
 * renders controls immediately, then connects them after Mapbox layers exist
 * one item may control several Mapbox layer IDs
 * grouped items keep one parent checkbox synchronized with their child layers
 * hidden top-level items stay bound for later reveal but do not occupy the legend DOM
 */
export function initLegend(items) {
  const legend = document.getElementById('legend');
  if (!legend) {
    throw new Error('Legend container #legend is missing');
  }

  // rebuild the visible list before providers and map layers finish loading
  legend.replaceChildren();
  // keep a flat label lookup for row updates and a separate ordered list for DOM placement
  const bindings = [];
  const topLevelBindings = [];
  // one delegated tooltip controller handles buttons added with each row
  const infoTooltip = createLegendTooltip(legend);
  let activeMap;

  const title = document.createElement('h2');
  title.className = 'legend-title';
  title.textContent = 'Map layers';
  legend.append(title);

  const groupBindings = [];
  for (const item of items) {
    if (Array.isArray(item.children) && item.children.length > 0) {
      // groups contribute their parent and each child to the same update lookup
      const group = createLegendGroup(item, () => activeMap);
      bindings.push(group.parent, ...group.children);
      groupBindings.push(group);
      group.element.hidden = item.hidden === true;
      topLevelBindings.push({ item, element: group.element });
      // omitted rows can be inserted later at their original position
      if (!group.element.hidden) legend.append(group.element);
      continue;
    }

    const binding = createLegendRow(item, () => activeMap);
    bindings.push(binding);
    binding.row.hidden = item.hidden === true;
    topLevelBindings.push({ item, element: binding.row });
    // keep initially hidden controls out of layout and accessibility navigation
    if (!binding.row.hidden) legend.append(binding.row);
  }

  const findBinding = (label) =>
    bindings.find(({ item }) => item.label === label);

  return {
    connect(map) {
      activeMap = map;

      // checkboxes may have changed before the map was ready, so apply their current state now
      for (const { checkbox, item } of bindings) {
        setLayersVisible(map, item.layerIds, checkbox.checked);
      }
      for (const group of groupBindings) group.syncParent();
    },

    setHidden(label, hidden) {
      const binding = topLevelBindings.find(({ item }) => item.label === label);
      if (!binding) return;
      binding.element.hidden = hidden;
      if (hidden) {
        // a detached row cannot keep a tooltip visible at its old screen position
        if (infoTooltip.isFor(binding.element)) infoTooltip.hide();
        // remove from layout and accessibility navigation until explicitly revealed
        binding.element.remove();
        return;
      }
      if (binding.element.parentElement === legend) return;

      // reinsert before the next visible sibling to preserve the configured layer order
      const next = topLevelBindings
        .slice(topLevelBindings.indexOf(binding) + 1)
        .find(({ element }) => element.parentElement === legend)?.element;
      legend.insertBefore(binding.element, next ?? null);
    },

    updateInfo(label, text) {
      // only rows with provider notes get a tooltip trigger
      const infoButton = findBinding(label)?.infoButton;
      if (!infoButton) return;
      // keep the accessible name and hover text sourced from the same provider message
      infoButton.dataset.tooltip = text;
      infoButton.setAttribute('aria-label', text);
      infoTooltip.refresh(infoButton);
    },

    updateSwatchColor(label, color, { darkOutline = false } = {}) {
      // viewshed colors change with the selected basemap
      const swatch = findBinding(label)?.swatch;
      if (!swatch) return;
      // CSS variables let one swatch style follow runtime basemap changes
      swatch.style.setProperty('--legend-swatch-color', color);
      swatch.classList.toggle('legend-swatch--dark-outline', darkOutline);
    },

    setLoading(label, loading) {
      // keep slow provider loads visible in the layer list
      const visual = findBinding(label)?.visual;
      if (!visual) return;

      visual.classList.toggle('legend-visual--loading', loading);
      if (loading) {
        // announce the provider state through the visual beside its layer label
        visual.setAttribute('role', 'status');
        visual.setAttribute('aria-label', `Loading ${label}`);
      } else if (!visual.classList.contains('legend-visual--error')) {
        // keep error semantics if a retry clears only the loading state
        visual.removeAttribute('role');
        visual.removeAttribute('aria-label');
      }
    },

    setError(label, message) {
      // keep provider failures visible without interrupting map use
      const visual = findBinding(label)?.visual;
      if (!visual) return;

      visual.classList.remove('legend-visual--loading');
      visual.classList.add('legend-visual--error');
      // the visual is keyboard reachable because its tooltip contains the failure detail
      visual.dataset.tooltip = message;
      visual.setAttribute('aria-label', message);
      visual.removeAttribute('role');
      visual.tabIndex = 0;
    },
  };
}

function createLegendTooltip(legend) {
  if (!document.body?.append) {
    // keep legend updates safe in partial DOMs such as static render tests
    return { hide() {}, isFor() { return false; }, refresh() {} };
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'legend-tooltip';
  tooltip.id = 'legend-info-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  // fixed positioning lets the tooltip escape clipped and scrolling legend containers
  document.body.append(tooltip);

  let activeButton = null;
  // gap and viewport clearance are in CSS pixels because rects and fixed offsets use screen pixels
  const gap = 8;
  const margin = 8;

  // events bubble from the icon too, so resolve the owning trigger from any descendant
  const buttonFrom = (target) =>
    target instanceof Element ? target.closest('.legend-info') : null;

  const hide = () => {
    // release the element reference so later resize events do no work
    activeButton = null;
    tooltip.hidden = true;
  };

  const refresh = (button) => {
    // detached buttons have no useful viewport position
    if (!button || !button.isConnected) return;
    activeButton = button;
    tooltip.textContent = button.dataset.tooltip || '';
    tooltip.hidden = false;
    // cap width before measuring so placement uses the final wrapped dimensions
    tooltip.style.maxWidth = `${Math.max(64, Math.min(240, window.innerWidth - button.getBoundingClientRect().right - gap - margin))}px`;

    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    // place beside the button and keep the top and right edges inside viewport margins
    const left = Math.min(
      buttonRect.right + gap,
      window.innerWidth - tooltipRect.width - margin
    );
    const top = Math.max(
      margin,
      Math.min(
        buttonRect.top + (buttonRect.height - tooltipRect.height) / 2,
        window.innerHeight - tooltipRect.height - margin
      )
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  // delegated pointer and focus handlers cover current and future legend rows
  legend.addEventListener('pointerover', (event) => {
    const button = buttonFrom(event.target);
    if (button) refresh(button);
  });
  legend.addEventListener('pointerout', (event) => {
    const button = buttonFrom(event.target);
    // movement between the icon and button contents is still inside one trigger
    if (!button || button.contains(event.relatedTarget)) return;
    // retain the message while keyboard focus or the pointer still owns the trigger
    if (!button.matches(':hover, :focus')) hide();
  });
  legend.addEventListener('focusin', (event) => {
    const button = buttonFrom(event.target);
    if (button) refresh(button);
  });
  legend.addEventListener('focusout', (event) => {
    const button = buttonFrom(event.target);
    if (!button || button.contains(event.relatedTarget)) return;
    // a pointer hover can outlive keyboard focus
    if (!button.matches(':hover')) hide();
  });
  // keep the fixed tooltip aligned if its trigger moves with the viewport or list scroll
  window.addEventListener('resize', () => {
    if (activeButton) refresh(activeButton);
  });
  legend.addEventListener('scroll', () => {
    if (activeButton) refresh(activeButton);
  });
  document.addEventListener('keydown', (event) => {
    // escape dismisses without changing focus
    if (event.key === 'Escape' && activeButton) hide();
  });

  return {
    hide,
    isFor(element) {
      // groups contain child triggers, so hiding a group also clears a child tooltip
      return activeButton != null && element.contains(activeButton);
    },
    refresh(button) {
      // update an open message in place without reopening an unrelated tooltip
      if (button === activeButton) refresh(button);
    },
  };
}

function createLegendGroup(item, getMap) {
  // group rows keep provider toggles under one parent
  const element = document.createElement('section');
  element.className = 'legend-group';

  // children are assigned below before the parent callback can be triggered by the user
  let children = [];

  const parent = createLegendRow(item, getMap, (checked, map) => {
    // parent changes apply to every child layer as one operation
    for (const child of children) {
      child.checkbox.checked = checked;

      if (map) setLayersVisible(map, child.item.layerIds, checked);
    }
    syncParent();
  });
  
  parent.row.classList.add('legend-group__parent');
  element.append(parent.row);

  if (Array.isArray(item.keyItems)) {
    // show the shape or color key once above the grouped provider rows
    const key = document.createElement('div');
    key.className = 'legend-group__key';

    for (const keyItem of item.keyItems) {
      const entry = document.createElement('span');
      entry.className = 'legend-group__key-item';

      const symbol = document.createElement('span');
      symbol.className =
        `legend-camera-symbol legend-camera-symbol--${keyItem.shape}`;
      // the text label carries the meaning; the shape is only a visual cue
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
      // a child toggle changes only its own map layers, then recomputes the parent state
      if (map) setLayersVisible(map, childItem.layerIds, checked);
      syncParent();
    });
    child.row.classList.add('legend-group__child');
    childContainer.append(child.row);
    return child;
  });
  element.append(childContainer);

  // expose every child toggle through the parent checkbox's controlled-elements list
  parent.checkbox.setAttribute(
    'aria-controls',
    children.map(({ checkbox }) => checkbox.id).join(' ')
  );

  function syncParent() {
    const checkedCount = children.filter(({ checkbox }) => checkbox.checked).length;
    // indeterminate communicates a partial child selection to both sighted and screen-reader users
    parent.checkbox.checked = checkedCount === children.length;
    parent.checkbox.indeterminate = checkedCount > 0 && checkedCount < children.length;
  }

  syncParent();
  return { element, parent, children, syncParent };
}

function createLegendRow(item, getMap, onToggle) {
  const row = document.createElement('div');
  row.className = 'legend-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `legend-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  checkbox.checked = item.visible !== false;
  checkbox.addEventListener('change', () => {
    // map setup is deferred, so store checkbox state in the DOM until connect applies it
    const map = getMap();
    if (onToggle) {
      onToggle(checkbox.checked, map);
    } else if (map) {
      setLayersVisible(map, item.layerIds, checkbox.checked);
    }
  });

  // camera markers take precedence over generic swatches, then fall back to a remote icon
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
    // the button label supplies the provider note to assistive technology
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
    // grouped markers summarize more than one provider color in a single legend row
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

  // one marker color can be paired with one or more shapes
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
  // decorative indicator; the visual wrapper carries the status text
  loader.setAttribute('aria-hidden', 'true');

  const error = document.createElement('span');
  error.className = 'legend-error';
  error.textContent = '!';
  // error text is repeated in the wrapper's accessible label
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
  // checkbox and visible label already name the layer
  icon.alt = '';
  return icon;
}

function createLegendSwatch(item) {
  const swatch = document.createElement('span');
  const classes = ['legend-swatch'];
  // shape, border and extra classes let CSS distinguish fills from point marks
  if (item.swatchShape === 'circle') classes.push('legend-swatch--circle');
  if (item.swatchBorder === false) classes.push('legend-swatch--fill');
  if (item.swatchClass) classes.push(item.swatchClass);
  swatch.className = classes.join(' ');
  swatch.style.setProperty('--legend-swatch-color', item.swatchColor);
  swatch.setAttribute('aria-hidden', 'true');
  return swatch;
}

function setLayersVisible(map, layerIds, visible) {
  // Mapbox visibility is expressed as a layout value, not a boolean
  const visibility = visible ? 'visible' : 'none';

  for (const layerId of layerIds) {
    // some configured layers are optional or not installed at this map state
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}
