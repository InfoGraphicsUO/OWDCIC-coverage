// on phones the control sidebar and the results panel are bottom sheets (css/mobile.css)
// the sidebar's handle drags it between half and full height, and most of the way down hides it
// the results panel drags between its title, its content's height, and full height
export const PHONE_LAYOUT_QUERY = '(max-width: 640px)';
export const SHEET_CHANGE_EVENT = 'sheetchange';

// a drag shorter than this is a tap
const DRAG_THRESHOLD = 6;
// share of the half height a drag has to drop below to hide the sidebar sheet
const HIDE_FRACTION = 0.6;

export function isPhoneLayout() {
  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

// sidebar sheet height in CSS pixels, or 0 while it is hidden or not a sheet
export function sheetHeight(shell) {
  if (!isPhoneLayout() || shell.classList.contains('is-collapsed')) return 0;
  return Number.parseFloat(shell.style.getPropertyValue('--sheet-height')) || 0;
}

export function bindBottomSheet(shell, { setCollapsed }) {
  const handle = shell.querySelector('.control-shell__collapse');
  const rail = shell.querySelector('.control-rail');
  if (!handle || !rail) return;

  const phone = window.matchMedia(PHONE_LAYOUT_QUERY);

  // half and full heights for the current viewport
  const detents = () => {
    const full = Math.max(0, window.innerHeight - rail.offsetHeight - sheetTop());
    return { half: Math.min(full, Math.round(window.innerHeight * 0.45)), full };
  };

  const setHeight = (px) => shell.style.setProperty('--sheet-height', `${Math.round(px)}px`);

  // a new viewport starts back at half height, and leaving the phone layout drops the override
  const reset = () => {
    if (phone.matches) setHeight(detents().half);
    else shell.style.removeProperty('--sheet-height');
  };

  trackDrag(shell, handle, {
    canStart: () => phone.matches && !shell.classList.contains('is-collapsed'),
    start: () => sheetHeight(shell),
    move: (startHeight, delta) => setHeight(Math.min(detents().full, Math.max(0, startHeight + delta))),
    // the handle's own click handler toggles the sheet on a tap
    tap: null,
    end: () => {
      const { half, full } = detents();
      const height = sheetHeight(shell);
      if (height < half * HIDE_FRACTION) {
        setCollapsed(true);
        // reopening starts from half height
        setHeight(half);
      } else {
        setHeight(nearest(height, [half, full]));
      }
    },
  });

  phone.addEventListener('change', reset);
  window.addEventListener('resize', () => {
    if (phone.matches && sheetHeight(shell) > detents().full) setHeight(detents().full);
  });
  reset();
}

export function bindResultsSheet(panel) {
  const handle = panel.querySelector('.results-panel__handle');
  const header = panel.querySelector('.results-panel__header');
  const title = panel.querySelector('[data-results-title]');
  if (!handle || !header) return;

  const phone = window.matchMedia(PHONE_LAYOUT_QUERY);
  // height the panel takes on its own, measured before the first drag of each result
  let fitHeight = 0;

  const tabBarHeight = () => document.querySelector('#control-sidebar .control-rail')?.offsetHeight ?? 0;
  const detents = () => {
    const full = Math.max(0, window.innerHeight - tabBarHeight() - sheetTop());
    const peek = handle.offsetHeight + header.offsetHeight;
    return { peek, fit: Math.min(fitHeight || full, full), full };
  };

  // no inline height lets the panel fit its content again
  const setHeight = (px) => {
    if (px == null) panel.style.removeProperty('--results-height');
    else panel.style.setProperty('--results-height', `${Math.round(px)}px`);
  };

  const snapTo = (height) => {
    const { peek, fit, full } = detents();
    const target = nearest(height, [peek, fit, full]);
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
    canStart: (event) => phone.matches && !event.target.closest('button'),
    start: () => {
      if (!panel.style.getPropertyValue('--results-height')) fitHeight = panel.offsetHeight;
      panel.classList.remove('is-peeking');
      return panel.offsetHeight;
    },
    move: (startHeight, delta) => {
      const { peek, full } = detents();
      setHeight(Math.min(full, Math.max(peek, startHeight + delta)));
    },
    // a tap lowers the panel to its title, or raises it back to fit
    tap: () => {
      if (!panel.style.getPropertyValue('--results-height')) fitHeight = panel.offsetHeight;
      const { peek, fit } = detents();
      snapTo(panel.classList.contains('is-peeking') ? fit : peek);
    },
    // the dragged height, since offsetHeight could still be easing toward it
    end: () => snapTo(Number.parseFloat(panel.style.getPropertyValue('--results-height')) || panel.offsetHeight),
  };
  trackDrag(panel, handle, drag);
  trackDrag(panel, header, drag);

  if (title) new MutationObserver(reset).observe(title, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => { if (panel.hidden) reset(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  phone.addEventListener('change', reset);
}

// pointer drags on target that resize sheet; delta is how far up the pointer has moved
// tap runs for a press that never passes the threshold, and the click after a drag is swallowed
function trackDrag(sheet, target, { canStart, start, move, end, tap }) {
  let drag = null;
  let suppressClick = false;

  target.addEventListener('pointerdown', (event) => {
    if (!canStart(event)) return;
    target.setPointerCapture(event.pointerId);
    drag = { startY: event.clientY, startHeight: null, moved: false };
  });

  target.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) <= DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.startHeight = start();
      sheet.classList.add('is-dragging');
    }
    move(drag.startHeight, delta);
  });

  const finish = () => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    sheet.classList.remove('is-dragging');
    if (moved) {
      suppressClick = true;
      end();
    } else if (tap) {
      tap();
    } else {
      return;
    }
    sheet.dispatchEvent(new CustomEvent(SHEET_CHANGE_EVENT));
  };

  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', finish);

  // capture runs before any toggle listener bound on the same element
  target.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopImmediatePropagation();
  }, { capture: true });
}

// top edge a full height sheet stops at, just under the banner pill
function sheetTop() {
  const gap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-gap')) || 0;
  return (document.querySelector('.site-banner')?.getBoundingClientRect().bottom ?? 0) + gap;
}

function nearest(value, options) {
  return options.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best));
}
