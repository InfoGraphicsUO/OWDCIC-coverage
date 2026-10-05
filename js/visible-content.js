// the two lists at the bottom of this file decide which filters and map layers the site shows
// edit them, save, and reload the page; nothing else needs to change
// anything left out is only switched off, the code that builds it stays in place

// ---------------------------------------------------------------------------
// EVERYTHING AVAILABLE (reference only, copy lines from here into the lists below)
// ---------------------------------------------------------------------------
//
// FILTER GROUPS
//   'Group name': 'all'                    shows every option in the group
//   'Group name': ['Option', 'Option']     shows only the named options
//   names are written as they appear on the site and ignore upper/lower case
//   groups appear in the filter panel in the order they are listed
//
//   'State': 'all',
//     // or pick from:
//     // ['Oregon', 'Washington'],
//
//   'County': 'all',
//     // 75 options, see data/divisions/county.geojson
//     // a name shared by both states (e.g. 'Columbia') matches both; use the
//     // divisionId instead to pick one, e.g. 'county:41009'
//
//   'State House': 'all',
//     // 109 options, see data/divisions/house.geojson
//
//   'US House': 'all',
//     // 16 options, see data/divisions/us-house.geojson
//     // district names repeat across states; use the divisionId to pick one, e.g. 'us-house:4101'
//
//   'State Senate': 'all',
//     // 79 options, see data/divisions/senate.geojson
//
//   'Utility provider': 'all',
//     // or pick from:
//     // [
//     //   'Eugene Water & Electric Board (EWEB)',
//     //   'Pacific Power (PacifiCorp)',
//     //   'Portland General Electric (PGE)',
//     // ],
//
//   'National Forest': 'all',
//     // or pick from:
//     // [
//     //   'Columbia River Gorge National Scenic Area',
//     //   'Colville National Forest',
//     //   'Deschutes National Forest',
//     //   'Fremont-Winema National Forest',
//     //   'Gifford Pinchot National Forest',
//     //   'Humboldt-Toiyabe National Forest',
//     //   'Idaho Panhandle National Forests',
//     //   'Klamath National Forest',
//     //   'Malheur National Forest',
//     //   'Modoc National Forest',
//     //   'Mt. Baker-Snoqualmie National Forest',
//     //   'Mt. Hood National Forest',
//     //   'Ochoco National Forest',
//     //   'Okanogan-Wenatchee National Forest',
//     //   'Olympic National Forest',
//     //   'Payette National Forest',
//     //   'Rogue River-Siskiyou National Forests',
//     //   'Siuslaw National Forest',
//     //   'Six Rivers National Forest',
//     //   'Umatilla National Forest',
//     //   'Umpqua National Forest',
//     //   'Wallowa-Whitman National Forest',
//     //   'Willamette National Forest',
//     // ],
//
//   'National Park': 'all',
//     // or pick from:
//     // [
//     //   'Crater Lake National Park',
//     //   "Ebey's Landing National Historical Reserve",
//     //   'Fort Vancouver National Historic Site',
//     //   'John Day Fossil Beds National Monument',
//     //   'Lake Chelan National Recreation Area',
//     //   'Lake Roosevelt National Recreation Area',
//     //   'Lewis and Clark National Historical Park',
//     //   'Mount Rainier National Park',
//     //   'North Cascades National Park',
//     //   'Olympic National Park',
//     //   'Oregon Caves National Monument and Preserve',
//     //   'Ross Lake National Recreation Area',
//     //   'San Juan Island National Historical Park',
//     //   'Whitman Mission National Historic Site',
//     // ],
//
//   'Federal land': 'all',
//     // or pick from:
//     // [
//     //   'Bureau of Land Management',
//     //   'National Park Service',
//     //   'Other federal fee manager',
//     //   'U.S. Bureau of Reclamation',
//     //   'U.S. Department of Defense',
//     //   'U.S. Fish and Wildlife Service',
//     //   'U.S. Forest Service',
//     // ],
//
//   'Tribal land': 'all',
//     // 66 options, see data/divisions/tribal-land.geojson
//
//   'ODF protection district': 'all',
//     // or pick from:
//     // [
//     //   'Central Oregon District',
//     //   'Coos FPA',
//     //   'Douglas FPA',
//     //   'Klamath-Lake District',
//     //   'North Cascade District',
//     //   'Northeast Oregon District',
//     //   'Northwest Oregon District',
//     //   'South Cascade District',
//     //   'Southwest Oregon District',
//     //   'Walker Range FPA',
//     //   'West Oregon District',
//     //   'Western Lane District',
//     // ],
//
//   'Camera': 'all',
//     // cameras come from the live provider feeds, so this group is all or nothing
//
// MAP LAYERS
//   layers appear in the legend in the order they are listed
//   a layer left out has no legend row, is never drawn, and does not request its data
//   (camera and viewshed data still load because the filters and results use them)
//
//   'Cameras',
//   'Camera viewsheds',
//   'Standing lookouts',
//   'National forests',
//   'BLM lands',
//   'OR Burn probability (QWRA)',
//   'Fires (NIFC)',
//   'Prescribed fires (Watch Duty)',
//
// ---------------------------------------------------------------------------
// WHAT THE SITE SHOWS
// ---------------------------------------------------------------------------

export const VISIBLE_FILTERS = {
  'State': 'all',
  'County': 'all',
  'State House': 'all',
  'US House': 'all',
  'State Senate': 'all',
  'Utility provider': ['Pacific Power (PacifiCorp)', 'Portland General Electric (PGE)'],
  'National Forest': 'all',
  'National Park': 'all',
  'Federal land': ['Bureau of Land Management', 'U.S. Forest Service'],
  'Tribal land': 'all',
  'ODF protection district': 'all',
  'Camera': 'all',
};

export const VISIBLE_LAYERS = [
  'Cameras',
  'Camera viewsheds',
  'Standing lookouts',
  'National forests',
  'BLM lands',
  'OR Burn probability (QWRA)',
  'Fires (NIFC)',
  'Prescribed fires (Watch Duty)',
];
