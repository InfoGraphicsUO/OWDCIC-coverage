export function hideMapLoading() {
  document.querySelector('main')?.removeAttribute('aria-busy');

  const overlay = document.getElementById('map-loading');
  if (!overlay) return;

  overlay.classList.add('map-loading--hidden');
  overlay.setAttribute('aria-hidden', 'true');

  const removeOverlay = () => overlay.remove();
  overlay.addEventListener('transitionend', removeOverlay, { once: true });

  // reduced-motion mode has no transition event, so retain a short fallback
  window.setTimeout(removeOverlay, 250);
}
