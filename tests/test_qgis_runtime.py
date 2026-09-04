from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from qgis_runtime import (  # noqa: E402
    QGIS_ROOT_ENV,
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
            for directory in (
                bin_directory,
                prefix / "bin",
                prefix / "python",
                prefix / "qtplugins",
                root / "share/proj",
                root / "share/gdal",
            ):
                directory.mkdir(parents=True, exist_ok=True)

            qgis_executable = bin_directory / "qgis-bin.exe"
            qgis_executable.write_text("", encoding="utf-8")

            runtime = qgis_runtime(root, "win32")
            root = root.resolve()
            bin_directory = root / "bin"
            prefix = root / "apps/qgis"
            qgis_executable = bin_directory / "qgis-bin.exe"
            self.assertEqual(runtime.prefix, prefix)
            self.assertEqual(runtime.tool_directories, (bin_directory, prefix / "bin"))
            self.assertEqual(runtime.proj_data, root / "share/proj")
            self.assertEqual(runtime.gdal_data, root / "share/gdal")

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
