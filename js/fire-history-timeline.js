/**
 * year slider over the map for the Fire history layer
 * it stays hidden until a fire history row is switched on and its data gives it a year range
 * onChange receives the year whenever it changes
 */
export function initFireHistoryTimeline(container, onChange) {
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

  element.append(yearLabel, track);
  container.append(element);

  let firstYear = null;
  let lastYear = null;
  let wanted = false;

  const year = () => Number(slider.value);
  const notify = () => onChange(year());

  function render() {
    yearLabel.textContent = String(year());
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

  slider.addEventListener('input', () => {
    render();
    notify();
  });

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
      return firstYear === null ? null : year();
    },
  };
}
