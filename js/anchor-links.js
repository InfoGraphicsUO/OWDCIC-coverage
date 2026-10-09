// anchor links keep the active filter in the URL query string so a link reopens the same view
// ?filter=<filter type>                      opens that filter type, e.g. ?filter=county
// ?filter=<filter type>&selection=<option>   picks one option, e.g. ?filter=utility-provider&selection=pacificorp
// both values are slugs of the labels shown in the filter panel, so new filters need no setup here
// option slugs are shortened where the label allows, e.g. deschutes for Deschutes National Forest

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

// filter type for a type slug; the type id is accepted too so hand-written links work
export function anchorType(types, typeSlug) {
  return types.find(({ value, label }) => anchorSlug(label) === typeSlug || value === typeSlug) ?? null;
}

// words that say what kind of place an option is rather than which one
// they are left out of option slugs so links stay short, e.g. deschutes for Deschutes National Forest
const FILLER_WORDS = new Set([
  'national', 'forest', 'forests', 'park', 'monument', 'preserve', 'reserve',
  'historic', 'historical', 'site', 'recreation', 'scenic', 'area',
  'state', 'legislative', 'congressional', 'house', 'senate', 'district',
  'indian', 'reservation', 'off',
]);
// joining words that mean nothing once the words beside them are gone
const JOINING_WORDS = new Set(['and', 'of', 'the']);

// a label without the U.S. some agencies lead with
function plainLabel(label) {
  return `${label ?? ''}`.replace(/\bU\.S\.\s*/gi, '');
}

// the short name an option goes by in a link
function shortLabel(label) {
  const text = plainLabel(label);
  // a trailing name in parentheses is the one people know, e.g. Pacific Power (PacifiCorp)
  const alias = text.match(/\(([^()]+)\)\s*$/)?.[1];
  if (alias) return alias;
  // apostrophes close up instead of splitting a name, e.g. ebeys-landing
  const words = anchorSlug(text.replace(/['\u2019]/g, ''))
    .split('-')
    .filter((word) => !FILLER_WORDS.has(word));
  while (JOINING_WORDS.has(words[0])) words.shift();
  while (JOINING_WORDS.has(words.at(-1))) words.pop();
  // a label made only of filler words keeps them
  return words.join(' ') || text;
}

function slugCounts(slugs) {
  const counts = new Map();
  for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  return counts;
}

// maps each option value to a slug that is unique within its filter type
// labels are shortened unless shorten is false, e.g. pacificorp, deschutes, or-10
// types spanning both states prefix every option with its state, e.g. or-benton and wa-benton,
// unless the short names are already unique without it, e.g. oregon and washington
// short names that collide keep their filler words, and any still shared get their option value appended
export function anchorOptionSlugs(options, { shorten = true } = {}) {
  const states = new Set(options.map(({ state }) => state).filter(Boolean));
  const slugsFor = (labelOf, prefixed = states.size > 1) => options.map((option) =>
    anchorSlug(prefixed && option.state ? `${option.state} ${labelOf(option.label)}` : labelOf(option.label)));

  let base = slugsFor((label) => label);
  if (shorten) {
    const bare = slugsFor(shortLabel, false);
    const short = bare.every(Boolean) && new Set(bare).size === bare.length ? bare : slugsFor(shortLabel);
    const shortCounts = slugCounts(short);
    const plain = slugsFor(plainLabel);
    base = short.map((slug, index) => (slug && shortCounts.get(slug) === 1 ? slug : plain[index]));
  }
  const counts = slugCounts(base);

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
