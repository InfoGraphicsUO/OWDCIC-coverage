The production map reads the camera polygons from Mapbox vector tileset  
`infographics.s4u0rv`. Its source layer is `camera_viewsheds`; both values live  
in `js/config.js`

`viewshed-manifest.json` stays in this directory. It links live ALERTWest camera
names and IDs to each vector feature's stable `viewshed_id`, which lets camera
clicks apply the yellow selection filter

If you have the DEMs and camera sites geojson, you can run `Run GDAL Viewsheds.command`
to recalculate camera viewsheds. It runs through GDAL+Python and will have a GUI
that walks through inputs and outputs. I chose to use GDAL instead of ArcPro because
it ended up saving a lot of time and it was easy to incorporate into QGIS