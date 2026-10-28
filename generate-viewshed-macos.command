#!/bin/zsh
set -euo pipefail

RUNNER_DIR=${0:A:h}

# use OWDCIC_QGIS_ROOT when set, otherwise the newest QGIS in /Applications
installed=(/Applications/QGIS*.app(N/n))
QGIS_APP=${OWDCIC_QGIS_ROOT:-${installed[-1]:-}}

if [[ -z "$QGIS_APP" || ! -x "$QGIS_APP/Contents/MacOS/python" ]]; then
  echo "QGIS was not found in /Applications."
  echo "Install QGIS from https://qgis.org, or set OWDCIC_QGIS_ROOT to its app and run this launcher again."
  exit 1
fi

# the bundled Python's version changes between QGIS releases
site_packages=("$QGIS_APP"/Contents/Resources/python3*/site-packages(N/))

# point the QGIS-bundled python at its own GDAL, PROJ, and Qt instead of any system copies
export OWDCIC_QGIS_ROOT="$QGIS_APP"
export PYTHONPATH="${site_packages[1]:-}"
export QT_PLUGIN_PATH="$QGIS_APP/Contents/PlugIns"
export QGIS_PREFIX_PATH="$QGIS_APP"
export PROJ_DATA="$QGIS_APP/Contents/Resources/qgis/proj"
export GDAL_DATA="$QGIS_APP/Contents/Resources/qgis/gdal"

exec "$QGIS_APP/Contents/MacOS/python" "$RUNNER_DIR/scripts/gdal-viewshed-gui.py"
