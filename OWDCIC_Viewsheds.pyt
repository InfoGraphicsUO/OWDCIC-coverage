"""ArcGIS Pro Python toolbox for the OWDCIC camera viewshed workflow"""

import importlib.util
import sys
from pathlib import Path

import arcpy


TOOLBOX_ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = TOOLBOX_ROOT / "outputs" / "viewsheds"


def prefer_existing(*paths):
    """prefers portable same-folder files then the repository layout"""

    for path in paths:
        if path.exists():
            return path
    return paths[0]


WORKFLOW_SCRIPT = prefer_existing(
    TOOLBOX_ROOT / "bulk-camera-viewsheds.py",
    TOOLBOX_ROOT / "scripts" / "bulk-camera-viewsheds.py",
)
DEFAULT_SITES = prefer_existing(
    TOOLBOX_ROOT / "sites.geojson",
    TOOLBOX_ROOT / "data" / "sites.geojson",
)
DEFAULT_DEMS = prefer_existing(
    TOOLBOX_ROOT / "dems",
    TOOLBOX_ROOT / "data" / "dems",
)


def load_workflow_module():
    """loads the shared script despite its command-line-friendly hyphenated name"""

    module_name = "owdcic_bulk_camera_viewsheds"
    spec = importlib.util.spec_from_file_location(module_name, WORKFLOW_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load workflow script: {WORKFLOW_SCRIPT}")

    # dataclasses resolve their module through sys.modules during import
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class Toolbox:
    def __init__(self):
        self.label = "OWDCIC Viewsheds"
        self.alias = "owdcic_viewsheds"
        self.tools = [BuildCameraViewsheds]


class BuildCameraViewsheds:
    def __init__(self):
        self.label = "Build Camera Viewsheds"
        self.description = (
            "Creates one 20-mile geodesic viewshed raster per camera using every "
            "GeoTIFF in the selected DEM directory."
        )
        self.canRunInBackground = False

    def getParameterInfo(self):
        sites = arcpy.Parameter(
            displayName="Camera sites GeoJSON",
            name="sites_geojson",
            datatype="DEFile",
            parameterType="Required",
            direction="Input",
        )
        sites.value = str(DEFAULT_SITES)
        sites.filter.list = ["geojson"]

        dem_directory = arcpy.Parameter(
            displayName="DEM directory",
            name="dem_directory",
            datatype="DEFolder",
            parameterType="Required",
            direction="Input",
        )
        dem_directory.value = str(DEFAULT_DEMS)

        # fixed output path keeps the tool dialog limited to the two source inputs
        output_geodatabase = arcpy.Parameter(
            displayName="Output viewshed geodatabase",
            name="output_geodatabase",
            datatype="DEWorkspace",
            parameterType="Derived",
            direction="Output",
        )

        return [sites, dem_directory, output_geodatabase]

    def isLicensed(self):
        return arcpy.CheckExtension("Spatial") == "Available"

    def updateMessages(self, parameters):
        sites_text = parameters[0].valueAsText
        if sites_text and Path(sites_text).suffix.casefold() != ".geojson":
            parameters[0].setErrorMessage("Select the sites.geojson file")

        dem_text = parameters[1].valueAsText
        if dem_text and Path(dem_text).is_dir():
            has_tiffs = any(
                path.is_file() and path.suffix.casefold() in {".tif", ".tiff"}
                for path in Path(dem_text).rglob("*")
            )
            if not has_tiffs:
                parameters[1].setErrorMessage("The DEM directory contains no TIFF files")

    def execute(self, parameters, messages):
        workflow = load_workflow_module()
        sites_path = Path(parameters[0].valueAsText)
        dem_directory = Path(parameters[1].valueAsText)

        # toolbox runs rebuild generated data so outputs always match both inputs
        result = workflow.run_workflow(
            sites_path=sites_path,
            dem_dir=dem_directory,
            output_dir=OUTPUT_DIR,
            radius_km=workflow.DEFAULT_RADIUS_KM,
            rebuild_mosaic=True,
            overwrite_viewsheds=True,
            polygons=False,
            export_geojson=False,
            cpu_only=False,
        )
        parameters[2].value = result.geodatabase

        arcpy.AddMessage(
            f"Processed {result.site_count} camera records with {result.dem_count} DEMs"
        )
        if result.failures:
            arcpy.AddWarning(
                f"{result.failures} camera viewshed(s) failed; see viewshed_run.csv"
            )
