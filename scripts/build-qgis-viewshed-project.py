#!/usr/bin/env python3
"""builds a QGIS review project with an OpenStreetMap basemap"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from qgis_runtime import QgisRuntime, default_qgis_root, qgis_runtime


DEFAULT_QGIS_ROOT = default_qgis_root()
DEFAULT_BOUNDARY = Path(__file__).resolve().parents[1] / "data/or-wa-boundary.geojson"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gpkg", type=Path)
    parser.add_argument("--web-gpkg", type=Path)
    parser.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
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
    args.gpkg = args.gpkg.resolve() if args.gpkg else None
    args.web_gpkg = args.web_gpkg.resolve() if args.web_gpkg else None
    args.boundary = args.boundary.resolve() if args.boundary else None
    args.output = args.output.resolve()
    if args.gpkg and not args.gpkg.is_file():
        args.gpkg = None
    if args.web_gpkg and not args.web_gpkg.is_file():
        args.web_gpkg = None
    if args.boundary and not args.boundary.is_file():
        raise FileNotFoundError(f"review boundary not found: {args.boundary}")
    if not args.gpkg and not args.web_gpkg:
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

        coverage = None
        individuals = None
        exact = None
        boundary = None
        if args.boundary:
            boundary = QgsVectorLayer(
                str(args.boundary),
                "Oregon and Washington clipping boundary",
                "ogr",
            )
            if not boundary.isValid():
                raise RuntimeError(f"QGIS could not load {args.boundary}")
            boundary_symbol = boundary.renderer().symbol()
            boundary_symbol.setColor(QColor(0, 0, 0, 0))
            boundary_symbol.symbolLayer(0).setStrokeColor(QColor(190, 45, 45, 255))
            boundary_symbol.symbolLayer(0).setStrokeWidth(0.7)

        if args.web_gpkg:
            coverage = QgsVectorLayer(
                f"{args.web_gpkg}|layername=camera_viewshed_coverage",
                "Published coverage — dissolved",
                "ogr",
            )
            individuals = QgsVectorLayer(
                f"{args.web_gpkg}|layername=camera_viewsheds",
                "Published viewsheds — individual cameras",
                "ogr",
            )
            if not coverage.isValid() or not individuals.isValid():
                raise RuntimeError(f"QGIS could not load {args.web_gpkg}")
            coverage_symbol = coverage.renderer().symbol()
            coverage_symbol.setColor(QColor(0, 164, 214, 88))
            coverage_symbol.symbolLayer(0).setStrokeColor(QColor(0, 91, 127, 230))
            coverage_symbol.symbolLayer(0).setStrokeWidth(0.45)

            individual_symbol = individuals.renderer().symbol()
            individual_symbol.setColor(QColor(248, 225, 9, 45))
            individual_symbol.symbolLayer(0).setStrokeColor(QColor(248, 225, 9, 210))
            individual_symbol.symbolLayer(0).setStrokeWidth(0.65)

        if args.gpkg:
            exact = QgsVectorLayer(
                f"{args.gpkg}|layername=camera_viewsheds",
                "Camera viewsheds — exact 10 m",
                "ogr",
            )
            if not exact.isValid():
                raise RuntimeError(f"QGIS could not load {args.gpkg}")
            exact_symbol = exact.renderer().symbol()
            exact_symbol.setColor(QColor(0, 164, 214, 35))
            exact_symbol.symbolLayer(0).setStrokeColor(QColor(0, 91, 127, 150))
            exact_symbol.symbolLayer(0).setStrokeWidth(0.25)

        osm_uri = (
            "type=xyz&url=https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            "&zmin=0&zmax=19&crs=EPSG3857"
        )
        basemap = QgsRasterLayer(osm_uri, "OpenStreetMap", "wms")
        if not basemap.isValid():
            raise RuntimeError("QGIS could not initialize the OpenStreetMap XYZ layer")
        basemap.setCustomProperty("attribution", "© OpenStreetMap contributors")

        project.addMapLayer(basemap, False)
        for layer in (coverage, individuals, exact, boundary):
            if layer:
                project.addMapLayer(layer, False)
        root = project.layerTreeRoot()
        if exact:
            exact_node = root.insertLayer(0, exact)
            exact_node.setItemVisibilityChecked(False)
        if individuals:
            individual_node = root.insertLayer(0, individuals)
            individual_node.setItemVisibilityChecked(False)
        if coverage:
            root.insertLayer(0, coverage)
        if boundary:
            root.insertLayer(0, boundary)
        root.addLayer(basemap)

        extent_layer = coverage or individuals or exact
        extent = extent_layer.extent()
        extent.grow(max(extent.width(), extent.height()) * 0.04)
        project.viewSettings().setDefaultViewExtent(
            QgsReferencedRectangle(extent, extent_layer.crs())
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
