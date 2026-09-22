/**
 * builds the two-step filter menu
 * list and map picks share the same callbacks
 * callbacks: onTypeSelected(type), onSelection(type, id), onClear()
 * onTypeSelected gets null while options load, then the selected type
 * select(type, id) is the programmatic path used by map feature clicks
 * option data stays cached after a successful load for the life of this panel
 */
export function initFilterPanel({
  types = [],
  loadOptions,
  onTypeSelected = () => {},
  onSelection = () => {},
  onClear = () => {},
} = {}) {
  const root = document.getElementById('filter-panel');
  if (!root) throw new Error('Filter panel container #filter-panel is missing');
  if (typeof loadOptions !== 'function') throw new TypeError('loadOptions must be a function');

  // rebuild the panel contents while keeping its outer shell in the page
  root.replaceChildren();
  const shellApi = bindControlShell();

  // selection state belongs to this panel instance, while request ids fence off stale async work
  let activeType = null;
  let activeId = null;
  let options = [];
  let requestId = 0;
  let globalSearchId = 0;
  const optionsCache = new Map();

  const header = document.createElement('div');
  header.className = 'filter-panel__header';

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'filter-panel__back';
  // icon is decorative; the text label remains available to assistive technology
  backButton.setAttribute('aria-label', 'Back to filter types');
  backButton.innerHTML = '<i class="fa-solid fa-arrow-left" aria-hidden="true"></i>';

  const title = document.createElement('h2');
  title.className = 'filter-panel__title';
  title.textContent = 'Filter by';

  header.append(backButton, title);

  const status = document.createElement('p');
  status.className = 'filter-panel__status';
  // loading and empty-state updates are announced without moving focus
  status.setAttribute('aria-live', 'polite');

  // the first view searches type names and option names across all categories
  const categoryView = document.createElement('div');
  categoryView.className = 'filter-panel__view';
  const categorySearch = makeSearch('Search options...', 'filter-category-search');
  const categoryList = makeList('filter-category-list', 'Filter types');
  categoryView.append(categorySearch.wrapper, categoryList);

  // the second view narrows choices to the currently selected type
  const optionView = document.createElement('div');
  optionView.className = 'filter-panel__view';
  optionView.hidden = true;
  const optionSearch = makeSearch('Search options...', 'filter-option-search');
  const optionList = makeList('filter-option-list', 'Filter options');
  optionView.append(optionSearch.wrapper, optionList);
  const viewFade = createPanelFade([categoryView, optionView]);

  // use the page-level clear control when the layout already provides one
  const clearButton = document.getElementById('filter-clear') ?? makeClearButton();
  if (!clearButton.id) root.append(header, status, categoryView, optionView, clearButton);
  else root.append(header, status, categoryView, optionView);

  const setStatus = (text, error = false) => {
    status.textContent = text;
    // error styling stays on the live region so status text remains readable
    status.classList.toggle('is-error', error);
  };

  const setOptionSearchLabel = (text) => {
    optionSearch.input.placeholder = text;
    optionSearch.input.setAttribute('aria-label', text);
  };

  const showCategoryView = ({ animate = true } = {}) => {
    title.textContent = 'Filter by';
    backButton.classList.remove('is-visible');
    // render again so the current search term and active type are reflected
    viewFade.show(categoryView, { animate });
    renderCategories();
  };

  const showOptionView = ({ animate = true } = {}) => {
    title.textContent = activeType ? `Filter by ${activeType.label}` : 'Filter by';
    backButton.classList.add('is-visible');
    viewFade.show(optionView, { animate });
    // give the search field a useful accessible name for the current category
    setOptionSearchLabel(
      activeType ? `Search ${activeType.label} options...` : 'Search options...'
    );
  };

  const ensureOptionsLoaded = async (typeValue) => {
    if (optionsCache.has(typeValue)) return optionsCache.get(typeValue);
    // normalize malformed provider responses once and reuse successful results on later views
    const loaded = await loadOptions(typeValue);
    const normalized = Array.isArray(loaded) ? loaded : [];
    optionsCache.set(typeValue, normalized);
    return normalized;
  };

  const renderCategories = () => {
    const query = categorySearch.input.value.trim().toLowerCase();
    if (!query) {
      // an empty category query keeps the fast, type-only drilldown
      renderItems(categoryList, types, activeType?.value, (type) => chooseType(type), {
        stepped: true,
      });
      setStatus('');
      return;
    }

    // a category query is global and may match labels from unloaded option sets
    renderGlobalSearch(query);
  };

  const renderGlobalSearch = async (query) => {
    // each keystroke supersedes pending searches, including their eventual DOM writes
    const searchId = ++globalSearchId;
    const matchingTypes = types.filter((type) => `${type.label}`.toLowerCase().includes(query));
    categoryList.replaceChildren();
    // keep assistive technology aware that results are being assembled
    categoryList.setAttribute('aria-busy', 'true');
    setStatus('Searching…');

    // search options in every type so users dont need to know the right category first
    const optionMatches = [];
    await Promise.all(types.map(async (type) => {
      try {
        const loaded = await ensureOptionsLoaded(type.value);
        if (searchId !== globalSearchId) return;
        loaded
          .filter((option) => optionMatchesQuery(option, query))
          .forEach((option) => optionMatches.push({ type, option }));
      } catch (error) {
        // keep other categories searchable when one provider request fails
        console.error(`Unable to load options for ${type.value}:`, error);
      }
    }));

    // a slower earlier query must not overwrite the results for the latest input
    if (searchId !== globalSearchId) return;
    categoryList.removeAttribute('aria-busy');

    // merge type and option hits, then sort together for one predictable result list
    const items = [
      ...matchingTypes.map((type) => ({
        value: `type:${type.value}`,
        label: type.label,
        meta: null,
        kind: 'type',
        type,
      })),
      ...optionMatches.map(({ type, option }) => ({
        value: `option:${type.value}:${option.value}`,
        label: searchResultOptionLabel(option, type.value),
        meta: type.label,
        kind: 'option',
        type,
        option,
      })),
    ].sort((a, b) => a.label.localeCompare(b.label));

    renderSearchResults(categoryList, items, activeId, async (item) => {
      if (item.kind === 'type') {
        // type hits open the normal second step without selecting an option
        await chooseType(item.type);
        return;
      }
      // option hits skip the intermediate view and apply the exact matching option
      await chooseType(item.type, { focusSearch: false });
      await chooseOption(item.option);
      categorySearch.input.value = '';
    });

    if (!items.length) setStatus('No matches found.', true);
    else setStatus('');
  };

  const renderOptions = () => {
    const query = optionSearch.input.value.trim().toLowerCase();
    const visible = options.filter((option) => optionMatchesQuery(option, query));
    // district-like datasets carry state prefixes and need separate collapsible buckets
    if (activeType && STATE_SPLIT_TYPES.has(activeType.value)) {
      renderGroupedItems(optionList, visible, activeId, (option) => chooseOption(option), {
        query,
      });
    } else {
      renderItems(optionList, visible, activeId, (option) => chooseOption(option));
    }
    if (!visible.length && options.length) setStatus('No options match that search.', true);
    else setStatus('');
  };

  const chooseType = async (type, { focusSearch = true } = {}) => {
    if (activeType?.value === type.value && options.length) {
      // reopening the loaded category should preserve its current option selection
      showOptionView();
      renderOptions();
      if (focusSearch) optionSearch.input.focus();
      return;
    }

    // invalidate older category loads before changing the visible selection
    const request = ++requestId;
    activeType = type;
    activeId = null;
    options = [];
    groupExpandedState.set('Oregon', false);
    groupExpandedState.set('Washington', false);
    // choosing any category makes clearing available, even before an option is picked
    clearButton.disabled = false;
    optionSearch.input.value = '';
    showOptionView();
    optionList.replaceChildren();
    optionList.setAttribute('aria-busy', 'true');
    setStatus('Loading options…');
    // clear the previous map highlight while this category has no usable options
    await onTypeSelected(null);
    try {
      const loaded = await ensureOptionsLoaded(type.value);
      // selection may have changed while the provider request was in flight
      if (request !== requestId) return;
      options = loaded;
      renderOptions();
      await onTypeSelected(type.value);
      // focus only after the new options exist in the DOM
      if (focusSearch) optionSearch.input.focus();
    } catch (error) {
      // only the current request owns the visible error state
      if (request !== requestId) return;
      setStatus('Unable to load options. Try again.', true);
      optionList.replaceChildren();
      console.error('Unable to load filter options:', error);
    } finally {
      // stale requests must not clear the busy state of a newer request
      if (request === requestId) optionList.removeAttribute('aria-busy');
    }
  };

  const chooseOption = async (option) => {
    if (!activeType || !option) return;
    // update selection styling before the map callback finishes
    activeId = option.value;
    renderOptions();
    await onSelection(activeType.value, option.value);
  };

  const reset = async () => {
    // invalidate pending category loads and searches before clearing their UI
    requestId += 1;
    globalSearchId += 1;
    activeType = null;
    activeId = null;
    options = [];
    groupExpandedState.set('Oregon', false);
    groupExpandedState.set('Washington', false);
    categorySearch.input.value = '';
    optionSearch.input.value = '';
    // reset the category-specific search name with the visible category view
    setOptionSearchLabel('Search options...');
    clearButton.disabled = true;
    optionList.removeAttribute('aria-busy');
    categoryList.removeAttribute('aria-busy');
    setStatus('');
    showCategoryView({ animate: false });
    // let the caller remove map layers and restore its own dependent controls
    await onClear();
  };

  // searches rerender from current state, while selection callbacks own map updates
  categorySearch.input.addEventListener('input', renderCategories);
  optionSearch.input.addEventListener('input', renderOptions);
  backButton.addEventListener('click', () => {
    showCategoryView();
    // return focus to the search that led into this category
    categorySearch.input.focus();
  });
  clearButton.addEventListener('click', reset);
  renderCategories();

  const select = async (typeValue, id) => {
    // map-driven selections open the right tab without forcing the sidebar open
    shellApi?.openTab('filter', { expand: false });
    const type = types.find((entry) => entry.value === typeValue);
    if (!type) return false;
    if (!activeType || activeType.value !== typeValue) {
      await chooseType(type, { focusSearch: false });
    } else {
      showOptionView({ animate: false });
    }
    // reject a request whose category changed while its options were loading
    if (activeType?.value !== typeValue) return false;
    // provider ids may arrive as numbers from map features and strings from option data
    const option = options.find((entry) => `${entry.value}` === `${id}`);
    if (!option) return false;
    await chooseOption(option);
    return true;
  };

  return {
    select,
    reset,
    currentType: () => activeType?.value ?? null,
    setClearEnabled(enabled) {
      clearButton.disabled = !enabled;
    },
  };
}

function bindControlShell() {
  const shell = document.getElementById('control-sidebar');
  if (!shell) return null;
  // the panel and map layers can both ask for this API during startup
  if (shell.dataset.bound === 'true') {
    return shell._controlShellApi ?? null;
  }
  shell.dataset.bound = 'true';

  const tabs = [...shell.querySelectorAll('[data-control-tab]')];
  const menus = new Map(
    [...shell.querySelectorAll('.control-menu')].map((menu) => [menu.id.replace('-menu', ''), menu])
  );
  const menuFade = createPanelFade([...menus.values()]);
  const rail = shell.querySelector('.control-rail');
  const body = shell.querySelector('.control-shell__body');
  const collapse = shell.querySelector('.control-shell__collapse');

  // hide collapsed content from keyboard and assistive technology without disabling the rail
  const setCollapsed = (collapsed) => {
    shell.classList.toggle('is-collapsed', collapsed);
    body?.toggleAttribute('inert', collapsed);
    rail?.removeAttribute('inert');
    collapse?.setAttribute('aria-expanded', `${!collapsed}`);
    collapse?.setAttribute('aria-label', collapsed ? 'Expand map controls' : 'Collapse map controls');
    // move focus to the remaining visible control before collapsing the focused menu
    if (collapsed && (rail?.contains(document.activeElement) || body?.contains(document.activeElement))) {
      collapse?.focus();
    }
  };

  // tabs use roving focus so arrow keys move through one stop at a time
  const activateTab = (tab, { focus = false, expand = true } = {}) => {
    const selected = tab.dataset.controlTab;
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.classList.toggle('is-active', active);
      candidate.setAttribute('aria-selected', `${active}`);
      candidate.tabIndex = active ? 0 : -1;
    }
    // animate the selected menu and keep the class state in sync for layout styles
    menuFade.show(menus.get(selected));
    for (const [name, menu] of menus) {
      menu.classList.toggle('is-open', name === selected);
    }
    if (expand) setCollapsed(false);
    // clicks keep normal browser focus behavior; keyboard moves request focus explicitly
    if (focus) tab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      activateTab(tab, { expand: true });
    });
    tab.addEventListener('keydown', (event) => {
      const current = tabs.indexOf(tab);
      let next = -1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        next = (current + 1) % tabs.length;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        next = (current - 1 + tabs.length) % tabs.length;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = tabs.length - 1;
      }
      // unrelated keys retain the browser's default tab behavior
      if (next < 0) return;
      event.preventDefault();
      activateTab(tabs[next], { focus: true });
    });
  }

  collapse?.addEventListener('click', () => {
    setCollapsed(!shell.classList.contains('is-collapsed'));
  });

  const api = {
    openTab(name, options = {}) {
      const tab = tabs.find((item) => item.dataset.controlTab === name);
      if (tab) activateTab(tab, options);
    },
    collapse() {
      setCollapsed(true);
    },
  };
  shell._controlShellApi = api;
  return api;
}

function createPanelFade(panels) {
  // track outgoing panels separately so rapid view changes can finish cleanly
  let active = panels.find((panel) => !panel.hidden) ?? null;
  let leaving = null;
  let timer = null;

  const hide = (panel) => {
    panel.hidden = true;
    // hidden views must stop receiving focus and disappear from the accessibility tree
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    panel.classList.remove('is-entering', 'is-leaving');
  };

  return {
    show(next, { animate = true } = {}) {
      if (!next) return;
      // a new transition takes ownership of any pending cleanup timer
      if (timer) clearTimeout(timer);
      timer = null;
      if (leaving) hide(leaving);
      leaving = null;
      for (const panel of panels) panel.classList.remove('is-entering');
      if (active === next) return;

      // keep the outgoing panel mounted for its fade but remove it from interaction immediately
      const previous = active;
      active = next;
      next.hidden = false;
      next.inert = false;
      next.removeAttribute('aria-hidden');
      next.classList.remove('is-leaving');

      const fade = animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (previous && previous !== next) {
        previous.inert = true;
        previous.setAttribute('aria-hidden', 'true');
        if (fade && !previous.hidden) {
          previous.classList.add('is-leaving');
          leaving = previous;
        } else {
          hide(previous);
        }
      }
      if (fade) {
        next.classList.add('is-entering');
        // finish both entering and leaving classes after the matching CSS duration
        timer = setTimeout(() => {
          next.classList.remove('is-entering');
          if (leaving) hide(leaving);
          leaving = null;
          timer = null;
        }, 180);
      }
    },
  };
}

function makeClearButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'filter-panel__clear';
  button.textContent = 'Clear filter';
  button.disabled = true;
  return button;
}

function makeSearch(label, id) {
  // wrapping the input in its label keeps the visible and accessible names together
  const wrapper = document.createElement('label');
  wrapper.className = 'filter-panel__search';
  wrapper.setAttribute('for', id);
  const input = document.createElement('input');
  input.id = id;
  input.type = 'search';
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.autocomplete = 'off';
  // show the mobile keyboard's search action for this field
  input.enterKeyHint = 'search';
  wrapper.append(input);
  return { wrapper, input };
}

function makeList(id, label) {
  const list = document.createElement('div');
  list.id = id;
  list.className = 'filter-panel__list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  // one delegated key handler covers options recreated on each search
  list.addEventListener('keydown', (event) => moveListFocus(list, event));
  return list;
}

const STATE_SPLIT_TYPES = new Set(['county', 'house', 'senate', 'us-house']);
// these source labels carry state prefixes so similarly named districts stay distinct
const STATE_LABEL_PREFIX = /^(OR|WA)\s•\s*(.+)$/;

function displayOptionLabel(option) {
  const parsed = parseStateLabel(option);
  return parsed.displayLabel;
}

function searchResultOptionLabel(option, typeValue) {
  const parsed = parseStateLabel(option);
  if (!parsed.state || !STATE_SPLIT_TYPES.has(typeValue)) return parsed.displayLabel;
  // global results drop the source prefix, so add a short state cue back for disambiguation
  return `${parsed.displayLabel} (${parsed.state === 'Oregon' ? 'OR' : 'WA'})`;
}

function parseStateLabel(option) {
  // accept either an option object or a bare label from callers
  const label = `${option?.label ?? option ?? ''}`;
  const match = label.match(STATE_LABEL_PREFIX);
  // an explicit state field wins when the source also embeds a prefix in its label
  const state = normalizeStateAbbreviation(option?.state) || (match
    ? match[1]
    : null);
  return {
    state: state === 'OR' ? 'Oregon' : state === 'WA' ? 'Washington' : null,
    displayLabel: match ? match[2] : label,
  };
}

function normalizeStateAbbreviation(state) {
  // provider payloads use both postal abbreviations and full state names
  const value = `${state ?? ''}`.trim().toUpperCase();
  if (value === 'OR' || value === 'WA') return value;
  if (value === 'OREGON') return 'OR';
  if (value === 'WASHINGTON') return 'WA';
  return null;
}

function renderItems(list, items, selectedValue, onChoose, { stepped = false } = {}) {
  // replace old nodes so indices and labels stay aligned with the current filtered array
  list.replaceChildren();
  items.forEach((item, index) => {
    const selected = `${item.value}` === `${selectedValue}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${list.id}-option-${index}`;
    button.className = stepped ? 'filter-panel__item filter-panel__item--step' : 'filter-panel__item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', `${selected}`);
    // keep one option in the tab order, preferring the current selection
    button.tabIndex = selected || (selectedValue == null && index === 0) ? 0 : -1;
    button.textContent = item.displayLabel ?? item.label;
    button.addEventListener('click', () => onChoose(item));
    list.append(button);
  });
}

function renderGroupedItems(list, items, selectedValue, onChoose, { query = '' } = {}) {
  // rebuild groups from visible matches so empty buckets do not take up space
  list.replaceChildren();
  const groups = new Map([
    ['Oregon', []],
    ['Washington', []],
  ]);
  const ungrouped = [];

  for (const item of items) {
    const parsed = parseStateLabel(item);
    if (parsed.state && groups.has(parsed.state)) {
      groups.get(parsed.state).push({ ...item, displayLabel: parsed.displayLabel });
    } else {
      ungrouped.push({ ...item, displayLabel: parsed.displayLabel });
    }
  }

  let optionIndex = 0;
  let firstFocusable = null;

  // keep state groups in a stable order even when one has no matches
  for (const [stateName, groupItems] of groups) {
    if (!groupItems.length) continue;

    const group = document.createElement('div');
    group.className = 'filter-panel__group';

    // a search opens each populated bucket so matches arent hidden behind a collapsed group
    const expanded = Boolean(query) || groupExpandedState.get(stateName) === true;
    if (query) groupExpandedState.set(stateName, true);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'filter-panel__group-toggle';
    toggle.textContent = stateName;
    toggle.setAttribute('aria-expanded', `${expanded}`);
    // connect the disclosure control to the region it expands or collapses
    toggle.setAttribute('aria-controls', `${list.id}-${stateName.toLowerCase()}-items`);
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', `${next}`);
      itemsContainer.hidden = !next;
      groupExpandedState.set(stateName, next);
    });

    const itemsContainer = document.createElement('div');
    itemsContainer.id = toggle.getAttribute('aria-controls');
    itemsContainer.className = 'filter-panel__group-items';
    itemsContainer.hidden = !expanded;

    for (const item of groupItems) {
      const selected = `${item.value}` === `${selectedValue}`;
      const button = document.createElement('button');
      button.type = 'button';
      // one list-wide counter avoids duplicate ids across the two state buckets
      button.id = `${list.id}-option-${optionIndex}`;
      optionIndex += 1;
      button.className = 'filter-panel__item';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', `${selected}`);
      // prefer the selected row, otherwise start tab navigation at the first option
      const focusable = selected || (selectedValue == null && !firstFocusable);
      button.tabIndex = focusable ? 0 : -1;
      if (focusable && !firstFocusable) firstFocusable = button;
      button.textContent = item.displayLabel;
      button.addEventListener('click', () => onChoose(item));
      itemsContainer.append(button);
    }

    group.append(toggle, itemsContainer);
    list.append(group);
  }

  for (const item of ungrouped) {
    const selected = `${item.value}` === `${selectedValue}`;
    const button = document.createElement('button');
    button.type = 'button';
    // continue the same id sequence after all named state groups
    button.id = `${list.id}-option-${optionIndex}`;
    optionIndex += 1;
    button.className = 'filter-panel__item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', `${selected}`);
    // keep unknown or future state labels after the named buckets
    const focusable = selected || (selectedValue == null && !firstFocusable);
    button.tabIndex = focusable ? 0 : -1;
    if (focusable && !firstFocusable) firstFocusable = button;
    button.textContent = item.displayLabel;
    button.addEventListener('click', () => onChoose(item));
    list.append(button);
  }
}

// preserve each state bucket choice while option rows rerender during search
const groupExpandedState = new Map([
  ['Oregon', false],
  ['Washington', false],
]);

function renderSearchResults(list, items, selectedValue, onChoose) {
  // search results can represent either a category drilldown or a direct option pick
  list.replaceChildren();
  items.forEach((item, index) => {
    const selected = item.kind === 'option' && `${item.option.value}` === `${selectedValue}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${list.id}-option-${index}`;
    button.className = item.kind === 'type'
      ? 'filter-panel__item filter-panel__item--step'
      : 'filter-panel__item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', `${selected}`);
    // selected state belongs only to an option hit in the current category
    button.tabIndex = selected || (selectedValue == null && index === 0) ? 0 : -1;

    const label = document.createElement('span');
    label.className = 'filter-panel__item-label';
    label.textContent = item.label;
    button.append(label);

    if (item.meta) {
      // expose the parent category alongside an option hit from global search
      const meta = document.createElement('span');
      meta.className = 'filter-panel__item-meta';
      meta.textContent = item.meta;
      button.append(meta);
    }

    button.addEventListener('click', () => onChoose(item));
    list.append(button);
  });
}

const OPTION_SEARCH_ALIASES = {
  'eugene water & electric board': ['eweb'],
  'portland general electric': ['pge', 'portland general'],
  'pacific power (pacificorp)': ['pacific power', 'pacificorp'],
};

function optionMatchesQuery(option, query) {
  const label = `${option.label}`.toLowerCase();
  const displayLabel = displayOptionLabel(option).toLowerCase();
  const tokens = [label, displayLabel];
  // provider abbreviations arent in source labels, so add aliases only for those known names
  for (const [target, aliases] of Object.entries(OPTION_SEARCH_ALIASES)) {
    if (label.includes(target)) tokens.push(...aliases);
  }
  return tokens.join(' ').includes(query);
}

function moveListFocus(list, event) {
  const items = [...list.querySelectorAll('.filter-panel__item')];
  if (!items.length) return;
  // use the first result as the arrow-key anchor when focus is on a group toggle
  const current = Math.max(0, items.indexOf(document.activeElement));
  let next = -1;
  // arrow keys wrap; home and end jump to the list boundaries
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  if (next < 0) return;
  event.preventDefault();
  // keep a single list option in the tab order after arrow-key movement
  for (const item of items) item.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}
