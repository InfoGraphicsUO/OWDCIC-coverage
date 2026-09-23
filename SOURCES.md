# Project Sources

This inventory covers source references in the map configuration, source-building scripts, generated data metadata, and the source files kept in `data/`.

## Camera and lookout records

- **Live AlertWest cameras and feed metadata:** [AlertWest fire camera API](https://api.cdn.prod.alertwest.com/api/firecams/v0/cameras); camera-console links use [AlertWest Live](https://alertwest.live/cam-console/).
- **Camera site coordinates and observer heights:** project table [Site Installation Dates (Site, Coordinates, & Elevation).csv](<data/Site Installation Dates(Site, Coordinates, & Elevation).csv>); mapped derivative [sites.geojson](data/sites.geojson).
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
- **Local division GeoJSON products:** [county.geojson](data/divisions/county.geojson), [counties.geojson](data/divisions/counties.geojson), [federal-land.geojson](data/divisions/federal-land.geojson), [house.geojson](data/divisions/house.geojson), [national-forest.geojson](data/divisions/national-forest.geojson), [national-park.geojson](data/divisions/national-park.geojson), [senate.geojson](data/divisions/senate.geojson), [state.geojson](data/divisions/state.geojson), [tribal-land.geojson](data/divisions/tribal-land.geojson), [utility.geojson](data/divisions/utility.geojson), and [us-house.geojson](data/divisions/us-house.geojson).
- [or-wa-boundary.geojson](data/or-wa-boundary.geojson) is a local regional boundary file; its file contains no upstream source metadata.

## Ownership, hydrography, and coverage metrics

- **PAD-US fee ownership:** [Fee Managers PAD-US](https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0) and [Federal Fee Managers Authoritative PAD-US](https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Federal_Fee_Managers_Authoritative_PADUS/FeatureServer/0).
- **Census areal hydrography:** [TIGERweb Hydro, layer 1](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1).
- **Land outline used in regional processing:** [Esri World Countries (Generalized), layer 0](https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/World_Countries_(Generalized)/FeatureServer/0). The local [Pacific Northwest land mask](data/pacific-northwest-land-mask.geojson) records this service as its source.
- **Local coverage summary:** [camera-coverage.json](data/camera-coverage.json) records source endpoints and input hashes for its ownership and viewshed coverage data.

## Elevation and camera viewsheds

- **Terrain elevation:** USGS 3D Elevation Program (3DEP), 1/3 arc-second GeoTIFF products from The National Map. The selected tiles and direct download URLs are exhaustively listed in [or-wa-dems-latest.csv](data/or-wa-dems-latest.csv) and [or-wa-dems-latest-urls.txt](data/or-wa-dems-latest-urls.txt) (80 tiles in the current list).
- **Viewshed products:** the map loads the hosted [Mapbox camera viewsheds tileset](https://console.mapbox.com/studio/tilesets/infographics.s4u0rv/) (`mapbox://infographics.s4u0rv`). The local [viewshed manifest](data/viewshed-manifest.json) catalogs the generated camera viewshed products.
- **Regional clipping geometry:** [Pacific Northwest land mask](data/pacific-northwest-land-mask.geojson), sourced from the Esri World Countries service listed above.

## Map styles, tiles, and web resources

- **Mapbox basemap styles:** [Outdoors](https://api.mapbox.com/styles/v1/infographics/cmspb7yx9000s01px89hr8i1a) and [Simple](https://api.mapbox.com/styles/v1/infographics/cmud7fy6n000a01rghxd37aiz); the satellite basemap is `mapbox://mapbox.satellite`.
- **Mapbox terrain elevation tiles:** `mapbox://mapbox.mapbox-terrain-dem-v1`.
- **Annual burn probability:** [Pacific Northwest QWRA burn-probability tiles](https://tiles.arcgis.com/tiles/CD5mKowwN6nIaqd8/arcgis/rest/services/project_wre_bp_tile_package/MapServer/tile/{z}/{y}/{x}); the map labels the layer “OR Burn probability (QWRA)” and identifies the vintage as 2023.
- **QGIS project basemap:** [OpenStreetMap raster tiles](https://tile.openstreetmap.org/{z}/{x}/{y}.png), referenced by the QGIS project builder.
- **Map attribution:** [University of Oregon InfoGraphics Lab](https://infographics.uoregon.edu/) and [OHAZ](https://ohaz.uoregon.edu/).
- **Browser libraries and fonts:** [Mapbox GL JS 3.28.1](https://api.mapbox.com/mapbox-gl-js/v3.28.1/mapbox-gl.js) and [CSS](https://api.mapbox.com/mapbox-gl-js/v3.28.1/mapbox-gl.css), [Plotly 2.35.2](https://cdn.plot.ly/plotly-2.35.2.min.js), [Font Awesome kit](https://kit.fontawesome.com/be4ea184d4.js), and [Google Fonts — Merriweather](https://fonts.googleapis.com/css2?family=Merriweather:wght@400;500;600;700&display=swap).
