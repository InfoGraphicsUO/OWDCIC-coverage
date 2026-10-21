import { attachInfoTooltip } from './info-tooltip.js';

/**
 * year slider over the map for the Fire history layer
 * it stays hidden until a fire history row is switched on and its data gives it a year range
 * onChange receives { year, cumulative } whenever either one changes
 * colors are the map's { year, earlier } fills, repeated in the earlier years explanation
 */
export function initFireHistoryTimeline(container, onChange, colors) {
  const element = document.createElement('section');
  element.className = 'fire-timeline';
  element.setAttribute('aria-label', 'Fire history timeline');
  // the bar stays in the page so it can slide in and out; inert keeps it out of reach while closed
  element.inert = true;

  const yearLabel = document.createElement('output');
  yearLabel.className = 'fire-timeline__year';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'fire-timeline__slider';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Fire year');

  const ticks = document.createElement('div');
  ticks.className = 'fire-timeline__ticks';
  ticks.setAttribute('aria-hidden', 'true');

  const track = document.createElement('div');
  track.className = 'fire-timeline__track';
  track.append(slider, ticks);

  const cumulativeInput = document.createElement('input');
  cumulativeInput.type = 'checkbox';
  // one year at a time by default; earlier years are an opt-in
  cumulativeInput.checked = false;
  const cumulativeLabel = document.createElement('label');
  cumulativeLabel.className = 'fire-timeline__cumulative';
  cumulativeLabel.append(cumulativeInput, 'Show earlier years');

  const cumulativeInfo = createEarlierYearsInfo(colors);
  const cumulativeControl = document.createElement('div');
  cumulativeControl.className = 'fire-timeline__cumulative-control';
  cumulativeControl.append(cumulativeLabel, cumulativeInfo);

  element.append(yearLabel, track, cumulativeControl);
  container.append(element);
  attachInfoTooltip(element);

  let firstYear = null;
  let lastYear = null;
  let wanted = false;

  const year = () => Number(slider.value);
  const notify = () => onChange({ year: year(), cumulative: cumulativeInput.checked });

  function render() {
    yearLabel.textContent = String(year());
    // the label already reads the year, so the slider announces the same text
    slider.setAttribute('aria-valuetext', cumulativeInput.checked
      ? `${firstYear} through ${year()}`
      : String(year()));
  }

  function renderTicks() {
    ticks.replaceChildren();
    for (let tickYear = firstYear; tickYear <= lastYear; tickYear += 1) {
      const tick = document.createElement('span');
      // the two-digit year keeps every tick readable in a narrow bar
      tick.textContent = `'${String(tickYear).slice(-2)}`;
      ticks.append(tick);
    }
  }

  function syncOpen() {
    const open = wanted && firstYear !== null;
    element.classList.toggle('is-open', open);
    element.inert = !open;
  }

  for (const [input, event] of [[slider, 'input'], [cumulativeInput, 'change']]) {
    input.addEventListener(event, () => {
      render();
      notify();
    });
  }

  render();

  return {
    // each data file widens the range to cover its own years
    includeYears(years) {
      const known = years.filter(Number.isFinite);
      if (!known.length) return;
      const wasAtEnd = firstYear === null || year() === lastYear;
      firstYear = Math.min(firstYear ?? Infinity, ...known);
      lastYear = Math.max(lastYear ?? -Infinity, ...known);
      slider.min = String(firstYear);
      slider.max = String(lastYear);
      renderTicks();
      syncOpen();
      // opening on the latest year shows the most recent season
      slider.value = String(wasAtEnd ? lastYear : Math.min(Math.max(year(), firstYear), lastYear));
      render();
      notify();
    },

    setVisible(visible) {
      wanted = visible;
      syncOpen();
    },

    current() {
      return { year: firstYear === null ? null : year(), cumulative: cumulativeInput.checked };
    },
  };
}

// the explanation names each fill with a chip of its color, so the text matches the map
function createEarlierYearsInfo({ year, earlier }) {
  const parts = [
    'Shows the years before the selected year in a faded ',
    [earlier, 'brown'],
    ', building up a history of past fires beneath the selected year in ',
    [year, 'dark red'],
    '.',
  ];

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-button fire-timeline__info';
  button.innerHTML = '<i class="fa-regular fa-circle-info" aria-hidden="true"></i>';
  const text = parts.map((part) => (Array.isArray(part) ? part[1] : part)).join('');
  // plain text for assistive technology, chips for the visible tooltip
  button.dataset.tooltip = text;
  button.setAttribute('aria-label', text);
  button.tooltipContent = () => parts.map((part) => {
    if (!Array.isArray(part)) return part;
    const [color, name] = part;
    const chip = document.createElement('span');
    chip.className = 'fire-timeline__color';
    const swatch = document.createElement('span');
    swatch.className = 'fire-timeline__chip';
    swatch.style.background = color;
    chip.append(swatch, name);
    return chip;
  });
  return button;
}
