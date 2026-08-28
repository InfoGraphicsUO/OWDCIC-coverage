#!/bin/zsh
set -euo pipefail

RUNNER_DIR=${0:A:h}
QGIS_APP=${OWDCIC_QGIS_ROOT:-/Applications/QGIS-final-4_2_1.app}

export OWDCIC_QGIS_ROOT="$QGIS_APP"
export PYTHONPATH="$QGIS_APP/Contents/Resources/python3.12/site-packages"
export QT_PLUGIN_PATH="$QGIS_APP/Contents/PlugIns"
export QGIS_PREFIX_PATH="$QGIS_APP"
export PROJ_DATA="$QGIS_APP/Contents/Resources/qgis/proj"
export GDAL_DATA="$QGIS_APP/Contents/Resources/qgis/gdal"

exec "$QGIS_APP/Contents/MacOS/python" "$RUNNER_DIR/scripts/gdal-viewshed-gui.py"
