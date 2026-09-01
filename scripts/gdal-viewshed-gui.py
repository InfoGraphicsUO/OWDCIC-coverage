#!/usr/bin/env python3
"""provides a native progress window for the GDAL camera viewshed runner"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import time

try:
    from qgis.PyQt.QtCore import QProcess, QTimer, QUrl
    from qgis.PyQt.QtGui import QDesktopServices
    from qgis.PyQt.QtWidgets import (
        QApplication,
        QCheckBox,
        QComboBox,
        QDoubleSpinBox,
        QFileDialog,
        QFormLayout,
        QGroupBox,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QMainWindow,
        QMessageBox,
        QPlainTextEdit,
        QProgressBar,
        QPushButton,
        QSpinBox,
        QVBoxLayout,
        QWidget,
    )
except ImportError:
    from PyQt6.QtCore import QProcess, QTimer, QUrl
    from PyQt6.QtGui import QDesktopServices
    from PyQt6.QtWidgets import (
        QApplication,
        QCheckBox,
        QComboBox,
        QDoubleSpinBox,
        QFileDialog,
        QFormLayout,
        QGroupBox,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QMainWindow,
        QMessageBox,
        QPlainTextEdit,
        QProgressBar,
        QPushButton,
        QSpinBox,
        QVBoxLayout,
        QWidget,
    )

from qgis_runtime import default_qgis_root, qgis_runtime


def qt_enum(owner, scope: str, member: str):
    """reads scoped Qt 6 enums with a Qt 5 fallback"""

    scoped = getattr(owner, scope, None)
    return getattr(scoped, member) if scoped else getattr(owner, member)


PROCESS_MERGED_CHANNELS = qt_enum(QProcess, "ProcessChannelMode", "MergedChannels")
PROCESS_NOT_RUNNING = qt_enum(QProcess, "ProcessState", "NotRunning")
MESSAGE_YES = qt_enum(QMessageBox, "StandardButton", "Yes")


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNNER = PROJECT_ROOT / "scripts/gdal-camera-viewsheds.py"
QGIS_PROJECT_BUILDER = PROJECT_ROOT / "scripts/build-qgis-viewshed-project.py"
DEFAULT_QGIS_ROOT = default_qgis_root()
PROGRESS_PREFIX = "@@PROGRESS@@"


class PathRow(QWidget):
    """line edit with a file or directory chooser"""

    def __init__(self, value: Path, directory: bool) -> None:
        super().__init__()
        self.directory = directory
        self.edit = QLineEdit(str(value))
        button = QPushButton("Browse…")
        button.clicked.connect(self.choose)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.edit, 1)
        layout.addWidget(button)

    def choose(self) -> None:
        if self.directory:
            selected = QFileDialog.getExistingDirectory(self, "Choose folder", self.edit.text())
        else:
            selected, _ = QFileDialog.getOpenFileName(
                self, "Choose sites GeoJSON", self.edit.text(), "GeoJSON (*.geojson *.json)"
            )
        if selected:
            self.edit.setText(selected)

    def path(self) -> Path:
        return Path(self.edit.text()).expanduser()


class ViewshedWindow(QMainWindow):
    """runs the command-line engine and translates events into GUI progress"""

    def __init__(self) -> None:
        super().__init__()
        self.qgis_runtime = qgis_runtime(DEFAULT_QGIS_ROOT)
        self.setWindowTitle("OWDCIC GDAL Camera Viewsheds")
        self.resize(820, 720)
        self.process = QProcess(self)
        self.process.setProcessChannelMode(PROCESS_MERGED_CHANNELS)
        self.process.readyReadStandardOutput.connect(self.read_output)
        self.process.finished.connect(self.run_finished)
        self.output_buffer = ""
        self.started = 0.0

        self.elapsed_timer = QTimer(self)
        self.elapsed_timer.timeout.connect(self.update_elapsed)

        central = QWidget()
        root = QVBoxLayout(central)
        root.addWidget(self.build_inputs())
        root.addWidget(self.build_options())
        root.addWidget(self.build_progress())

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setPlaceholderText("Runner messages appear here")
        root.addWidget(self.log, 1)
        root.addLayout(self.build_buttons())
        self.setCentralWidget(central)
        self.set_idle(True)

    def build_inputs(self) -> QGroupBox:
        group = QGroupBox("Inputs and outputs")
        form = QFormLayout(group)
        self.sites = PathRow(PROJECT_ROOT / "data/sites.geojson", False)
        self.dems = PathRow(PROJECT_ROOT / "data/dems", True)
        self.output = PathRow(PROJECT_ROOT / "outputs/gdal_viewsheds", True)
        form.addRow("Camera sites", self.sites)
        form.addRow("DEM folder", self.dems)
        form.addRow("Output folder", self.output)
        return group

    def build_options(self) -> QGroupBox:
        group = QGroupBox("Run settings")
        form = QFormLayout(group)
        self.mode = QComboBox()
        self.mode.addItem("1 camera (Portland)", "pilot")
        self.mode.addItem("3 cameras", "validation")
        self.mode.addItem("All cameras", "production")

        self.radius = QDoubleSpinBox()
        self.radius.setRange(0.1, 100.0)
        self.radius.setValue(20.0)
        self.radius.setSuffix(" miles")

        self.cell_size = QDoubleSpinBox()
        self.cell_size.setRange(1.0, 1000.0)
        self.cell_size.setValue(10.0)
        self.cell_size.setSuffix(" m")

        self.web_resolution = QDoubleSpinBox()
        self.web_resolution.setRange(10.0, 1000.0)
        self.web_resolution.setValue(50.0)
        self.web_resolution.setSuffix(" m")
        self.web_resolution.setToolTip("coarser web grid smooths pixel-sized boundary detail")

        self.simplify = QDoubleSpinBox()
        self.simplify.setRange(0.0, 1000.0)
        self.simplify.setValue(25.0)
        self.simplify.setSuffix(" m")
        self.simplify.setToolTip("topology-preserving simplification applied only to web polygons")

        self.patch_cells = QSpinBox()
        self.patch_cells.setRange(0, 10000)
        self.patch_cells.setValue(0)
        self.patch_cells.setToolTip("0 preserves all visible patches; higher values remove tiny web islands")

        self.exact = QCheckBox("Create exact 10 m EPSG:5070 polygons")
        self.exact.setChecked(True)
        self.keep_dems = QCheckBox("Keep per-camera working DEMs")
        self.overwrite = QCheckBox("Rebuild completed cameras instead of resuming")

        form.addRow("Camera set", self.mode)
        form.addRow("Maximum distance", self.radius)
        form.addRow("Analysis cell size", self.cell_size)
        form.addRow("Web polygon grid", self.web_resolution)
        form.addRow("Web simplify tolerance", self.simplify)
        form.addRow("Minimum web patch cells", self.patch_cells)
        form.addRow(self.exact)
        form.addRow(self.keep_dems)
        form.addRow(self.overwrite)
        return group

    def build_progress(self) -> QGroupBox:
        group = QGroupBox("Progress")
        layout = QVBoxLayout(group)
        self.status = QLabel("Ready")
        self.status.setWordWrap(True)
        self.overall = QProgressBar()
        self.overall.setRange(0, 1000)
        self.overall.setFormat("Overall: %p%")
        self.current = QProgressBar()
        self.current.setRange(0, 100)
        self.current.setValue(0)
        self.current.setFormat("Current stage")
        self.elapsed = QLabel("Elapsed: 0s")
        layout.addWidget(self.status)
        layout.addWidget(self.overall)
        layout.addWidget(self.current)
        layout.addWidget(self.elapsed)
        return group

    def build_buttons(self) -> QHBoxLayout:
        layout = QHBoxLayout()
        self.start_button = QPushButton("Start run")
        self.start_button.clicked.connect(self.start_run)
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.clicked.connect(self.cancel_run)
        self.open_output_button = QPushButton("Open output folder")
        self.open_output_button.clicked.connect(self.open_output)
        self.open_qgis_button = QPushButton("Open review map in QGIS")
        self.open_qgis_button.clicked.connect(self.open_in_qgis)
        layout.addWidget(self.start_button)
        layout.addWidget(self.cancel_button)
        layout.addStretch(1)
        layout.addWidget(self.open_output_button)
        layout.addWidget(self.open_qgis_button)
        return layout

    def runner_arguments(self) -> list[str]:
        arguments = [
            str(RUNNER),
            "--qgis-app",
            str(self.qgis_runtime.root),
            "--sites",
            str(self.sites.path()),
            "--dem-dir",
            str(self.dems.path()),
            "--output-dir",
            str(self.output.path()),
            "--mode",
            str(self.mode.currentData()),
            "--radius-miles",
            str(self.radius.value()),
            "--cell-size",
            str(self.cell_size.value()),
            "--web-resolution",
            str(self.web_resolution.value()),
            "--simplify-tolerance",
            str(self.simplify.value()),
            "--min-web-patch-cells",
            str(self.patch_cells.value()),
            "--json-progress",
        ]
        if not self.exact.isChecked():
            arguments.append("--skip-exact-polygons")
        if self.keep_dems.isChecked():
            arguments.append("--keep-working-dems")
        if self.overwrite.isChecked():
            arguments.append("--overwrite")
        return arguments

    def validate_paths(self) -> bool:
        problems = []
        if not self.sites.path().is_file():
            problems.append(f"Sites file not found: {self.sites.path()}")
        if not self.dems.path().is_dir():
            problems.append(f"DEM folder not found: {self.dems.path()}")
        if not self.qgis_runtime.root.is_dir():
            problems.append(f"QGIS not found: {self.qgis_runtime.root}")
        else:
            try:
                self.qgis_runtime.validate_tools()
            except RuntimeError as error:
                problems.append(str(error))
        if problems:
            QMessageBox.critical(self, "Cannot start", "\n".join(problems))
            return False
        return True

    def start_run(self) -> None:
        if not self.validate_paths() or self.process.state() != PROCESS_NOT_RUNNING:
            return
        self.log.clear()
        self.output_buffer = ""
        self.started = time.monotonic()
        self.overall.setValue(0)
        self.current.setRange(0, 0)
        self.status.setText("Starting GDAL runner…")
        self.set_idle(False)
        self.elapsed_timer.start(1000)
        self.process.start(sys.executable, self.runner_arguments())
        if not self.process.waitForStarted(5000):
            self.log.appendPlainText(self.process.errorString())
            self.set_idle(True)

    def read_output(self) -> None:
        chunk = bytes(self.process.readAllStandardOutput()).decode("utf-8", errors="replace")
        self.output_buffer += chunk
        lines = self.output_buffer.split("\n")
        self.output_buffer = lines.pop()
        for line in lines:
            self.handle_line(line.rstrip())

    def handle_line(self, line: str) -> None:
        if not line:
            return
        if line.startswith(PROGRESS_PREFIX):
            try:
                payload = json.loads(line[len(PROGRESS_PREFIX) :])
            except json.JSONDecodeError:
                self.log.appendPlainText(line)
                return
            self.overall.setValue(round(float(payload.get("percent", 0)) * 10))
            site = payload.get("site_name")
            prefix = (
                f"Camera {payload.get('site_index')}/{payload.get('site_total')}: {site} — "
                if site
                else ""
            )
            self.status.setText(prefix + str(payload.get("detail", payload.get("stage", ""))))
            return
        self.log.appendPlainText(line)
        scrollbar = self.log.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def run_finished(self, exit_code: int, _status: QProcess.ExitStatus) -> None:
        if self.output_buffer:
            self.handle_line(self.output_buffer)
            self.output_buffer = ""
        self.elapsed_timer.stop()
        self.current.setRange(0, 100)
        self.current.setValue(100 if exit_code == 0 else 0)
        if exit_code == 0:
            self.overall.setValue(1000)
            self.status.setText("Run complete — outputs and manifest are ready")
        elif exit_code == 130:
            self.status.setText("Run cancelled — completed cameras remain resumable")
        else:
            self.status.setText(f"Run stopped with exit code {exit_code}; review the log")
        self.set_idle(True)

    def cancel_run(self) -> None:
        if self.process.state() == PROCESS_NOT_RUNNING:
            return
        self.status.setText("Cancelling the active GDAL command…")
        if sys.platform == "win32":
            # taskkill reaches the active GDAL child process too
            QProcess.startDetached(
                "taskkill.exe",
                ["/PID", str(self.process.processId()), "/T", "/F"],
            )
        else:
            self.process.terminate()
        QTimer.singleShot(5000, self.kill_if_running)

    def kill_if_running(self) -> None:
        if self.process.state() != PROCESS_NOT_RUNNING:
            self.process.kill()

    def update_elapsed(self) -> None:
        seconds = int(time.monotonic() - self.started)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        if hours:
            text = f"{hours}h {minutes}m {seconds}s"
        elif minutes:
            text = f"{minutes}m {seconds}s"
        else:
            text = f"{seconds}s"
        self.elapsed.setText(f"Elapsed: {text}")

    def set_idle(self, idle: bool) -> None:
        self.start_button.setEnabled(idle)
        self.cancel_button.setEnabled(not idle)
        self.open_output_button.setEnabled(idle and self.output.path().exists())
        combined = self.output.path() / "camera_viewsheds_exact_epsg5070.gpkg"
        self.open_qgis_button.setEnabled(idle and combined.exists())

    def open_output(self) -> None:
        self.output.path().mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.output.path())))

    def open_in_qgis(self) -> None:
        combined = self.output.path() / "camera_viewsheds_exact_epsg5070.gpkg"
        review_project = self.output.path() / "camera_viewsheds_review.qgz"
        if not combined.exists():
            QMessageBox.information(self, "No polygons yet", "Run the exact polygon workflow first.")
            return
        builder = QProcess(self)
        builder.setProcessChannelMode(PROCESS_MERGED_CHANNELS)
        builder.start(
            sys.executable,
            [
                str(QGIS_PROJECT_BUILDER),
                "--qgis-app",
                str(self.qgis_runtime.root),
                "--gpkg",
                str(combined),
                "--output",
                str(review_project),
            ],
        )
        if not builder.waitForFinished(15000) or builder.exitCode() != 0:
            message = bytes(builder.readAllStandardOutput()).decode("utf-8", errors="replace")
            QMessageBox.critical(
                self,
                "Could not create QGIS project",
                message or builder.errorString(),
            )
            return
        try:
            program, arguments = self.qgis_runtime.qgis_launch(review_project)
        except RuntimeError as error:
            QMessageBox.critical(self, "Could not open QGIS", str(error))
            return
        QProcess.startDetached(program, arguments)

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.process.state() == PROCESS_NOT_RUNNING:
            event.accept()
            return
        answer = QMessageBox.question(
            self,
            "Cancel active run?",
            "Closing the window will cancel the runner. Completed cameras remain resumable.",
        )
        if answer == MESSAGE_YES:
            self.cancel_run()
            event.accept()
        else:
            event.ignore()


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("OWDCIC GDAL Viewsheds")
    window = ViewshedWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
