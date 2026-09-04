#!/usr/bin/env python3
"""finds QGIS and describes its bundled GDAL/PROJ/Python layout across desktop platforms"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys
from typing import Mapping, Sequence


QGIS_ROOT_ENV = "OWDCIC_QGIS_ROOT"


def _version_key(path: Path) -> tuple[int, ...]:
    return tuple(map(int, re.findall(r"\d+", path.name)))


def default_qgis_root(
    platform_name: str = sys.platform,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """returns an explicit override or the newest standard QGIS install"""

    values = os.environ if environ is None else environ
    for variable in (QGIS_ROOT_ENV, "QGIS_ROOT", "OSGEO4W_ROOT"):
        if values.get(variable):
            return Path(values[variable])

    if platform_name == "darwin":
        return Path("/Applications/QGIS-final-4_2_1.app")

    if platform_name == "win32":
        standalone = []
        for variable in ("ProgramFiles", "ProgramW6432"):
            program_files = values.get(variable)
            if program_files:
                standalone.extend(Path(program_files).glob("QGIS *"))
        existing = [path for path in standalone if path.is_dir()]
        if existing:
            return max(existing, key=_version_key)
        return next(
            (path for path in (Path("C:/OSGeo4W"), Path("C:/OSGeo4W64")) if path.is_dir()),
            Path("C:/Program Files/QGIS"),
        )

    return Path("/usr")


def _first_directory(candidates: Sequence[Path], fallback: Path) -> Path:
    return next((path for path in candidates if path.is_dir()), fallback)


def _first_file(candidates: Sequence[Path]) -> Path | None:
    return next((path for path in candidates if path.is_file()), None)


@dataclass(frozen=True)
class QgisRuntime:
    root: Path
    prefix: Path
    tool_directories: tuple[Path, ...]
    proj_data: Path
    gdal_data: Path
    python_paths: tuple[Path, ...]
    qt_plugin_paths: tuple[Path, ...]
    qgis_executable: Path | None
    platform_name: str

    def environment(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        """builds a subprocess environment for QGIS, GDAL, and PROJ"""

        env = dict(os.environ if base is None else base)
        separator = ";" if self.platform_name == "win32" else ":"
        env[QGIS_ROOT_ENV] = str(self.root)
        env["QGIS_PREFIX_PATH"] = str(self.prefix)
        env["PROJ_DATA"] = str(self.proj_data)
        env["GDAL_DATA"] = str(self.gdal_data)
        env["PATH"] = separator.join(
            [*(str(path) for path in self.tool_directories), env.get("PATH", "")]
        ).rstrip(separator)

        if self.python_paths:
            env["PYTHONPATH"] = separator.join(
                [*(str(path) for path in self.python_paths), env.get("PYTHONPATH", "")]
            ).rstrip(separator)
        if self.qt_plugin_paths:
            env["QT_PLUGIN_PATH"] = separator.join(map(str, self.qt_plugin_paths))
        return env

    def qgis_launch(self, project: Path) -> tuple[str, list[str]]:
        """returns the native desktop command for opening a QGIS project"""

        if self.platform_name == "darwin":
            return "/usr/bin/open", ["-n", "-a", str(self.root), "--args", str(project)]
        if self.qgis_executable:
            return str(self.qgis_executable), [str(project)]
        raise RuntimeError(f"QGIS desktop executable not found under {self.root}")


def qgis_runtime(
    root: Path | None = None,
    platform_name: str = sys.platform,
) -> QgisRuntime:
    """maps a QGIS install root to its platform-specific runtime layout"""

    qgis_root = (root or default_qgis_root(platform_name)).expanduser().resolve()

    if platform_name == "darwin":
        prefix = qgis_root
        resources = qgis_root / "Contents/Resources/qgis"
        tools = (qgis_root / "Contents/MacOS",)
        python_paths = (qgis_root / "Contents/Resources/python3.12/site-packages",)
        qt_plugins = (qgis_root / "Contents/PlugIns",)
        executable = qgis_root / "Contents/MacOS/QGIS"
    elif platform_name == "win32":
        prefix = _first_directory(
            (qgis_root / "apps/qgis", qgis_root / "apps/qgis-ltr"),
            qgis_root,
        )
        tools = tuple(
            path
            for path in (qgis_root / "bin", prefix / "bin", qgis_root / "apps/gdal/bin")
            if path.is_dir()
        ) or (qgis_root / "bin",)
        proj_data = _first_directory(
            (qgis_root / "share/proj", prefix / "share/proj"),
            qgis_root / "share/proj",
        )
        gdal_data = _first_directory(
            (qgis_root / "share/gdal", prefix / "share/gdal"),
            qgis_root / "share/gdal",
        )
        python_paths = tuple(path for path in (prefix / "python",) if path.is_dir())
        qt_plugins = tuple(
            path
            for path in (
                prefix / "qtplugins",
                qgis_root / "apps/Qt6/plugins",
                qgis_root / "apps/Qt5/plugins",
            )
            if path.is_dir()
        )
        executable = _first_file(
            [
                qgis_root / "bin/qgis-bin.exe",
                qgis_root / "bin/qgis.exe",
                qgis_root / "bin/qgis-ltr-bin.exe",
                prefix / "bin/qgis-bin.exe",
                prefix / "bin/qgis.exe",
            ]
        )
        return QgisRuntime(
            qgis_root,
            prefix,
            tools,
            proj_data,
            gdal_data,
            python_paths,
            qt_plugins,
            executable,
            platform_name,
        )
    else:
        prefix = _first_directory((qgis_root / "share/qgis", qgis_root), qgis_root)
        tools = tuple(path for path in (qgis_root / "bin", Path("/usr/bin")) if path.is_dir())
        resources = _first_directory(
            (qgis_root / "share", Path("/usr/share")),
            qgis_root / "share",
        )
        python_paths = ()
        qt_plugins = ()
        executable = _first_file([qgis_root / "bin/qgis", Path("/usr/bin/qgis")])

    return QgisRuntime(
        qgis_root,
        prefix,
        tools,
        resources / "proj",
        resources / "gdal",
        python_paths,
        qt_plugins,
        executable if executable and executable.is_file() else None,
        platform_name,
    )
