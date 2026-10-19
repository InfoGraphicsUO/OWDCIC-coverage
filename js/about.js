import { openModal } from './modal.js';

// each section is a heading with paragraphs or a list, in display order
const ABOUT_SECTIONS = Object.freeze([
  Object.freeze({
    title: 'About this map',
    paragraphs: [
      'The Fire Camera Coverage Map shows where wildfire detection cameras in Oregon and Washington can see, so partners can review combined coverage across camera networks, find gaps, and plan new sites without conflicts.',
    ],
  }),
  Object.freeze({
    title: 'How it started',
    paragraphs: [
      'In February 2022, the Oregon Governor\'s office, BLM, and USFS requested that a work group be formed to establish cooperation between agencies across the state in detection camera efforts. The Oregon Wildfire Detection Camera Interoperability Committee (OWDCIC) was established to bring together partners from agencies that work in structural and wildland fire, emergency management, and the electrical utility sector.',
      'The OWDCIC\'s mission is to build relationships, increase interoperability and resilience, ensure cross governmental and cross jurisdictional communications and cooperation, and to identify and implement best practices to achieve interoperable fire tools that support response agencies at a statewide scale. The first group of its kind in the nation, the OWDCIC is now serving as a model for new regional and state interoperability workgroups in the Pacific Northwest. Committee work has resulted in opportunities and accomplishments such as development of a statewide combined detection map GIS layer, annual efficacy reporting, and elimination of conflicts in siting and permitting between agencies.',
      'The OWDCIC\'s goal is to define and establish true interoperability between camera systems regarding technological products and data products.',
      'In 2024, under leadership from the USFS, the Washington camera interoperability group formed to pursue similar solutions as the Oregon counterpart.',
    ],
  }),
  Object.freeze({
    title: 'Founding members',
    items: [
      'University of Oregon / Oregon Hazards Lab (OHAZ)',
      'Bureau of Land Management (BLM)',
      'USDA Forest Service (USFS)',
      'Oregon Department of Forestry (ODF)',
    ],
  }),
  Object.freeze({
    title: 'Data contributors, sponsors, and operators',
    items: [
      'University of Oregon / Oregon Hazards Lab (OHAZ)',
      'Oregon Department of Forestry (ODF)',
      'Portland General Electric',
      'Pacific Power',
      'Avista',
      'Puget Sound Energy',
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

function openAboutModal(onClose) {
  const { dialog } = openModal({
    id: 'about',
    title: 'About',
    closeLabel: 'Close about',
    className: 'about-modal',
    onClose,
  });

  const body = document.createElement('div');
  body.className = 'modal__body';
  for (const section of ABOUT_SECTIONS) body.append(aboutSection(section));
  dialog.append(body);
}

function aboutSection({ title, paragraphs = [], items = [] }) {
  const section = document.createElement('section');
  section.className = 'about-modal__section';

  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);

  for (const text of paragraphs) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    section.append(paragraph);
  }

  if (items.length) {
    const list = document.createElement('ul');
    for (const text of items) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    section.append(list);
  }

  return section;
}
