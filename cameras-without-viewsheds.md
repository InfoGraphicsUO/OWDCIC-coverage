# OWDCIC cameras without matched viewsheds

Updated October 8, 2026. 83 ALERTWest and 24 Pano AI sites have published viewsheds.
The sites below are in the installation sheet but have no viewshed yet;
`data/camera-viewsheds-blocked.json` is the generated copy of this list.

## ALERTWest: 4 sites

| Site | Needed before a viewshed can be run |
| --- | --- |
| Natapoc Ridge | Confirm which camera (8603 or 15871) gets the sheet's 89 ft height |
| Natapoc Ridge North | Confirm which camera (8603 or 15871) gets the sheet's 84 ft height; North is provisionally the northern point |
| Dry Mountain | Camera height. Location is digitized (43.671954, -119.563696) |
| Gold Hill | Coordinates and camera height; not mapped |

## Pano AI: 10 sites

All ten lack a confirmed camera height: Sycan Substation, Latgawa Mountain, Round Butte,
Warm Springs, Biglow Canyon, Sidwalter, Mill City, Lyons, Mullan Substation, and Waitsburg.

- The sheet lists **Round Butte (Warm Springs)**; PGE lists these as two sites, and both are kept. Confirm which one the sheet means.
- The sheet's **Mullen** is PGE's **Mullan Substation**.
- `PGE-towers_reduced1.csv` gives tower heights for Mullan (173.9 ft) and Round Butte (100 ft). These are candidates only, not camera heights.
- PGE supplied its own viewshed polygons for these sites (`PGE_WF_Cameras_Viewsheds.shp`). They have not been validated or imported.

## Live ALERTWest cameras not matched to a site

Carried over from the earlier inventory; not rechecked against the live API on October 8.

- Camera ID 17952, **Axis-JackassButte**: about 1.1 km from the modeled viewshed site
- Camera ID 23723, **Axis-RattlesnakeHills**: about 1.4 km from the modeled viewshed site
- Camera ID 16734, **Axis-Anderson**: not in the installation sheet

The web map joins live ALERTWest cameras to viewsheds by ALERTWest site id, then by location
(nearest viewshed site within 250 m, `js/geojson-transform.js`), then by name.

## Location notes for modeled sites

- **Halfway** uses the digitized lookout (44.859994, -117.088277), about 5.1 km from the archived API point (44.8814, -117.0316). This was a location-priority choice, not confirmation that the archive was wrong.
- Duplicate camera heads at Halfway and Mt Defiance share one modeled location each.
- Coordinate sources and aliases for the October 2026 additions are recorded in `data/camera-site-supplements.json`.

## Adding viewsheds once a site is unblocked

1. Enter the height or coordinates in the installation sheet or `data/camera-site-supplements.json`, then run `python3 scripts/csv-to-geojson.py`. Runnable sites land in `data/<provider>-sites-needing-viewsheds.geojson`.
2. Open `Run GDAL Viewsheds.command` (`.bat` on Windows). Load that queue file, keep the provider's existing output folder and the same DEMs, radius, and resolution, choose **All cameras** and **Full run**, and tick **Also rebuild the combined coverage tileset**. Only the queued sites are computed; the manifest and tilesets cover every camera saved in the folder.
3. Copy the new manifest from the output folder to `data/<provider>-viewshed-manifest.json` and rerun the converter to clear the queue.
4. Replace the provider and combined tilesets in Mapbox Studio (ids are in `js/config.js`).
5. Rebuild the metrics with the QGIS Python: `scripts/build-selection-metrics.py` (update its expected viewshed count first).
