# Cameras ready for viewsheds

Updated October 8, 2026. Regenerate site data and these queues with:

```powershell
python scripts/csv-to-geojson.py
```

## Ready: 8 ALERTWest locations

Load `data/alertwest-sites-needing-viewsheds.geojson` in the GDAL viewshed GUI, or use it with the script:

```powershell
python scripts/gdal-camera-viewsheds.py --sites data/alertwest-sites-needing-viewsheds.geojson --mode production --product-name alertwest-camera-viewsheds --output-dir outputs/alertwest-new-sites
```

Use your usual QGIS Python environment, DEM directory, radius, and resolution settings. `production` processes every site in this eight-site file; the default pilot mode does not.

After the latest main update, CLI/GUI defaults are **12 miles** and **3 smoothing passes**. Use **Full run (polygons, Mapbox products, manifest)** in the GUI for site integration. The command above already uses full-run mode. `--shapefiles-only exact` / `--shapefiles-only web` are available for ArcGIS exports, but skip the manifest and Mapbox products.

| Site | Camera height (ft) | Location source |
| --- | ---: | --- |
| Phoenix Water Tank | 25 | Installation sheet coordinates |
| Mt Defiance | 95 | Digitized |
| Halfway | 56.75 | Digitized |
| Jim Creek Butte | 32.8 | Archived ALERTWest |
| Satus | 32.8 | Archived ALERTWest |
| Elephant | 10 | Archived ALERTWest |
| Two Rivers | 130 | Archived ALERTWest |
| Round Mountain Chelan | 80 | Archived ALERTWest |

Halfway uses the digitized lookout as requested, about 5.1 km from the archived API point. This is a location-priority decision, not independent confirmation that the archive was wrong. Duplicate camera heads at Halfway and Mt Defiance share one modeled location each.

## Still blocked

- Natapoc Ridge and Natapoc Ridge North: coordinates included, but confirm which camera gets the sheet's 89 ft / 84 ft height. Not in the runnable queue.
- Dry Mountain: missing camera height.
- Gold Hill: missing coordinates and height; not mapped.
- All 10 added Pano locations: missing confirmed observer heights. Includes Round Butte and Warm Springs as two distinct digitized sites.
- Mullan's 173.9 ft and Round Butte's 100 ft are candidate tower heights only, retained as metadata.

`data/camera-viewsheds-blocked.json` lists every blocked site. The Pano runnable GeoJSON is currently empty; do not run it yet. Existing PGE viewshed polygons remain external source material, not validated/published site coverage.

## Integration notes

- `data/camera-site-supplements.json` records source references, aliases, and review notes. Digitized ids resolve against the local GeoJSON on each build; other points use archived API/PGE coordinates.
- 86 ALERTWest sites and 34 Pano sites. ALERTWest still uses live camera metadata, with explicit site-id location corrections; Pano markers use the generated sites directly.
- Mullen/Mullan is one site. Round Butte and Warm Springs remain separate. Providers at a shared tower remain separate because observer heights can differ.
- New sites have no published viewshed association until the manifest matches a completed model. Existing completed models are unchanged.
- Phoenix's 25 ft height was confirmed by Owen on October 8 and entered in the canonical CSV; the downloaded copies still have a blank height. Its existing manifest still records the previous skipped run until a new viewshed is generated.
- The eight-site run produces a **partial** manifest/tileset. Merge its products with existing ALERTWest products before publishing; do not replace the full manifest or tileset with only these eight sites. Then rebuild combined coverage and derived metrics, and rerun the converter.
