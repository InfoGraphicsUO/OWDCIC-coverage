An interactive web map showing wildfire cameras, viewshed coverage, and fire activity across Oregon and Washington.
[Click here to view](https://infographicsuo.github.io/OWDCIC-coverage)

[Report issues, request features, or assign tasks in the issue tracker](https://github.com/InfoGraphicsUO/OWDCIC-coverage/issues)

## Download the viewsheds

Shapefiles of every camera viewshed, the same polygons the map shows, for use in ArcGIS or QGIS. Each zip has one layer per camera provider, the combined coverage, camera locations, and a README describing the fields.

- [Oregon](https://github.com/InfoGraphicsUO/OWDCIC-coverage/releases/latest/download/owdcic-viewsheds-oregon.zip)
- [Washington](https://github.com/InfoGraphicsUO/OWDCIC-coverage/releases/latest/download/owdcic-viewsheds-washington.zip)
- [Oregon and Washington](https://github.com/InfoGraphicsUO/OWDCIC-coverage/releases/latest/download/owdcic-viewsheds-or-wa.zip)

Older versions are on the [releases page](https://github.com/InfoGraphicsUO/OWDCIC-coverage/releases). To post a new release after publishing viewsheds, open the viewshed generator (`mac-generate-viewshed.command` or `win-generate-viewshed.bat`), choose the **Data release** run type, and click **Build data release**. Uploading needs the [GitHub CLI](https://cli.github.com) signed in with `gh auth login`.
