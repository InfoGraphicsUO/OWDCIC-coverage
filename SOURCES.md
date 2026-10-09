# Project Sources

This will function as a source repository so I can keep track of what sources I'm using to provide data

## Camera and lookout records

- **October 2026 site additions:** [camera-site-supplements.json](data/camera-site-supplements.json) resolves digitized ids first, then archived ALERTWest API and PGE camera points from the OHAZ network folder. The converter applies this supplement to the canonical sheet and builds provider-specific GDAL queues. [Sites still without viewsheds and how to add them](cameras-without-viewsheds.md). Tower-height candidates are retained separately from confirmed camera heights; existing PGE viewshed polygons have not been imported.

- **Live AlertWest cameras and feed metadata:** [AlertWest fire camera API](https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras); camera-console links use [AlertWest Live](https://alertwest.live/cam-console/).
- **Public PGE / Pano AI camera viewer:** [PGE Wildfire Watch](https://portlandgeneral.wildfirewatch.com/). Pano camera panels link to this viewer. The viewer blocks iframe embedding with `Content-Security-Policy: frame-ancestors 'none'` (checked October 1, 2026); individual camera deep links and an image feed have not been verified.
- **Camera site coordinates and observer heights:** project table [Site Installation Dates (Site, Coordinates, & Elevation).csv](data/Site Installation Dates(Site, Coordinates, & Elevation).csv), including the official Portland General Electric / Pano AI site table; mapped derivatives [alertwest-sites.geojson](data/alertwest-sites.geojson) (ALERTWest) and [pano-sites.geojson](data/pano-sites.geojson) (Pano AI), built by `scripts/csv-to-geojson.py`. Sites that match a digitized camera by name (within 2 km) use the digitized location, which is more accurate than the sheet's coordinates (the Pano AI rows are rounded to 0.01°).
- **Digitized camera inventory:** [digitized-camera-sources.xlsx](data/digitized-camera-sources.xlsx), [digitized-camera-sources.csv](data/digitized-camera-sources.csv), and [digitized-camera-sources.geojson](data/digitized-camera-sources.geojson). The CSV records **Oregon Wildfire Detection Network Map - PDF** as its map source; related Oregon Department of Forestry material: [Smoke Detection Cameras / Board of Forestry packet](https://www.oregon.gov/odf/board/bof/20240605-bof-packet.pdf). Row-level point-source references include `ODF_sites`, `PGE_WF_Cameras`, `standing-lookouts`, and `usfs_communications_sites`.
- **Standing fire lookouts:** [standing-lookouts.csv](data/standing-lookouts.csv) and [standing-lookouts.geojson](data/standing-lookouts.geojson); source references in the records are labeled `NHLR/FFLOS`. Related lists: [Forest Fire Lookout Association — Oregon](https://firelookout.org/lookouts/us/or/) and [Washington](https://firelookout.org/lookouts/us/wa/).



## Active fires and prescribed fires

- **Incident locations:** [Wildland Fire Interagency Geospatial Services (WFIGS), Current Incident Locations](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0).
- **Interagency fire perimeters:** [WFIGS, Current Interagency Perimeters](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0).
- **Prescribed fires:** [Watch Duty Prescribed Fires](https://services5.arcgis.com/VNhSlpl1umSknM3q/arcgis/rest/services/Watch_Duty_Prescribed_Fires/FeatureServer/0).



## Administrative, tribal, and public-land boundaries

- **U.S. Census TIGERweb — state and county boundaries:** [State/County layer 0](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0), [County layer 1](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1), and [State layer 10](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/10).
- **U.S. Census TIGERweb — legislative districts:** [Legislative layer 1](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/1), [layer 2](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/2), and [layer 4](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/4).
- **U.S. Census TIGERweb — tribal geographies:** [AIANNHA layer 2](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/2) and [layer 3](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/3).
- **National Park Service boundaries:** [NPS Regional and Park Boundary service, layer 1](https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NPS_Regional_and_Park_Boundary/FeatureServer/1).
- **U.S. Forest Service boundaries:** [EDW Forest System Boundaries, layer 0](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0) and [EDW Basic Ownership, layer 0](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_BasicOwnership_02/MapServer/0).
- **Bureau of Land Management ownership tiles:** [BLM National Surface Management Agency tiles](https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_BLM_Only/MapServer/tile/{z}/{y}/{x}).
- **Utility service areas:** [Oregon Natural Gas and Electric Utility Incentive Layer, layer 0](https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Oregon_Natural_Gas_and_Electric_Utility_Incentive_Layer_Update_13Dec2024_v01/FeatureServer/0); [Washington Ecology CPR service, layer 0](https://gis.ecology.wa.gov/serverext/rest/services/CPR/CPR/MapServer/0). The local utility dataset metadata notes Washington coverage as unavailable.
- **Oregon Department of Forestry protection districts:** [District Boundaries, layer 1](https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/District_Boundaries/FeatureServer/1).
- **Transmission lines:** [transmission-lines.geojson](data/transmission-lines.geojson), from the OHAZ network folder's 2024 archive of the public [U.S. Electric Power Transmission Lines service](https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0), clipped to the map's Oregon and Washington bounds with owner and voltage kept. The layer is off until a utility provider filter is picked, and the file is only requested then.
- **Local boundary files:** [data/divisions/](data/divisions/) contains the state, county, state House, state Senate, U.S. House, utility, national forest, national park, federal land, tribal land, and ODF protection district GeoJSON products. [or-wa-boundary.geojson](data/or-wa-boundary.geojson) is also used as a local regional boundary; its file contains no upstream source metadata.



## Ownership, hydrography, and coverage metrics

- **PAD-US fee ownership:** [Fee Managers PAD-US](https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0) and [Federal Fee Managers Authoritative PAD-US](https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0).
- **Census areal hydrography:** [TIGERweb Hydro, layer 1](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1).
- **Land outline used in regional processing:** [Esri World Countries (Generalized), layer 0](https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/World_Countries_(Generalized)/FeatureServer/0). The local [Pacific Northwest land mask](data/pacific-northwest-land-mask.geojson) records this service as its source.
- **Local coverage summary:** [camera-coverage.json](data/camera-coverage.json) records source endpoints and input hashes for its ownership and viewshed coverage data.



## Elevation and camera viewsheds

- **Terrain elevation:** USGS 3D Elevation Program (3DEP), 1/3 arc-second GeoTIFF products from The National Map. The selected tiles and direct download URLs are exhaustively listed in [or-wa-dems-latest.csv](data/or-wa-dems-latest.csv) and [or-wa-dems-latest-urls.txt](data/or-wa-dems-latest-urls.txt) (80 tiles in the current list).
- **Viewshed products:** the map loads the hosted [ALERTWest camera viewsheds tileset](https://console.mapbox.com/studio/tilesets/infographics.qn8uiv/) (`mapbox://infographics.qn8uiv`) and [Pano AI camera viewsheds tileset](https://console.mapbox.com/studio/tilesets/infographics.3eiwtk/) (`mapbox://infographics.3eiwtk`). A [combined coverage tileset](https://console.mapbox.com/studio/tilesets/infographics.4qzk4g/) (`mapbox://infographics.4qzk4g`), every provider's coverage dissolved by `scripts/build-combined-viewshed-coverage.py` or a viewshed run with `--combined-coverage`, draws shared-color viewsheds without overlapping fills. The local [ALERTWest](data/alertwest-viewshed-manifest.json) and [Pano AI](data/pano-viewshed-manifest.json) viewshed manifests catalog the generated camera viewshed products (83 ALERTWest and 24 Pano AI as of October 8, 2026); each provider has its own tileset.
- **Regional clipping geometry:** [Pacific Northwest land mask](data/pacific-northwest-land-mask.geojson), sourced from the Esri World Countries service listed above.



## Rebuilding local data

The builders in [scripts/data-builders/](scripts/data-builders/) download from the sources above and overwrite the committed files. All but the digitized camera builder (its shapefile is not in the repo) were rerun on October 8, 2026 and reproduced the committed boundaries. None of them needs rerunning for new cameras or viewsheds, only when the upstream source changes. After rebuilding any file in `data/divisions/`, run `scripts/build-selection-metrics.py` to refill its area and coverage fields, which the builders write as null.

- **`build-division-datasets.py`:** `state`, `county`, `house`, `senate`, `us-house`, and `national-forest` in `data/divisions/`, from Census TIGERweb and the Forest Service; `--only` limits the types. Rerun after redistricting or a new Congress (the layer ids and `CD119` field in the script change with them).
- **`build-official-park-tribal-data.py`:** `national-park.geojson` and `tribal-land.geojson`, from the National Park Service and Census AIANNHA layers 2 and 3. Rerun when a park boundary or trust land changes.
- **`build-odf-protection-districts.py`:** `odf-protection-district.geojson`. Rerun when ODF redraws a district.
- **`build-utility-federal-land.py`:** `utility.geojson` and `federal-land.geojson`. Rerun for a new PAD-US release (refresh the fee cache with `scripts/fetch-padus-fee.py` at the same time), or to add a utility or a Washington service-area layer. Needs the QGIS Python.
- **`build-viewshed-land-mask.py`:** [pacific-northwest-land-mask.geojson](data/pacific-northwest-land-mask.geojson). Rerun only if the regional bounds in the script change; every viewshed and metric then needs rebuilding too. Needs the QGIS Python.
- **`build-transmission-lines.py`:** [transmission-lines.geojson](data/transmission-lines.geojson), from `transmission_lines_2024_archive.gpkg` in the OHAZ network folder (not in this repo): `python scripts/data-builders/build-transmission-lines.py <transmission_lines_2024_archive.gpkg>`. Rerun when that archive is refreshed. Needs the QGIS Python.
- **`build-digitized-camera-sources.py`:** the three `digitized-camera-sources` files, from the `StatewideNetwork` shapefile in the OHAZ network folder (not in this repo): `python3 scripts/data-builders/build-digitized-camera-sources.py <StatewideNetwork.shp> data/digitized-camera-sources.geojson --tabular`. Rerun whenever that shapefile gains or moves sites, then rerun `scripts/csv-to-geojson.py`.

The DEM tile lists were filtered once from National Map CSV exports to the newest product per tile; that script and the exports are no longer in the repo.



## Map styles, tiles, and web resources

- **Mapbox basemap styles:** [Outdoors](https://api.mapbox.com/styles/v1/infographics/cmspb7yx9000s01px89hr8i1a) and [Simple](https://api.mapbox.com/styles/v1/infographics/cmud7fy6n000a01rghxd37aiz); the satellite basemap is `mapbox://mapbox.satellite`.
- **Mapbox terrain elevation tiles:** `mapbox://mapbox.mapbox-terrain-dem-v1`.
- **Annual burn probability:** [Pacific Northwest QWRA burn-probability tiles](https://tiles.arcgis.com/tiles/CD5mKowwN6nIaqd8/arcgis/rest/services/project_wre_bp_tile_package/MapServer/tile/{z}/{y}/{x})
- **QGIS project basemap:** [OpenStreetMap raster tiles](https://tile.openstreetmap.org/{z}/{x}/{y}.png)
- **Browser libraries and fonts:** [Mapbox GL JS/CSS 3.28.1](https://api.mapbox.com/mapbox-gl-js/v3.28.1/mapbox-gl.js), [Plotly 2.35.2](https://cdn.plot.ly/plotly-2.35.2.min.js), [Font Awesome kit](https://kit.fontawesome.com/be4ea184d4.js), and [Google Fonts — Merriweather](https://fonts.googleapis.com/css2?family=Merriweather:wght@400;500;600;700&display=swap).

