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

// short is the badge text, kept to a few letters so every badge is the same size
const ORGANIZATIONS = Object.freeze({
  ohaz: Object.freeze({ short: 'OHAZ', name: 'University of Oregon / Oregon Hazards Lab' }),
  blm: Object.freeze({ short: 'BLM', name: 'Bureau of Land Management' }),
  usfs: Object.freeze({ short: 'USFS', name: 'USDA Forest Service' }),
  odf: Object.freeze({ short: 'ODF', name: 'Oregon Department of Forestry' }),
  pge: Object.freeze({ short: 'PGE', name: 'Portland General Electric' }),
  pacificPower: Object.freeze({ short: 'PP', name: 'Pacific Power' }),
  avista: Object.freeze({ short: 'AVA', name: 'Avista Energy' }),
  pse: Object.freeze({ short: 'PSE', name: 'Puget Sound Energy' }),
});

const ORGANIZATION_GROUPS = Object.freeze([
  Object.freeze({
    title: 'Founding members',
    keys: ['ohaz', 'blm', 'usfs', 'odf'],
  }),
  Object.freeze({
    title: 'Data contributors, sponsors, and operators',
    keys: ['ohaz', 'odf', 'pge', 'pacificPower', 'avista', 'pse'],
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

function openAboutModal(onClose) {
  const { dialog } = openModal({
    id: 'about',
    title: 'About',
    closeLabel: 'Close about',
    className: 'about-modal',
    onClose,
  });

  const body = document.createElement('div');
  body.className = 'modal__body about-modal__body';

  const main = document.createElement('div');
  main.className = 'about-modal__main';
  main.append(
    element('p', 'about-modal__lead', SUMMARY),
    section('How it started', timeline()),
    section('Mission', element('p', '', MISSION), goalCallout(), element('p', 'about-modal__closing', CLOSING)),
  );

  const side = document.createElement('div');
  side.className = 'about-modal__side';
  for (const group of ORGANIZATION_GROUPS) {
    side.append(section(group.title, organizationList(group.keys)));
  }

  body.append(main, side);
  dialog.append(body);
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

function organizationList(keys) {
  const list = element('ul', 'about-modal__orgs');
  for (const key of keys) {
    const { short, name } = ORGANIZATIONS[key];
    const item = element('li', 'about-modal__org');
    const badge = element('span', 'about-modal__badge', short);
    badge.setAttribute('aria-hidden', 'true');
    item.append(badge, element('span', 'about-modal__org-name', name));
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
