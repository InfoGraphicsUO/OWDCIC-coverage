# Camera viewshed workflow

See [`GDAL-viewshed-workflow.md`](GDAL-viewshed-workflow.md) for the complete
processing model, inputs, resume behavior, validation, and output contracts.

The production map reads `mapbox://infographics.s4u0rv`. The replacement
MBTiles contains two source layers:

- `camera_viewshed_coverage` is the dissolved blue display layer. It has no
  overlapping features, so coverage keeps one consistent opacity.
- `camera_viewsheds` preserves one feature per camera and its `viewshed_id`.
  Camera clicks filter this layer to draw the yellow highlight.

`viewshed-manifest.json` links live ALERTWest camera names and IDs to the stable
`viewshed_id` values. Rebuilding viewshed geometry does not require replacing
this checked-in manifest unless the camera list or ID mappings also change.

## Rebuild

Run `Run GDAL Viewsheds.command` on macOS or `Run GDAL Viewsheds.bat` on
Windows, select **Production — all 75 cameras**, and leave **Smooth web mask
with a 3×3 majority filter** and **Clip web polygons to Oregon and Washington**
enabled. The default sieve threshold of `0` preserves every patch that survives
the majority filter. The default single web smoothing pass rounds polygonized
raster corners after simplification without changing the exact 10 m outputs.

The majority filter and vector smoother are applied only to web products. The
saved 10 m rasters and exact EPSG:5070 polygons remain unchanged. A
smoothing-only configuration change reuses those analysis outputs, so the next
production run should start at web post-processing rather than recalculating
terrain visibility.

The checked-in `or-wa-boundary.geojson` is a union of Oregon and Washington
from the U.S. Census Bureau TIGERweb state layer. The pipeline projects it to
EPSG:5070 and clips after simplification, keeping the final web edge on the
state boundary. Use `--no-web-clip` only when an unclipped comparison is needed.
The QGIS review project draws this clipping boundary in red above the dissolved
coverage, individual web polygons, and untouched exact polygons.

The run writes publishing files under `outputs/gdal_viewsheds/mapbox/`:

- `camera-viewsheds.geojson` — individual camera features
- `camera-viewshed-coverage.geojson` — dissolved coverage
- `camera_viewsheds_web_epsg5070.gpkg` — both layers for QGIS review
- `camera-viewsheds-z5.mbtiles` — both layers tiled at zooms 5–12

Tippecanoe is detected from `PATH`, `/opt/homebrew/bin`, or `/usr/local/bin`.
If it is unavailable, the GeoJSON and GeoPackage files are still created and
the run log explains why the MBTiles step was skipped.

## Publish

In Mapbox Data Workbench, choose **Replace** for tileset
`infographics.s4u0rv` and upload `camera-viewsheds-z5.mbtiles`. Replacement
keeps the existing tileset ID. Confirm that both source layers above appear
before deploying web-map changes that reference `camera_viewshed_coverage`.

After Mapbox finishes processing, check several overlapping cameras: the blue
coverage should not darken, while clicking a camera should highlight its full
individual viewshed in yellow.
