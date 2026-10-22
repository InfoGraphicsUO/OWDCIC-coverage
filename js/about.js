import { openModal } from './modal.js';

const SUMMARY = 'The Fire Camera Coverage Map shows where wildfire detection cameras in Oregon and Washington can see, so partners can review combined coverage across camera networks, find gaps, and plan new sites without conflicts.';

// dated milestones shown down the left edge of the history section
const TIMELINE = Object.freeze([
  Object.freeze({
    date: 'Feb 2022',
    text: 'In February 2022, the Oregon Governor\'s office, BLM, and USFS requested that a work group be formed to establish cooperation between agencies across the state in detection camera efforts. The Oregon Wildfire Detection Camera Interoperability Committee (OWDCIC) was established to bring together partners from agencies that work in structural and wildland fire, emergency management, and the electrical utility sector.',
  }),
  Object.freeze({
    date: '2024',
    text: 'In 2024, under leadership from the USFS the Washington camera interoperability group formed to pursue similar solutions as the Oregon counterpart.',
  }),
]);

const MISSION = 'The OWDCIC\'s mission is to build relationships, increase interoperability and resilience, ensure cross governmental and cross jurisdictional communications and cooperation, and to identify and implement best practices to achieve interoperable fire tools that support response agencies at a statewide scale. The first group of its kind in the nation, the OWDCIC is now serving as a model for new regional and state interoperability workgroups in the Pacific Northwest. Committee work has resulted in opportunities and accomplishments such as development of a statewide combined detection map GIS layer, annual efficacy reporting and elimination of conflicts in siting and permitting between agencies.';

const GOAL = 'The OWDCIC\'s goal is to define and establish true interoperability between camera systems regarding technological products and data products – the work proposed here is targeted to advance this goal.';

const CLOSING = 'Through the work of the OWDCIC and a commitment to collaboration on technology, policy funding opportunities and strengthening relationships between the partners utilizing detection camera platforms in Oregon.';

// each organization is its full name and an optional acronym shown after it
const ORGANIZATION_GROUPS = Object.freeze([
  Object.freeze({
    title: 'Founding members',
    names: [
      ['University of Oregon / Oregon Hazards Lab', 'UO/OHAZ'],
      ['Bureau of Land Management', 'BLM'],
      ['USDA Forest Service', 'USFS'],
      ['Oregon Department of Forestry', 'ODF'],
    ],
  }),
  Object.freeze({
    title: 'Data contributors, sponsors, and operators',
    names: [
      ['University of Oregon / Oregon Hazards Lab', 'UO/OHAZ'],
      ['Oregon Department of Forestry', 'ODF'],
      ['Portland General Electric', 'PGE'],
      ['Pacific Power'],
      ['Avista Energy'],
      ['Puget Sound Energy', 'PSE'],
    ],
  }),
]);

export function initAbout() {
  const button = document.getElementById('about-button');
  if (!button) return;

  button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', 'true');
    openAboutModal(() => button.setAttribute('aria-expanded', 'false'));
  });
}

// each tab builds its own panel content the first time the modal opens
const ABOUT_TABS = Object.freeze([
  Object.freeze({
    id: 'overview',
    label: 'Overview',
    build: () => [
      element('p', 'about-modal__lead', SUMMARY),
      section('How it started', timeline()),
    ],
  }),
  Object.freeze({
    id: 'mission',
    label: 'Mission',
    build: () => [
      element('p', '', MISSION),
      goalCallout(),
      element('p', 'about-modal__closing', CLOSING),
    ],
  }),
  Object.freeze({
    id: 'partners',
    label: 'Partners',
    build: () => {
      const columns = element('div', 'about-modal__partners');
      for (const group of ORGANIZATION_GROUPS) {
        columns.append(section(group.title, organizationList(group.names)));
      }
      return [columns];
    },
  }),
]);

function openAboutModal(onClose) {
  const { dialog, closeButton } = openModal({
    id: 'about',
    title: 'About',
    closeLabel: 'Close about',
    className: 'about-modal',
    onClose,
  });

  const tabList = element('div', 'about-modal__tabs');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'About sections');

  const body = element('div', 'modal__body about-modal__body');
  const tabs = [];
  const panels = [];

  for (const { id, label, build } of ABOUT_TABS) {
    const tab = element('button', 'about-modal__tab', label);
    tab.type = 'button';
    tab.id = `about-tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `about-panel-${id}`);
    tab.addEventListener('click', () => selectTab(tabs.indexOf(tab)));

    const panel = element('div', 'about-modal__panel');
    panel.id = `about-panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.append(...build());

    tabs.push(tab);
    panels.push(panel);
  }

  // arrow keys move between tabs, matching the usual tablist pattern
  tabList.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;

    let next = null;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;

    event.preventDefault();
    selectTab(next);
    tabs[next].focus();
  });

  function selectTab(index) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', `${selected}`);
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    body.scrollTop = 0;
  }

  // tabs share the header row, between the title and the close button
  tabList.append(...tabs);
  closeButton.before(tabList);
  body.append(...panels);
  dialog.append(body);
  selectTab(0);
}

function section(title, ...children) {
  const node = element('section', 'about-modal__section');
  node.append(element('h3', 'about-modal__heading', title), ...children);
  return node;
}

function timeline() {
  const list = element('ol', 'about-modal__timeline');
  for (const { date, text } of TIMELINE) {
    const item = element('li', 'about-modal__milestone');
    item.append(element('span', 'about-modal__date', date), element('p', '', text));
    list.append(item);
  }
  return list;
}

function goalCallout() {
  const callout = element('blockquote', 'about-modal__goal');
  callout.append(element('p', '', GOAL));
  return callout;
}

function organizationList(names) {
  const list = element('ul', 'about-modal__orgs');
  for (const [name, acronym] of names) {
    const item = element('li', '', name);
    if (acronym) item.append(' ', element('span', 'about-modal__acronym', acronym));
    list.append(item);
  }
  return list;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
