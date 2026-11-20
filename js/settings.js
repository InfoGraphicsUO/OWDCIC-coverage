import { openModal } from './modal.js';

// stored per browser so a reload keeps the viewer's display choices
const STORAGE_KEY = 'owdcic-settings';
const DEFAULT_SETTINGS = Object.freeze({
  separateViewshedColors: false,
  showZoomLevel: false,
  animateBanner: false,
  resultsMockup: 'current',
});

// each row is one boolean preference shown in the settings popup
// viewshed colors are switched from the layers menu instead
const SETTING_FIELDS = Object.freeze([
  Object.freeze({
    key: 'showZoomLevel',
    label: 'Show zoom level',
    description: 'Displays the current map zoom at the top of the map.',
  }),
  Object.freeze({
    key: 'animateBanner',
    label: 'Animate banner',
    description: 'The camera viewsheds in the banner drift slowly.',
  }),
  // issue #227: the two results panel layouts for a USWFS unit, beside the current one
  Object.freeze({
    key: 'resultsMockup',
    label: 'USWFS results layout',
    description: 'Mockups for a selected USWFS unit: the whole unit beside its BLM, USFWS, and NPS land.',
    options: Object.freeze([
      Object.freeze({ value: 'current', label: 'Current' }),
      Object.freeze({ value: 'grouped', label: 'Collapsible sections' }),
      Object.freeze({ value: 'combined', label: 'Single pane' }),
    ]),
  }),
]);

// the popup only holds dev tools, so the public GitHub Pages site leaves it out
// and keeps those settings at their defaults; any other host counts as dev
export const SETTINGS_ENABLED = !window.location.hostname.endsWith('.github.io');

const settings = { ...DEFAULT_SETTINGS, ...readStoredSettings() };
const listeners = new Set();

export function getSetting(key) {
  return settings[key];
}

// calls back now with the current value and again after every change
export function onSettingChange(key, callback) {
  const listener = (changedKey, value) => {
    if (changedKey === key) callback(value);
  };

  listeners.add(listener);
  callback(settings[key]);
  return () => listeners.delete(listener);
}

export function bindSettingsButton(button) {
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', 'true');
    openSettingsModal(() => button.setAttribute('aria-expanded', 'false'));
  });
}

export function setSetting(key, value) {
  if (settings[key] === value) return;

  settings[key] = value;
  writeStoredSettings();
  for (const listener of listeners) listener(key, value);
}

function openSettingsModal(onClose) {
  const { dialog } = openModal({
    id: 'settings',
    title: 'Developer settings',
    closeLabel: 'Close developer settings',
    className: 'settings-modal',
    onClose,
  });

  const body = document.createElement('div');
  body.className = 'modal__body';
  for (const field of SETTING_FIELDS) body.append(settingRow(field));
  dialog.append(body);
}

function settingRow({ key, label, description, options }) {
  const id = `setting-${key}`;
  const row = document.createElement('div');
  row.className = `settings-modal__row${options ? ' settings-modal__row--select' : ''}`;

  // a field with options is a choice of one, the rest are on/off
  const control = options ? settingSelect(key, options) : settingCheckbox(key);
  control.id = id;
  control.setAttribute('aria-describedby', `${id}-description`);

  const text = document.createElement('div');
  const title = document.createElement('label');
  title.htmlFor = id;
  title.className = 'settings-modal__label';
  title.textContent = label;

  const hint = document.createElement('p');
  hint.id = `${id}-description`;
  hint.className = 'settings-modal__description';
  hint.textContent = description;

  text.append(title, hint);

  if (options) {
    text.append(control);
    row.append(text);
  } else {
    row.append(control, text);
  }
  return row;
}

function settingCheckbox(key) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(settings[key]);
  checkbox.addEventListener('change', () => setSetting(key, checkbox.checked));
  return checkbox;
}

function settingSelect(key, options) {
  const select = document.createElement('select');
  select.className = 'settings-modal__select';
  for (const { value, label } of options) select.append(new Option(label, value, false, settings[key] === value));
  select.addEventListener('change', () => setSetting(key, select.value));
  return select;
}

function readStoredSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const hidden = SETTINGS_ENABLED ? new Set() : new Set(SETTING_FIELDS.map(({ key }) => key));
    // ignore unknown or mistyped keys from older versions of the page,
    // and popup settings saved on the public site before it was dev only
    return Object.fromEntries(
      Object.entries(stored).filter(([key, value]) =>
        typeof DEFAULT_SETTINGS[key] === typeof value && !hidden.has(key) && validOption(key, value))
    );
  } catch {
    // private browsing and corrupt values fall back to the defaults
    return {};
  }
}

// a choice saved by an older page may no longer be offered
function validOption(key, value) {
  const options = SETTING_FIELDS.find((field) => field.key === key)?.options;
  return !options || options.some((option) => option.value === value);
}

function writeStoredSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // settings still apply for this visit when storage is unavailable
  }
}
