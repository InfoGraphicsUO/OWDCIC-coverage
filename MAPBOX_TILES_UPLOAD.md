# Upload the GDAL viewshed tiles to Mapbox

The lazy version:

1. Run the GDAL viewshed script.
2. Find the MBTiles file.
3. Upload it in Mapbox Studio.
4. Replace the tileset ID in `js/config.js`.

## 1. Run GDAL

Run the normal production job and wait for it to finish successfully.

The file you want should be here:

```text
outputs/gdal_viewsheds/mapbox/camera-viewsheds-z5.mbtiles
```

If that file does not exist, the script probably could not find `tippecanoe`. Install `tippecanoe`, then run the GDAL job again.

## 2. Upload the MBTiles file

1. Open [Mapbox Studio Tilesets](https://studio.mapbox.com/tilesets/).
2. Click **New tileset** or **Upload**.
3. Choose:

   ```text
   outputs/gdal_viewsheds/mapbox/camera-viewsheds-z5.mbtiles
   ```

4. Wait for Mapbox to finish processing it.
5. Open the new tileset and copy its tileset ID. It will look like:

   ```text
   username.camera-viewsheds-z5
   ```

Mapbox supports direct MBTiles uploads. Studio uploads have a 300 MB limit; for a larger file, use the Mapbox Uploads API instead. See [Mapbox's MBTiles guide](https://docs.mapbox.com/help/glossary/mbtiles/) and [Uploads API documentation](https://docs.mapbox.com/api/maps/uploads/).

## 3. Update the website

Open [`js/config.js`](js/config.js) and replace the old tileset ID:

```js
cameraViewsheds: 'mapbox://infographics.s4u0rv',
```

with the new one:

```js
cameraViewsheds: 'mapbox://YOUR_USERNAME.camera-viewsheds-z5',
```

Keep the two source-layer names as they are:

```js
cameraViewshedsSourceLayer: 'camera_viewsheds',
cameraViewshedsCoverageSourceLayer: 'camera_viewshed_coverage',
```

The GDAL script creates both layers in the MBTiles file.

## 4. Check it

Refresh the website locally or open the deployed site. Turn on the camera viewshed layer and confirm that:

- individual camera polygons appear;
- the dissolved coverage appears;
- clicking a camera still works.

If the layer is blank, the usual problem is a typo in the tileset ID or a changed source-layer name.

## Optional: large MBTiles files

If Mapbox Studio rejects the file because it is over 300 MB, upload it with the Mapbox Uploads API. The API accepts MBTiles files up to 25 GB, subject to the account's limits. You will need a Mapbox access token with upload permissions.

