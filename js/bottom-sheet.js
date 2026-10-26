// on phones the control sidebar is a bottom sheet (css/mobile.css). dragging its handle
// resizes it between half and full height, and dragging it most of the way down hides it
export const PHONE_LAYOUT_QUERY = '(max-width: 640px)';
export const SHEET_CHANGE_EVENT = 'sheetchange';

// a drag shorter than this is a tap, which the handle's own click handler toggles
const DRAG_THRESHOLD = 6;
// share of the half height a drag has to drop below to hide the sheet
const HIDE_FRACTION = 0.6;

export function isPhoneLayout() {
  return window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}

// sheet height in CSS pixels, or 0 while it is hidden or not a sheet
export function sheetHeight(shell) {
  if (!isPhoneLayout() || shell.classList.contains('is-collapsed')) return 0;
  return Number.parseFloat(shell.style.getPropertyValue('--sheet-height')) || 0;
}

export function bindBottomSheet(shell, { setCollapsed }) {
  const handle = shell.querySelector('.control-shell__collapse');
  const rail = shell.querySelector('.control-rail');
  const banner = document.querySelector('.site-banner');
  if (!handle || !rail) return;

  const phone = window.matchMedia(PHONE_LAYOUT_QUERY);
  let drag = null;
  let suppressClick = false;

  // half and full heights for the current viewport, full stopping short of the banner pill
  const detents = () => {
    const gap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-gap')) || 0;
    const top = (banner?.getBoundingClientRect().bottom ?? 0) + gap;
    const full = Math.max(0, window.innerHeight - rail.offsetHeight - top);
    return { half: Math.min(full, Math.round(window.innerHeight * 0.45)), full };
  };

  const setHeight = (px) => shell.style.setProperty('--sheet-height', `${Math.round(px)}px`);
  const announce = () => shell.dispatchEvent(new CustomEvent(SHEET_CHANGE_EVENT));

  // a new viewport starts back at half height, and leaving the phone layout drops the override
  const reset = () => {
    if (phone.matches) setHeight(detents().half);
    else shell.style.removeProperty('--sheet-height');
  };

  handle.addEventListener('pointerdown', (event) => {
    if (!phone.matches || shell.classList.contains('is-collapsed')) return;
    handle.setPointerCapture(event.pointerId);
    drag = { startY: event.clientY, startHeight: sheetHeight(shell), moved: false };
    shell.classList.add('is-dragging');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > DRAG_THRESHOLD) drag.moved = true;
    if (drag.moved) setHeight(Math.min(detents().full, Math.max(0, drag.startHeight + delta)));
  });

  const endDrag = () => {
    if (!drag) return;
    shell.classList.remove('is-dragging');
    const { moved } = drag;
    drag = null;
    if (!moved) return;

    // the click that follows a drag shouldn't also toggle the sheet
    suppressClick = true;
    const { half, full } = detents();
    const height = sheetHeight(shell);
    if (height < half * HIDE_FRACTION) {
      setCollapsed(true);
      // reopening starts from half height
      setHeight(half);
    } else {
      setHeight(Math.abs(height - half) <= Math.abs(height - full) ? half : full);
    }
    announce();
  };

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // capture runs before the toggle listener bound on the same button
  handle.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopImmediatePropagation();
  }, { capture: true });

  phone.addEventListener('change', reset);
  window.addEventListener('resize', () => {
    if (phone.matches && sheetHeight(shell) > detents().full) setHeight(detents().full);
  });
  reset();
}
