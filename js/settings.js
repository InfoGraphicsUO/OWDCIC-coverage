import { openModal } from './modal.js';

// stored per browser so a reload keeps the viewer's display choices
const STORAGE_KEY = 'owdcic-settings';
const DEFAULT_SETTINGS = Object.freeze({
  separateViewshedColors: false,
});
// each row is one boolean preference shown in the settings popup
const SETTING_FIELDS = Object.freeze([
  Object.freeze({
    key: 'separateViewshedColors',
    label: 'Color viewsheds by camera provider',
    description: 'Each provider\'s viewsheds use their own color instead of sharing one.',
  }),
]);

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

export function initSettings() {
  const button = document.getElementById('settings-button');
  if (!button) return;
  button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', 'true');
    openSettingsModal(() => button.setAttribute('aria-expanded', 'false'));
  });
}

function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  writeStoredSettings();
  for (const listener of listeners) listener(key, value);
}

function openSettingsModal(onClose) {
  const { dialog } = openModal({
    id: 'settings',
    title: 'Settings',
    closeLabel: 'Close settings',
    className: 'settings-modal',
    onClose,
  });

  const body = document.createElement('div');
  body.className = 'modal__body';
  for (const field of SETTING_FIELDS) body.append(settingRow(field));
  dialog.append(body);
}

function settingRow({ key, label, description }) {
  const id = `setting-${key}`;
  const row = document.createElement('div');
  row.className = 'settings-modal__row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.checked = Boolean(settings[key]);
  checkbox.setAttribute('aria-describedby', `${id}-description`);
  checkbox.addEventListener('change', () => setSetting(key, checkbox.checked));

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

  row.append(checkbox, text);
  return row;
}

function readStoredSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // ignore unknown or mistyped keys from older versions of the page
    return Object.fromEntries(
      Object.entries(stored).filter(([key, value]) =>
        typeof DEFAULT_SETTINGS[key] === typeof value)
    );
  } catch {
    // private browsing and corrupt values fall back to the defaults
    return {};
  }
}

function writeStoredSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // settings still apply for this visit when storage is unavailable
  }
}
