from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from qgis_runtime import (  # noqa: E402
    QGIS_ROOT_ENV,
    REQUIRED_GDAL_TOOLS,
    default_qgis_root,
    qgis_runtime,
)


class QgisRuntimeTests(unittest.TestCase):
    def test_explicit_environment_override_wins(self) -> None:
        root = default_qgis_root("win32", {QGIS_ROOT_ENV: "D:/GIS/QGIS"})
        self.assertEqual(root, Path("D:/GIS/QGIS"))

    def test_windows_standalone_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "QGIS 4.2.1"
            bin_directory = root / "bin"
            prefix = root / "apps/qgis"
            python_scripts = root / "apps/Python312/Scripts"
            for directory in (
                bin_directory,
                prefix / "bin",
                prefix / "python",
                prefix / "qtplugins",
                python_scripts,
                root / "share/proj",
                root / "share/gdal",
            ):
                directory.mkdir(parents=True, exist_ok=True)

            for name in REQUIRED_GDAL_TOOLS:
                if name == "gdal_calc":
                    destination = python_scripts / f"{name}.py"
                else:
                    destination = bin_directory / f"{name}.exe"
                destination.write_text("", encoding="utf-8")
            qgis_executable = bin_directory / "qgis-bin.exe"
            qgis_executable.write_text("", encoding="utf-8")

            runtime = qgis_runtime(root, "win32")
            root = root.resolve()
            bin_directory = root / "bin"
            prefix = root / "apps/qgis"
            python_scripts = root / "apps/Python312/Scripts"
            qgis_executable = bin_directory / "qgis-bin.exe"
            runtime.validate_tools()
            self.assertEqual(runtime.prefix, prefix)
            self.assertEqual(runtime.tool("gdalwarp"), [str(bin_directory / "gdalwarp.exe")])
            self.assertEqual(
                runtime.tool("gdal_calc", "python.exe"),
                ["python.exe", str(python_scripts / "gdal_calc.py")],
            )

            environment = runtime.environment({"PATH": "C:/Windows/System32"})
            self.assertEqual(environment[QGIS_ROOT_ENV], str(root.resolve()))
            self.assertTrue(environment["PATH"].startswith(f"{bin_directory.resolve()};"))
            self.assertEqual(environment["QGIS_PREFIX_PATH"], str(prefix.resolve()))

            project = Path("D:/results/viewsheds.qgz")
            self.assertEqual(
                runtime.qgis_launch(project),
                (str(qgis_executable.resolve()), [str(project)]),
            )


if __name__ == "__main__":
    unittest.main()
