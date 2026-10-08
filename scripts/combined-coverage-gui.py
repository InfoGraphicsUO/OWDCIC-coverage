#!/usr/bin/env python3
"""provides a native window for the combined viewshed coverage builder"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import time

SCRIPTS = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS.parent
RUNNER = SCRIPTS / "build-combined-viewshed-coverage.py"
PRODUCT_NAME = "combined-camera-viewshed-coverage"  # matches the runner
PACKAGE_FILTER = "GeoPackage (*.gpkg)"

# share the viewshed window's widgets, theme, and Qt 5/6 handling
sys.path.insert(0, str(SCRIPTS))
_spec = importlib.util.spec_from_file_location("gdal_viewshed_gui", SCRIPTS / "gdal-viewshed-gui.py")
gui = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = gui
_spec.loader.exec_module(gui)


class CombinedCoverageWindow(gui.QMainWindow):
    """runs the combined coverage script and shows its log"""

    def __init__(self) -> None:
        super().__init__()
        self.qgis_runtime = gui.qgis_runtime(gui.DEFAULT_QGIS_ROOT)
        self.setWindowTitle("OWDCIC Combined Viewshed Coverage")
        self.resize(820, 620)
        self.setMinimumSize(640, 520)
        self.setStyleSheet(gui.WINDOW_STYLE)
        self.process = gui.QProcess(self)
        self.process.setProcessChannelMode(gui.PROCESS_MERGED_CHANNELS)
        self.process.readyReadStandardOutput.connect(self.read_output)
        self.process.finished.connect(self.run_finished)
        self.output_buffer = ""
        self.started = 0.0
        self.cancelled = False

        self.elapsed_timer = gui.QTimer(self)
        self.elapsed_timer.timeout.connect(self.update_elapsed)

        central = gui.QWidget()
        root = gui.QVBoxLayout(central)
        root.setContentsMargins(24, 20, 24, 20)
        root.setSpacing(12)
        title = gui.QLabel("Combined viewshed coverage")
        title.setObjectName("title")
        root.addWidget(title)
        subtitle = gui.QLabel(
            "Dissolve every provider's coverage into one Mapbox tileset. "
            "Run this after any provider's viewsheds change."
        )
        subtitle.setObjectName("subtitle")
        subtitle.setWordWrap(True)
        root.addWidget(subtitle)

        self.inputs = self.build_inputs()
        root.addWidget(self.inputs)
        root.addWidget(self.build_progress())
        root.addWidget(gui.QLabel("Run log"))
        self.log = gui.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(90)
        self.log.setPlaceholderText("Start a run to see processing details and any warnings here.")
        root.addWidget(self.log, 1)
        root.addLayout(self.build_buttons())
        self.setCentralWidget(central)
        self.output.edit.textChanged.connect(lambda: self.set_idle(self.process.state() == gui.PROCESS_NOT_RUNNING))
        self.set_idle(True)

    def build_inputs(self) -> gui.QGroupBox:
        group = gui.QGroupBox("Inputs and outputs")
        form = gui.QFormLayout(group)
        form.setSpacing(10)
        form.setFieldGrowthPolicy(gui.qt_enum(gui.QFormLayout, "FieldGrowthPolicy", "AllNonFixedFieldsGrow"))
        explanation = (
            "The web GeoPackage written by a full viewshed run for this provider, found in "
            "the mapbox folder of its output folder."
        )
        self.providers = []
        for label, folder in (("ALERTWest coverage", "gdal_viewsheds_alertwest"), ("Pano coverage", "gdal_viewsheds_pano")):
            row = gui.PathRow(
                PROJECT_ROOT / "outputs" / folder / "mapbox/camera_viewsheds_web_epsg5070.gpkg",
                False,
                "Choose provider web GeoPackage",
                PACKAGE_FILTER,
            )
            self.providers.append((label, row))
            form.addRow(gui.with_help(label, row, explanation), row)
        self.output = gui.PathRow(PROJECT_ROOT / "outputs/gdal_viewsheds_combined/mapbox", True)
        form.addRow("Output folder", self.output)
        form.addRow(gui.reset_button(
            "Inputs and outputs", [row.edit for _, row in self.providers] + [self.output.edit]
        ))
        return group

    def build_progress(self) -> gui.QGroupBox:
        group = gui.QGroupBox("Progress")
        layout = gui.QVBoxLayout(group)
        self.status = gui.QLabel("Ready to start; this usually takes a few minutes.")
        self.status.setWordWrap(True)
        self.progress = gui.QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        self.elapsed = gui.QLabel("Elapsed: 0s")
        self.elapsed.setObjectName("elapsed")
        layout.addWidget(self.status)
        layout.addWidget(self.progress)
        layout.addWidget(self.elapsed)
        return group

    def build_buttons(self) -> gui.QHBoxLayout:
        layout = gui.QHBoxLayout()
        self.start_button = gui.QPushButton("Start run")
        self.start_button.setObjectName("startButton")
        self.start_button.clicked.connect(self.start_run)
        self.cancel_button = gui.QPushButton("Cancel")
        self.cancel_button.clicked.connect(self.cancel_run)
        self.open_output_button = gui.QPushButton("Open output folder")
        self.open_output_button.clicked.connect(self.open_output)
        layout.addWidget(self.start_button)
        layout.addWidget(self.cancel_button)
        layout.addStretch(1)
        layout.addWidget(self.open_output_button)
        return layout

    def runner_arguments(self) -> list[str]:
        return [
            str(RUNNER),
            "--qgis-app",
            str(self.qgis_runtime.root),
            "--providers",
            *(str(row.path()) for _, row in self.providers),
            "--output-dir",
            str(self.output.path()),
        ]

    def validate_paths(self) -> bool:
        problems = [
            f"{label} not found: {row.path()}"
            for label, row in self.providers
            if not row.path().is_file()
        ]
        if not self.qgis_runtime.root.is_dir():
            problems.append(f"QGIS not found: {self.qgis_runtime.root}")
        if problems:
            gui.QMessageBox.critical(self, "Cannot start", "\n".join(problems))
            return False
        return True

    def start_run(self) -> None:
        if not self.validate_paths() or self.process.state() != gui.PROCESS_NOT_RUNNING:
            return
        self.log.clear()
        self.output_buffer = ""
        self.started = time.monotonic()
        # the dissolve reports no progress, so the bar only shows activity
        self.progress.setRange(0, 0)
        self.status.setText("Starting…")
        self.set_idle(False)
        self.elapsed_timer.start(1000)
        self.process.start(sys.executable, self.runner_arguments())
        if not self.process.waitForStarted(5000):
            self.log.appendPlainText(self.process.errorString())
            self.elapsed_timer.stop()
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
            self.status.setText("Could not start the script — review the log.")
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
        self.log.appendPlainText(line)
        if not line.startswith(("Traceback", " ", "\t")):
            self.status.setText(line[0].upper() + line[1:] + "…")
        scrollbar = self.log.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def run_finished(self, exit_code: int, _status) -> None:
        if self.output_buffer:
            self.handle_line(self.output_buffer)
            self.output_buffer = ""
        self.elapsed_timer.stop()
        self.progress.setRange(0, 100)
        self.progress.setValue(100 if exit_code == 0 else 0)
        if exit_code == 0:
            self.status.setText(f"Run complete — upload {PRODUCT_NAME}-z5.mbtiles from the output folder")
        elif self.cancelled:
            self.status.setText("Run cancelled — the previous tileset may have been removed")
        else:
            self.status.setText(f"Run stopped with exit code {exit_code}; review the log")
        self.set_idle(True)

    def cancel_run(self) -> None:
        if self.process.state() == gui.PROCESS_NOT_RUNNING:
            return
        self.cancelled = True
        self.status.setText("Cancelling…")
        if sys.platform == "win32":
            # taskkill reaches the tippecanoe child process too
            gui.QProcess.startDetached(
                "taskkill.exe",
                ["/PID", str(self.process.processId()), "/T", "/F"],
            )
        else:
            self.process.terminate()
        gui.QTimer.singleShot(5000, self.kill_if_running)

    def kill_if_running(self) -> None:
        if self.process.state() != gui.PROCESS_NOT_RUNNING:
            self.process.kill()

    def update_elapsed(self) -> None:
        minutes, seconds = divmod(int(time.monotonic() - self.started), 60)
        self.elapsed.setText(f"Elapsed: {minutes}m {seconds}s" if minutes else f"Elapsed: {seconds}s")

    def set_idle(self, idle: bool) -> None:
        if not idle:
            self.cancelled = False
        self.inputs.setEnabled(idle)
        self.start_button.setEnabled(idle)
        self.cancel_button.setEnabled(not idle)
        self.open_output_button.setEnabled(idle and self.output.path().exists())

    def open_output(self) -> None:
        self.output.path().mkdir(parents=True, exist_ok=True)
        gui.QDesktopServices.openUrl(gui.QUrl.fromLocalFile(str(self.output.path())))

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.process.state() == gui.PROCESS_NOT_RUNNING:
            event.accept()
            return
        answer = gui.QMessageBox.question(
            self,
            "Cancel active run?",
            "Closing the window will cancel the run.",
        )
        if answer == gui.MESSAGE_YES:
            self.cancel_run()
            event.accept()
        else:
            event.ignore()


def main() -> int:
    app = gui.QApplication(sys.argv)
    gui.apply_dark_theme(app)
    app.setApplicationName("OWDCIC Combined Viewshed Coverage")
    window = CombinedCoverageWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
