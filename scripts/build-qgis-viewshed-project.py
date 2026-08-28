#!/usr/bin/env python3
"""builds a QGIS review project with an OpenStreetMap basemap"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from qgis_runtime import QgisRuntime, default_qgis_root, qgis_runtime


DEFAULT_QGIS_ROOT = default_qgis_root()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gpkg", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--qgis-app", type=Path, default=DEFAULT_QGIS_ROOT)
    return parser.parse_args()


def configure_qgis(qgis_root: Path) -> QgisRuntime:
    runtime = qgis_runtime(qgis_root)
    os.environ.update(runtime.environment())
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    return runtime


def main() -> int:
    args = parse_args()
    args.gpkg = args.gpkg.resolve()
    args.output = args.output.resolve()
    if not args.gpkg.is_file():
        raise FileNotFoundError(f"combined viewshed layer not found: {args.gpkg}")

    runtime = configure_qgis(args.qgis_app)
    from qgis.PyQt.QtGui import QColor
    from qgis.core import (
        QgsApplication,
        QgsCoordinateReferenceSystem,
        QgsProject,
        QgsRasterLayer,
        QgsReferencedRectangle,
        QgsVectorLayer,
    )

    QgsApplication.setPrefixPath(str(runtime.prefix), True)
    application = QgsApplication([], False)
    application.initQgis()
    try:
        project = QgsProject.instance()
        project.clear()
        project.setCrs(QgsCoordinateReferenceSystem("EPSG:3857"))

        viewsheds = QgsVectorLayer(
            f"{args.gpkg}|layername=camera_viewsheds",
            "Camera viewsheds — exact 10 m",
            "ogr",
        )
        if not viewsheds.isValid():
            raise RuntimeError(f"QGIS could not load {args.gpkg}")
        symbol = viewsheds.renderer().symbol()
        symbol.setColor(QColor(0, 164, 214, 88))
        symbol_layer = symbol.symbolLayer(0)
        symbol_layer.setStrokeColor(QColor(0, 91, 127, 230))
        symbol_layer.setStrokeWidth(0.45)

        osm_uri = (
            "type=xyz&url=https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            "&zmin=0&zmax=19&crs=EPSG3857"
        )
        basemap = QgsRasterLayer(osm_uri, "OpenStreetMap", "wms")
        if not basemap.isValid():
            raise RuntimeError("QGIS could not initialize the OpenStreetMap XYZ layer")
        basemap.setCustomProperty("attribution", "© OpenStreetMap contributors")

        project.addMapLayer(viewsheds, False)
        project.addMapLayer(basemap, False)
        root = project.layerTreeRoot()
        root.insertLayer(0, viewsheds)
        root.addLayer(basemap)

        extent = viewsheds.extent()
        extent.grow(max(extent.width(), extent.height()) * 0.04)
        project.viewSettings().setDefaultViewExtent(
            QgsReferencedRectangle(extent, viewsheds.crs())
        )
        project.setTitle("OWDCIC GDAL viewshed review")
        project.setFileName(str(args.output))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if not project.write():
            raise RuntimeError(f"QGIS could not write project: {args.output}")
        print(args.output)
    finally:
        application.exitQgis()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
