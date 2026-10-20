# OWDCIC cameras without matched viewsheds

Updated October 20, 2026. 85 ALERTWest, 69 Pano AI, and 87 EnviroVision sites have published viewsheds.
The sites below are in the installation sheet but have no viewshed yet; every other
site with a location and camera height is modeled. Gold Hill and Dry Mountain use
heights the sheet marks as estimated.

## Blocked: 3 sites

`data/camera-viewsheds-blocked.json` is the generated copy of this list.

| Site | Provider | Needed before a viewshed can be run |
| --- | --- | --- |
| Natapoc Ridge | ALERTWest | Confirm which camera (8603 or 15871) gets the sheet's 89 ft height |
| Natapoc Ridge North | ALERTWest | Confirm which camera (8603 or 15871) gets the sheet's 84 ft height; North is provisionally the northern point |
| Anderson | ALERTWest | Coordinates; the sheet gives only an estimated 50 ft height, so it is not mapped |

**Clearwater Wind Farm** (Pano AI, PGE table) is held out of the map: its sheet coordinates
(46.85, -106.01) are in Montana. Remove it from `excluded` in `data/camera-site-supplements.json` once clarified.

## Pano AI notes

- The sheet's **Mullen** is PGE's **Mullan Substation**.
- The PGE rows are rounded to 0.01°, so sites keep their digitized or PGE camera-source points where one exists. Hazel Dell has no better source and sits on the rounded point.
- **Timberline** shares the ALERTWest Timberline Lodge location with its own 79.99 ft height.
- `PGE-towers_reduced1.csv` gives tower heights for Mullan (173.9 ft) and Round Butte (100 ft). The sheet's camera heights (64.99 ft and 81.99 ft) are used instead.
- PGE supplied its own viewshed polygons (`PGE_WF_Cameras_Viewsheds.shp`). They have not been validated or imported.

## EnviroVision notes

All 87 sites in ODF's geodatabase are modeled. See the readme in the OHAZ network folder
(`Data/ODF-info/README.md`) for the source's caveats.

- Seven sites use ODF's 60 ft planning default, flagged `cameraHeightEstimated`: Crescent Butte, Eden, Frazier Mountain, King Mountain, Parker Mountain, Shutters Landing, and Weston.
- **Menasha** is modeled at the geodatabase point (42.674371, -124.311772). ODF's coordinate columns put it about 850 m away, where the ground matches the record's elevation; confirm with ODF.
- Little Grayback, Reuben, Soda Mountain, and Tombstone have two cameras at different heights and are modeled from the taller one.

## Live ALERTWest cameras not matched to a site

Carried over from the earlier inventory; not rechecked against the live API on October 8.

- Camera ID 17952, **Axis-JackassButte**: about 1.1 km from the modeled viewshed site
- Camera ID 23723, **Axis-RattlesnakeHills**: about 1.4 km from the modeled viewshed site
- Camera ID 16734, **Axis-Anderson**: the sheet's Anderson row has no coordinates

The web map joins live ALERTWest cameras to viewsheds by ALERTWest site id, then by location
(nearest viewshed site within 250 m, `js/geojson-transform.js`), then by name.

## Location notes for modeled sites

- **Halfway** uses the digitized lookout (44.859994, -117.088277), about 5.1 km from the archived API point (44.8814, -117.0316). This was a location-priority choice, not confirmation that the archive was wrong.
- Duplicate camera heads at Halfway and Mt Defiance share one modeled location each.
- **Stacker Butte 2** (installed July 7, 2026, per the sheet's install-date list) is a second camera on the Stacker Butte tower. It is assumed to be at the same height with no added view, so the Stacker Butte viewshed covers it.
- Coordinate sources and aliases for the October 2026 additions are recorded in `data/camera-site-supplements.json`.
