// keep callers safe in partial DOMs such as static render tests
const noopTooltip = {
  hide() {},
  isFor() { return false; },
  refresh() {},
};

// one tooltip element and one active trigger are shared by every bound root
let tooltip = null;
let activeButton = null;
let globalListenersAttached = false;
const boundRoots = new WeakSet();

// gap and viewport clearance are in CSS pixels because rects and fixed offsets use screen pixels
const gap = 8;
const margin = 8;
const maxWidth = 240;

// events bubble from the icon too, so resolve the owning trigger from any descendant
function buttonFrom(target) {
  return target instanceof Element ? target.closest('.info-button') : null;
}

function ensureTooltip() {
  if (tooltip || !document.body?.append) return tooltip;
  tooltip = document.createElement('div');
  tooltip.className = 'info-tooltip';
  tooltip.id = 'info-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  // fixed positioning lets the tooltip escape clipped and scrolling containers
  document.body.append(tooltip);
  return tooltip;
}

function hide() {
  // release the element reference so later resize events do no work
  activeButton = null;
  if (tooltip) tooltip.hidden = true;
}

function refresh(button) {
  // detached buttons have no useful viewport position
  if (!tooltip || !button || !button.isConnected) return;
  activeButton = button;
  tooltip.textContent = button.dataset.tooltip || '';
  tooltip.hidden = false;
  const buttonRect = button.getBoundingClientRect();
  // open toward the map when the trigger sits too close to the right viewport edge
  const spaceRight = window.innerWidth - buttonRect.right - gap - margin;
  const spaceLeft = buttonRect.left - gap - margin;
  const side = spaceRight >= maxWidth || spaceRight >= spaceLeft ? 'right' : 'left';
  tooltip.dataset.side = side;
  // cap width before measuring so placement uses the final wrapped dimensions
  tooltip.style.maxWidth = `${Math.max(64, Math.min(maxWidth, side === 'right' ? spaceRight : spaceLeft))}px`;

  const tooltipRect = tooltip.getBoundingClientRect();
  // place beside the button and keep every edge inside viewport margins
  const left = side === 'right'
    ? Math.min(buttonRect.right + gap, window.innerWidth - tooltipRect.width - margin)
    : Math.max(margin, buttonRect.left - gap - tooltipRect.width);
  const top = Math.max(
    margin,
    Math.min(
      buttonRect.top + (buttonRect.height - tooltipRect.height) / 2,
      window.innerHeight - tooltipRect.height - margin,
    ),
  );
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function attachGlobalListeners() {
  if (globalListenersAttached) return;
  globalListenersAttached = true;
  // partial DOMs such as static render tests may lack global event targets
  window.addEventListener?.('resize', () => {
    // keep the fixed tooltip aligned if its trigger moves with the viewport
    if (activeButton) refresh(activeButton);
  });
  document.addEventListener?.('keydown', (event) => {
    // escape dismisses without changing focus
    if (event.key === 'Escape' && activeButton) hide();
  });
}

// delegated pointer and focus handlers cover current and future triggers
function bindRoot(root) {
  root.addEventListener('pointerover', (event) => {
    const button = buttonFrom(event.target);
    if (button) refresh(button);
  });
  root.addEventListener('pointerout', (event) => {
    const button = buttonFrom(event.target);
    // movement between the icon and button contents is still inside one trigger
    if (!button || button.contains(event.relatedTarget)) return;
    // retain the message while keyboard focus or the pointer still owns the trigger
    if (!button.matches(':hover, :focus')) hide();
  });
  root.addEventListener('focusin', (event) => {
    const button = buttonFrom(event.target);
    if (button) refresh(button);
  });
  root.addEventListener('focusout', (event) => {
    const button = buttonFrom(event.target);
    if (!button || button.contains(event.relatedTarget)) return;
    // a pointer hover can outlive keyboard focus
    if (!button.matches(':hover')) hide();
  });
  // scroll does not bubble, so this only tracks roots that scroll themselves
  root.addEventListener('scroll', () => {
    if (activeButton) refresh(activeButton);
  });
}

const api = {
  hide,
  isFor(element) {
    // containers hold child triggers, so hiding a container also clears a child tooltip
    return activeButton != null && element.contains(activeButton);
  },
  refresh(button) {
    // update an open message in place without reopening an unrelated tooltip
    if (button === activeButton) refresh(button);
  },
};

/** delegated hover/focus tooltips for `.info-button` triggers inside `root` */
export function attachInfoTooltip(root) {
  if (!document.body?.append) return noopTooltip;
  ensureTooltip();
  attachGlobalListeners();
  if (root && !boundRoots.has(root)) {
    boundRoots.add(root);
    bindRoot(root);
  }
  return api;
}
