// anchor links keep the active filter in the URL hash so a link reopens the same view
// #<filter type>            opens that filter type, e.g. #county
// #<filter type>/<option>   picks one option, e.g. #utility-provider/pacific-power-pacificorp
// both parts are slugs of the labels shown in the filter panel, so new filters need no setup here

// lowercase words joined by hyphens, with accents folded to plain letters
export function anchorSlug(value) {
  return `${value ?? ''}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// returns '' when there is no type, so callers can clear the hash with the same value
export function formatAnchor(typeSlug, optionSlug) {
  if (!typeSlug) return '';
  return optionSlug ? `#${typeSlug}/${optionSlug}` : `#${typeSlug}`;
}

// reads a location hash into { type, option } slugs; option is null for type-only links
export function parseAnchor(hash) {
  let text = `${hash ?? ''}`.replace(/^#/, '');
  try {
    text = decodeURIComponent(text);
  } catch {
    // a malformed escape is treated as literal text and will simply match nothing
  }
  const [type, option] = text.split('/').map(anchorSlug);
  if (!type) return null;
  return { type, option: option || null };
}

// filter type for a type slug; the type id is accepted too so hand-written links work
export function anchorType(types, typeSlug) {
  return types.find(({ value, label }) => anchorSlug(label) === typeSlug || value === typeSlug) ?? null;
}

// maps each option value to a slug that is unique within its filter type
// types spanning both states prefix every option with its state, e.g. or-benton and wa-benton
// any names that still collide get their option value appended
export function anchorOptionSlugs(options) {
  const states = new Set(options.map(({ state }) => state).filter(Boolean));
  const base = options.map((option) =>
    anchorSlug(states.size > 1 && option.state ? `${option.state} ${option.label}` : option.label));
  const counts = new Map();
  for (const slug of base) counts.set(slug, (counts.get(slug) ?? 0) + 1);

  const slugs = new Map();
  options.forEach((option, index) => {
    const slug = base[index];
    const unique = slug && counts.get(slug) === 1;
    slugs.set(`${option.value}`, unique ? slug : anchorSlug(`${slug} ${option.value}`));
  });
  return slugs;
}

// option value for an option slug, or null when the link names nothing in this type
export function anchorOptionValue(slugs, optionSlug) {
  for (const [value, slug] of slugs) {
    if (slug === optionSlug) return value;
  }
  return null;
}
