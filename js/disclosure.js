// a heading button that shows and hides the rows under it
// used by the filter panel's groups and the Layers tab's sections, styled in css/disclosure.css
// className goes on the wrapper so each panel can still indent and size its own rows
export function createDisclosure(label, { id, open = false, className = '', onToggle } = {}) {
  const element = document.createElement('div');
  element.className = `disclosure ${className}`.trim();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'disclosure__toggle';
  toggle.textContent = label;
  toggle.setAttribute('aria-controls', id);

  const items = document.createElement('div');
  items.id = id;
  items.className = 'disclosure__items';

  const setOpen = (next) => {
    toggle.setAttribute('aria-expanded', `${next}`);
    items.hidden = !next;
  };
  setOpen(open);

  toggle.addEventListener('click', () => {
    const next = items.hidden;
    setOpen(next);
    onToggle?.(next);
  });

  element.append(toggle, items);
  return { element, items, setOpen };
}

// labels like Pano AI contain spaces, which an id reference cannot
export function idFromLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
