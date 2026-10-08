# OWDCIC cameras without matched viewsheds

**Implementation update:** see [cameras-ready-for-viewsheds.md](cameras-ready-for-viewsheds.md) for the current eight-site GDAL queue, coordinate choices, and remaining blockers. Phoenix now has a confirmed 25 ft height and is ready to run. The inventory below predates the coordinate supplement and Phoenix height update.

## Installation sheet update — October 8, 2026

The newer installation sheet adds 20 named sites, all without latitude/longitude.
The existing 76 ALERTWest and 24 Pano AI sites, including their heights and corrected
locations, are unchanged and still match the viewshed manifests. The converter skips
rows without coordinates, so these additions are retained in the CSV but do not yet
appear in the generated GeoJSON. ALERTWest map markers come from the live API;
Pano AI markers come from `data/pano-sites.geojson`.

Nine new ALERTWest rows now supply heights for additional viewshed work:

| Site | Camera height (feet) | Previously identified camera IDs |
| --- | ---: | --- |
| Mt Defiance | 95 | 23607, 23608 |
| Halfway | 56.75 | 18030, 18031 |
| Jim Creek Butte | 32.8 | 23681 |
| Satus | 32.8 | 16187 |
| Elephant | 10 | 17909 |
| Two Rivers | 130 | 16405 |
| Round Mountain Chelan | 80 | 8604 |
| Natapoc Ridge North | 84 | Confirm which Natapoc camera/site |
| Natapoc Ridge | 89 | Confirm which Natapoc camera/site |

Resolve coordinates before generating these nine site viewsheds. The digitized camera
data has same-named Mt Defiance and Halfway locations that can be checked; the sheet
does not itself establish those locations. The two Natapoc rows need an explicit match
to cameras 8603 and 15871. A live API check returned HTTP 403 during this update, so the
camera IDs below remain historical references rather than a refreshed API inventory.

The other 11 additions lack both coordinates and heights: ALERTWest Gold Hill and Dry
Mountain; Pano AI Sycan Substation, Latgawa Mountain, Round Butte (Warm Springs), Biglow
Canyon, Sidwalter, Mill City, Lyons, Mullen Substation (WA), and Waitsburg (WA).

Phoenix Water Tank still lacks a height. Existing completed site viewsheds do not need
rerunning because of this sheet update. After resolving inputs and generating new
viewsheds, update the provider manifest and hosted tileset, rebuild combined coverage,
and refresh derived coverage metrics before treating them as available on the site.

## Previously identified unmatched cameras

Camera ID 16489 - **Axis-Phoenix**: cam height missing in sites data sheet

Camera ID 17952 - **Axis-JackassButte**: location mismatch with older viewshed (~1.1 km)

Camera ID 23723 - **Axis-RattlesnakeHills**: location mismatch with older viewshed (~1.4 km)

--

Camera ID 8603 - **Axis-NatapocRidge**: not present in sites data sheet

Camera ID 8604 - **Axis-RoundMtnChelan**: not present in sites data sheet

Camera ID 15871 - **Axis-NatapocRidge2**: not present in sites data sheet

Camera ID 16187 - **Axis-SatusPeak**: not present in sites data sheet

Camera ID 16405 - **Axis-TwoRivers**: not present in sites data sheet

Camera ID 16734 - **Axis-Anderson**: not present in sites data sheet

Camera ID 17909 - **Axis-Elephant**: not present in sites data sheet

Camera ID 18030 - **Axis-Halfway1**: not present in sites data sheet

Camera ID 18031 - **Axis-Halfway2**: not present in sites data sheet

Camera ID 23607 - **Axis-MountDefiance**: not present in sites data sheet

Camera ID 23608 - **Axis-MountDefiance2**: not present in sites data sheet

Camera ID 23681 - **Axis-jimcreekbutte**: not present in sites data sheet

--

Note: the web map joins live AlertWest cameras to viewsheds by AlertWest site id, then by location (nearest viewshed site within 250 m, js/geojson-transform.js), then by name. Camera ID 16489 (Axis-Phoenix) joins to its viewshed site but is skipped for missing height, so the panel says so explicitly.
