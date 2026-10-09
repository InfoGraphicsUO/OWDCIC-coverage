// anchor links keep the active filter in the URL query string so a link reopens the same view
// ?filter=<filter type>                      opens that filter type, e.g. ?filter=county
// ?filter=<filter type>&selection=<option>   picks one option, e.g. ?filter=utility-provider&selection=pacific-power-pacificorp
// both values are slugs of the labels shown in the filter panel, so new filters need no setup here
// older links used the hash instead, #<filter type>/<option>, and are still read

const TYPE_PARAM = 'filter';
const OPTION_PARAM = 'selection';

// lowercase words joined by hyphens, with accents folded to plain letters
export function anchorSlug(value) {
  return `${value ?? ''}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// query string for a filter link, keeping any other parameters already in search
// returns '' when nothing is left, so callers can clear the link with the same value
export function formatAnchor(typeSlug, optionSlug, search = '') {
  const params = new URLSearchParams(search);
  params.delete(TYPE_PARAM);
  params.delete(OPTION_PARAM);
  if (typeSlug) {
    params.set(TYPE_PARAM, typeSlug);
    if (optionSlug) params.set(OPTION_PARAM, optionSlug);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

// reads a location search into { type, option } slugs; option is null for type-only links
export function parseAnchor(search) {
  const params = new URLSearchParams(`${search ?? ''}`);
  const type = anchorSlug(params.get(TYPE_PARAM));
  if (!type) return null;
  return { type, option: anchorSlug(params.get(OPTION_PARAM)) || null };
}

// reads a hash link from before links moved to the query string
export function parseLegacyAnchor(hash) {
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
