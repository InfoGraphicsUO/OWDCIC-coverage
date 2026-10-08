# New camera data notes

10-8-2026
New installation sheet has 20 additions. Found coordinates or candidates for 19; no Gold Hill match in the sources checked

## ALERTWest

Coordinates from the archived API records in `Camera Locations/Internal camera review prototype/public/cameras.json` in the ohaz network folder. Records are from June/August 2026, not a fresh API check. Heights are from the new installation sheet.

| Site | Latitude | Longitude | Height (ft) |
| --- | ---: | ---: | ---: |
| Mt Defiance | 45.648720 | -121.722685 | 95 |
| Halfway | 44.881400 | -117.031600 | 56.75 |
| Jim Creek Butte | 45.935980 | -116.935330 | 32.8 |
| Satus | 46.257481 | -120.753469 | 32.8 |
| Elephant | 46.522181 | -120.335462 | 10 |
| Two Rivers | 47.841117 | -120.844880 | 130 |
| Round Mountain Chelan | 47.785531 | -120.810220 | 80 |
| Natapoc Ridge / camera 8603 | 47.774650 | -120.697653 | confirm: 89? |
| Natapoc Ridge2 / camera 15871 | 47.780322 | -120.693583 | confirm: 84? |

- Halfway: digitized lookout is at **44.859994, -117.088277**, about **5.1 km** from the archived camera point.
- Natapoc: sheet says North = 84 ft, Ridge = 89 ft. Camera 15871 is farther north
- Mt Defiance: local digitized point **45.648648, -121.722655** closely agrees with the API snapshot.
- Dry Mountain: local digitized point **43.671954, -119.563696**. Still no camera height.
- Gold Hill: no coordinates or height found.
- Phoenix is unchanged and still missing a height.

## Pano / PGE

Coordinates from `Data/utilities_data_leland/PortlandGeneralElectric/PGE-pano_Cameras/Shapefiles/PGE_WF_Cameras.shp` on the OHAZ drive. All nine new sheet rows lack heights.

| Site | Latitude | Longitude |
| --- | ---: | ---: |
| Sycan Substation | 42.853416 | -120.988223 |
| Latgawa Mountain | 42.983900 | -120.829750 |
| Round Butte | 44.602043 | -121.267870 |
| Biglow Canyon | 45.637988 | -120.642817 |
| Sidwalter | 44.926284 | -121.539233 |
| Mill City | 44.761994 | -122.475961 |
| Lyons | 44.763300 | -122.631000 |
| Mullan Substation | 46.420010 | -118.027087 |
| Waitsburg | 46.411965 | -118.169382 |

- Sheet says **Mullen**; PGE says **Mullan Substation**. Likely the same site.
- Sheet says **Round Butte (Warm Springs)**, but PGE lists two sites. Warm Springs is **44.755004, -121.219036**. Need to confirm which one is intended
- `PGE-towers_reduced1.csv` lists **MULLAN SUB = 173.9 ft** and **Round Butte Sub (PRB) = 100 ft**. These are tower heights
- PGE already supplied polygons for all nine sites above, plus Warm Springs, in `PGE_WF_Cameras_Viewsheds.shp` / `.kmz`
- Several points also exist in our `data/digitized-camera-sources.geojson`
