// on phones the control sidebar and the results panel are bottom sheets (css/mobile.css)
// the sidebar sheet drags by its handle or the tab bar between hidden, half and full height
// the results panel drags by its handle or header between its title, its content's height, and full height
// phones in landscape get the same layout, so the media query also matches short touch screens
export const PHONE_LAYOUT_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';
export const SHEET_CHANGE_EVENT = 'sheetchange';

// a press that moves less than this is a tap and is left to the click that follows
const DRAG_THRESHOLD = 8;
// a release faster than this (px/ms) moves one stop in the flick's direction
const FLICK_SPEED = 0.45;
// how far back the release speed is measured
const VELOCITY_WINDOW = 100;
// a click this soon after a drag ends belongs to the drag
const CLICK_AFTER_DRAG = 350;
// below this height there's no room for a half stop, so the sheet opens straight to full
const SHORT_VIEWPORT = 500;

let lastDragEnd = -Infinity;

// one capture listener drops the click a browser sends after a mouse or pen drag; touch pans don't
// send one, so instead of a flag that waits for a click, the drop only applies right after a drag
window.addEventListener('click', (event) => {
  if (performance.now() - lastDragEnd > CLICK_AFTER_DRAG) return;
  lastDragEnd = -Infinity;
  event.preventDefault();
  event.stopImmediatePropagation();
}, { capture: true });

export function isPhoneLayout() {
  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

// sidebar sheet height in CSS pixels, or 0 while it is hidden or not a sheet
export function sheetHeight(shell) {
  if (!isPhoneLayout() || shell.classList.contains('is-collapsed')) return 0;
  return inlineHeight(shell, '--sheet-height');
}

export function bindBottomSheet(shell, { setCollapsed }) {
  const handle = shell.querySelector('.control-shell__collapse');
  const rail = shell.querySelector('.control-rail');
  if (!handle || !rail) return;

  const phone = window.matchMedia(PHONE_LAYOUT_QUERY);
  // where a drag that opened a hidden sheet started, so a cancel can hide it again
  let openedByDrag = false;

  const detents = () => {
    const full = Math.max(0, window.innerHeight - rail.offsetHeight - sheetTop());
    const half = window.innerHeight < SHORT_VIEWPORT ? full : Math.min(full, Math.round(window.innerHeight * 0.45));
    return { half, full };
  };

  const setHeight = (px) => shell.style.setProperty('--sheet-height', `${Math.round(px)}px`);

  // a new viewport starts back at half height, and leaving the phone layout drops the override
  const reset = () => {
    if (phone.matches) setHeight(detents().half);
    else shell.style.removeProperty('--sheet-height');
  };

  const drag = {
    canStart: () => phone.matches,
    start: () => {
      openedByDrag = shell.classList.contains('is-collapsed');
      if (!openedByDrag) return sheetHeight(shell);
      // a drag up from the tab bar grows a hidden sheet from nothing
      setHeight(0);
      setCollapsed(false);
      return 0;
    },
    move: (startHeight, delta) => setHeight(clamp(startHeight + delta, 0, detents().full)),
    end: (height, velocity) => {
      const { half, full } = detents();
      // 0 stands for hidden
      const target = pickDetent(height, velocity, [0, half, full]);
      if (target === 0) {
        setCollapsed(true);
        // reopening starts from half height
        setHeight(half);
      } else {
        setHeight(target);
      }
    },
    cancel: (startHeight) => {
      if (openedByDrag) {
        setCollapsed(true);
        setHeight(detents().half);
      } else {
        setHeight(startHeight);
      }
    },
  };

  trackDrag(shell, handle, drag);
  trackDrag(shell, rail, drag);

  phone.addEventListener('change', reset);
  // a hidden sheet keeps its height too, so clamp the stored value rather than the visible one
  window.addEventListener('resize', () => {
    if (!phone.matches) return;
    const { full } = detents();
    if (inlineHeight(shell, '--sheet-height') > full) setHeight(full);
  });
  reset();
  // the banner and tab bar can still be settling on the first pass, so measure again once loaded
  requestAnimationFrame(reset);
  window.addEventListener('load', reset, { once: true });
}

export function bindResultsSheet(panel) {
  const handle = panel.querySelector('.results-panel__handle');
  const header = panel.querySelector('.results-panel__header');
  const title = panel.querySelector('[data-results-title]');
  if (!handle || !header) return;

  const phone = window.matchMedia(PHONE_LAYOUT_QUERY);
  // height the panel takes on its own, measured whenever it is at that height
  let fitHeight = 0;

  const tabBarHeight = () => document.querySelector('#control-sidebar .control-rail')?.offsetHeight ?? 0;
  const atFit = () => !panel.style.getPropertyValue('--results-height');
  const detents = () => {
    if (atFit()) fitHeight = panel.offsetHeight;
    const full = Math.max(0, window.innerHeight - tabBarHeight() - sheetTop());
    const peek = handle.offsetHeight + header.offsetHeight;
    return { peek, fit: clamp(fitHeight || full, peek, full), full };
  };

  // no inline height lets the panel fit its content again
  const setHeight = (px) => {
    if (px == null) panel.style.removeProperty('--results-height');
    else panel.style.setProperty('--results-height', `${Math.round(px)}px`);
  };

  const show = (target) => {
    const { peek, fit } = detents();
    panel.classList.toggle('is-peeking', target === peek);
    setHeight(target === fit ? null : target);
  };

  // each new result opens at its own height
  const reset = () => {
    fitHeight = 0;
    panel.classList.remove('is-peeking');
    setHeight(null);
  };

  const drag = {
    canStart: (event) => phone.matches && !event.target.closest('button, a'),
    start: () => {
      detents();
      panel.classList.remove('is-peeking');
      return panel.offsetHeight;
    },
    move: (startHeight, delta) => {
      const { peek, full } = detents();
      setHeight(clamp(startHeight + delta, peek, full));
    },
    end: (height, velocity) => {
      const { peek, fit, full } = detents();
      show(pickDetent(height, velocity, [peek, fit, full]));
    },
    cancel: (startHeight) => {
      const { peek, fit } = detents();
      show(nearest(startHeight, [peek, fit]) === peek ? peek : fit);
    },
  };
  trackDrag(panel, handle, drag);
  trackDrag(panel, header, drag);

  // a tap on the handle or title lowers the panel to its title, or raises it back to fit; it runs
  // on the click itself so the resize can't move a later click onto whatever ends up underneath
  const toggle = (event) => {
    if (!phone.matches || event.target.closest('button, a')) return;
    const { peek, fit } = detents();
    show(panel.classList.contains('is-peeking') ? fit : peek);
    panel.dispatchEvent(new CustomEvent(SHEET_CHANGE_EVENT));
  };
  handle.addEventListener('click', toggle);
  header.addEventListener('click', toggle);

  if (title) new MutationObserver(reset).observe(title, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => { if (panel.hidden) reset(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  phone.addEventListener('change', reset);
}

// pointer drags on target resize sheet; delta and velocity are positive moving up
// a press that never passes the threshold is left alone so its click still runs. moves are
// followed on the window until then, since a mouse can leave a small handle before it counts
// as a drag, and capturing on press would send a tab's click to the tab bar instead
function trackDrag(sheet, target, { canStart, start, move, end, cancel }) {
  let drag = null;

  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved) {
      if (Math.abs(delta) < DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.startHeight = start();
      sheet.classList.add('is-dragging');
    }
    // a drag shouldn't also select text or scroll anything underneath
    event.preventDefault();
    move(drag.startHeight, delta);
    drag.height = drag.startHeight + delta;
    const now = performance.now();
    drag.samples.push({ t: now, y: event.clientY });
    while (drag.samples.length > 2 && now - drag.samples[0].t > VELOCITY_WINDOW) drag.samples.shift();
  };

  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { moved, startHeight, height, samples } = drag;
    drag = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    if (!moved) return;
    sheet.classList.remove('is-dragging');
    lastDragEnd = performance.now();
    if (event.type === 'pointercancel') {
      cancel(startHeight);
    } else {
      const first = samples[0];
      const last = samples.at(-1);
      const elapsed = last && first ? last.t - first.t : 0;
      end(height, elapsed > 0 ? (first.y - last.y) / elapsed : 0);
    }
    sheet.dispatchEvent(new CustomEvent(SHEET_CHANGE_EVENT));
  };

  target.addEventListener('pointerdown', (event) => {
    if (drag || !event.isPrimary || event.button > 0 || !canStart(event)) return;
    drag = { pointerId: event.pointerId, startY: event.clientY, startHeight: 0, height: 0, moved: false, samples: [] };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  });
}

// a flick moves one stop in its direction from where it was let go; a slow release takes the nearest
function pickDetent(height, velocity, stops) {
  const sorted = [...new Set(stops)].sort((a, b) => a - b);
  if (velocity > FLICK_SPEED) return sorted.find((stop) => stop > height) ?? sorted.at(-1);
  if (velocity < -FLICK_SPEED) return [...sorted].reverse().find((stop) => stop < height) ?? sorted[0];
  return nearest(height, sorted);
}

// top edge a full height sheet stops at, just under the banner pill
function sheetTop() {
  const gap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-gap')) || 0;
  return (document.querySelector('.site-banner')?.getBoundingClientRect().bottom ?? 0) + gap;
}

function inlineHeight(element, property) {
  return Number.parseFloat(element.style.getPropertyValue(property)) || 0;
}

function nearest(value, options) {
  return options.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
