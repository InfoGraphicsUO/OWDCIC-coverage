/**
 * shared dialog shell used by every modal popup
 *
 * builds the backdrop, titled header, and close button, traps keyboard focus,
 * and restores focus to the opener when the dialog closes
 * callers append their own content to the returned dialog
 */
export function openModal({ id, title, closeLabel, className = '', onClose }) {
  // remember the opener before moving focus into the modal
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = classNames('modal', className);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal__backdrop';

  const dialog = document.createElement('div');
  dialog.className = classNames('modal__dialog', className && `${className}__dialog`);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'modal__header';
  const heading = document.createElement('h2');
  heading.id = `${id}-title`;
  heading.textContent = title;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal__close';
  closeButton.setAttribute('aria-label', closeLabel);
  closeButton.textContent = '×';
  header.append(heading, closeButton);

  dialog.append(header);
  overlay.append(backdrop, dialog);
  document.body.append(overlay);

  // exclude hidden controls so Tab only cycles through targets users can reach
  const focusables = () => [...dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === dialog);

  function close() {
    // remove the document key handler before returning to the page
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    onClose?.();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    // cycle keyboard focus within the modal
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // button, backdrop, and Escape all share the same teardown and focus restore
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown);
  // defer focus until the dialog has been attached to the document
  requestAnimationFrame(() => dialog.focus());

  return { overlay, backdrop, dialog, closeButton, close };
}

function classNames(...names) {
  return names.filter(Boolean).join(' ');
}
