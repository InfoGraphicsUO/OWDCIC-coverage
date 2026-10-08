#!/usr/bin/env python3
"""provides a native progress window for the GDAL camera viewshed runner"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time

try:
    from qgis.PyQt.QtCore import QPoint, QProcess, Qt, QTimer, QUrl
    from qgis.PyQt.QtGui import QColor, QDesktopServices, QPalette
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
        QScrollArea,
        QTabWidget,
        QToolTip,
        QVBoxLayout,
        QWidget,
    )
except ImportError:
    from PyQt6.QtCore import QPoint, QProcess, Qt, QTimer, QUrl
    from PyQt6.QtGui import QColor, QDesktopServices, QPalette
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
        QScrollArea,
        QTabWidget,
        QToolTip,
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
DEFAULT_CLIP_BOUNDARY = PROJECT_ROOT / "data/pacific-northwest-land-mask.geojson"
DEFAULT_JOBS = max(1, min(4, (os.cpu_count() or 2) // 2))
PROGRESS_PREFIX = "@@PROGRESS@@"

# keep the native controls, with dark gray surfaces and yellow accents
WINDOW_STYLE = """
QMainWindow, QScrollArea, QWidget#settingsPage { background: #191d21; color: #edf0f2; }
QWidget { font-size: 13px; }
QLabel { color: #edf0f2; }
QLabel#title { font-size: 24px; font-weight: 600; }
QLabel#subtitle, QLabel#elapsed { color: #abb5be; }
QGroupBox { font-weight: 600; border: 1px solid #454e57; border-radius: 5px;
    margin-top: 12px; padding: 16px 12px 12px; background: #242a30; color: #edf0f2; }
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 5px; }
QLineEdit, QComboBox, QAbstractSpinBox, QPlainTextEdit {
    background: #242a30; color: #edf0f2; border: 1px solid #626e79;
    border-radius: 3px; padding: 6px; selection-background-color: #ffe16a;
    selection-color: #191d21; }
QLineEdit:focus, QComboBox:focus, QAbstractSpinBox:focus, QPlainTextEdit:focus {
    border: 1px solid #ffda44; }
QSpinBox::up-button, QDoubleSpinBox::up-button {
    subcontrol-origin: border; subcontrol-position: top right; width: 20px; height: 16px; }
QSpinBox::down-button, QDoubleSpinBox::down-button {
    subcontrol-origin: border; subcontrol-position: bottom right; width: 20px; height: 16px; }
QSpinBox::up-arrow, QDoubleSpinBox::up-arrow,
QSpinBox::down-arrow, QDoubleSpinBox::down-arrow { width: 8px; height: 8px; }
QPushButton { background: #242a30; color: #edf0f2; border: 1px solid #626e79;
    border-radius: 4px; padding: 8px 14px; }
QPushButton:hover { background: #343d45; border-color: #a3aeb8; }
QPushButton:focus { border: 2px solid #ffda44; padding: 7px 13px; }
QPushButton#startButton { background: #ffda44; color: #191d21; border-color: #b79a27; font-weight: 600; }
QPushButton#startButton:hover { background: #ffe576; }
QPushButton:disabled, QPushButton#startButton:disabled { background: #282e34;
    color: #89949e; border-color: #454e57; }
QPushButton#helpButton { padding: 0; border-radius: 10px; color: #b8c1c9; }
QPushButton#helpButton:hover, QPushButton#helpButton:focus {
    padding: 0; color: #ffda44; border: 1px solid #ffda44; }
QToolTip { background: #343d45; color: #edf0f2; border: 1px solid #626e79; padding: 8px; }
QCheckBox { color: #edf0f2; spacing: 8px; padding: 3px 0; }
QTabWidget::pane { border: 1px solid #454e57; }
QTabBar::tab { background: #242a30; color: #b8c1c9; padding: 10px 20px;
    border-bottom: 3px solid transparent; }
QTabBar::tab:selected { background: #242a30; color: #edf0f2; border-bottom-color: #e3b900; }
QTabBar::tab:hover { background: #343d45; }
QProgressBar { background: #343d45; color: #edf0f2; border: none;
    border-radius: 3px; min-height: 20px; text-align: center; }
QProgressBar::chunk { background: #806700; border-radius: 3px; }
QPlainTextEdit { font-family: Consolas, monospace; font-size: 12px; }
"""


def apply_dark_theme(app: QApplication) -> None:
    """covers native controls and popups that are not painted by the window stylesheet"""

    app.setStyle("Fusion")
    palette = QPalette()
    for role, color in {
        "Window": "#191d21", "WindowText": "#edf0f2",
        "Base": "#242a30", "AlternateBase": "#303840",
        "Text": "#edf0f2", "Button": "#242a30", "ButtonText": "#edf0f2",
        "ToolTipBase": "#343d45", "ToolTipText": "#edf0f2",
        "Highlight": "#ffda44", "HighlightedText": "#191d21",
        "Light": "#626e79", "Mid": "#454e57", "Dark": "#14171a",
        "PlaceholderText": "#abb5be",
    }.items():
        palette.setColor(qt_enum(QPalette, "ColorRole", role), QColor(color))
    for role in ("WindowText", "Text", "ButtonText"):
        palette.setColor(
            qt_enum(QPalette, "ColorGroup", "Disabled"),
            qt_enum(QPalette, "ColorRole", role), QColor("#89949e"),
        )
    app.setPalette(palette)


def reset_button(section: str, widgets: list[QWidget]) -> QPushButton:
    """captures the initial values so reset stays in sync with the defaults shown at launch"""

    restore = []
    for widget in widgets:
        if isinstance(widget, QLineEdit):
            restore.append((widget.setText, widget.text()))
        elif isinstance(widget, QComboBox):
            restore.append((widget.setCurrentIndex, widget.currentIndex()))
        elif isinstance(widget, QCheckBox):
            restore.append((widget.setChecked, widget.isChecked()))
        else:
            restore.append((widget.setValue, widget.value()))

    def reset() -> None:
        for setter, value in restore:
            setter(value)

    button = QPushButton("Reset to defaults")
    button.setAccessibleName(f"Reset {section} to defaults")
    button.setToolTip(f"Restore only {section.lower()} to the values used at launch.")
    button.clicked.connect(reset)
    return button



class HelpButton(QPushButton):
    """shows the same short explanation on hover, keyboard focus, or click"""

    def __init__(self, title: str, explanation: str) -> None:
        super().__init__("?")
        self.setObjectName("helpButton")
        self.setFixedSize(20, 20)
        self.setFocusPolicy(qt_enum(Qt, "FocusPolicy", "StrongFocus"))
        self.setAccessibleName(f"Help for {title}")
        self.setAccessibleDescription(explanation)
        self.explanation = f"<qt>{explanation}</qt>"
        self.setToolTip(self.explanation)
        self.clicked.connect(self.show_help)

    def show_help(self) -> None:
        QToolTip.showText(self.mapToGlobal(QPoint(0, self.height() + 4)), self.explanation, self)

    def enterEvent(self, event) -> None:  # noqa: N802
        super().enterEvent(event)
        self.show_help()

    def focusInEvent(self, event) -> None:  # noqa: N802
        super().focusInEvent(event)
        self.show_help()

    def focusOutEvent(self, event) -> None:  # noqa: N802
        super().focusOutEvent(event)
        QToolTip.hideText()


def with_help(label: str | QCheckBox, control: QWidget, explanation: str) -> QWidget:
    """keeps help beside its label without changing the setting or its reset behavior"""

    row = QWidget()
    layout = QHBoxLayout(row)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(6)
    if isinstance(label, str):
        title = label
        widget = QLabel(label)
        widget.setBuddy(control)
    else:
        title = label.text()
        widget = label
    control.setToolTip(explanation)
    control.setAccessibleDescription(explanation)
    layout.addWidget(widget)
    layout.addWidget(HelpButton(title, explanation))
    layout.addStretch(1)
    return row


class PathRow(QWidget):
    """line edit with a file or directory chooser"""

    def __init__(
        self,
        value: Path,
        directory: bool,
        title: str = "Choose sites GeoJSON",
        file_filter: str = "GeoJSON (*.geojson *.json)",
    ) -> None:
        super().__init__()
        self.directory = directory
        self.title = title
        self.file_filter = file_filter
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
                self, self.title, self.edit.text(), self.file_filter
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
        self.resize(920, 880)
        self.setMinimumSize(720, 640)
        self.setStyleSheet(WINDOW_STYLE)
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
        root.setContentsMargins(24, 20, 24, 20)
        root.setSpacing(12)
        title = QLabel("Camera viewsheds")
        title.setObjectName("title")
        root.addWidget(title)
        subtitle = QLabel("Build camera coverage from elevation data with GDAL.")
        subtitle.setObjectName("subtitle")
        root.addWidget(subtitle)

        # scroll only the settings, so progress and the run controls stay within reach
        self.settings = QTabWidget()
        setup = QWidget()
        setup_layout = QVBoxLayout(setup)
        setup_layout.addWidget(self.build_inputs())
        setup_layout.addStretch(1)
        options = QWidget()
        options_layout = QVBoxLayout(options)
        options_layout.addWidget(self.build_options())
        options_layout.addStretch(1)
        for label, page in (
            ("Inputs and outputs", setup),
            ("Run settings", options),
            ("Advanced options", self.advanced),
        ):
            page.setObjectName("settingsPage")
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(qt_enum(QScrollArea, "Shape", "NoFrame"))
            scroll.setWidget(page)
            self.settings.addTab(scroll, label)
        root.addWidget(self.settings, 3)
        root.addWidget(self.build_progress())

        root.addWidget(QLabel("Run log"))
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(90)
        self.log.setPlaceholderText("Start a run to see processing details and any warnings here.")
        root.addWidget(self.log, 1)
        root.addLayout(self.build_buttons())
        self.setCentralWidget(central)
        self.output.edit.textChanged.connect(lambda: self.set_idle(self.process.state() == PROCESS_NOT_RUNNING))
        self.set_idle(True)

    def build_inputs(self) -> QGroupBox:
        group = QGroupBox("Inputs and outputs")
        form = QFormLayout(group)
        form.setSpacing(10)
        form.setFieldGrowthPolicy(qt_enum(QFormLayout, "FieldGrowthPolicy", "AllNonFixedFieldsGrow"))
        self.sites = PathRow(PROJECT_ROOT / "data/alertwest-sites.geojson", False)
        self.dems = PathRow(PROJECT_ROOT / "data/dems", True)
        self.output = PathRow(PROJECT_ROOT / "outputs/gdal_viewsheds_alertwest", True)
        form.addRow(with_help("Camera sites", self.sites,
            "The GeoJSON file containing the camera locations to process."), self.sites)
        form.addRow(with_help("DEM folder", self.dems,
            "The folder containing terrain elevation files. These describe hills and valleys used to calculate visibility."), self.dems)
        form.addRow("Output folder", self.output)
        form.addRow(reset_button("Inputs and outputs", [self.sites.edit, self.dems.edit, self.output.edit]))
        return group

    def build_options(self) -> QGroupBox:
        group = QGroupBox("Run settings")
        form = QFormLayout(group)
        form.setSpacing(10)
        form.setFieldGrowthPolicy(qt_enum(QFormLayout, "FieldGrowthPolicy", "AllNonFixedFieldsGrow"))
        self.mode = QComboBox()
        self.mode.addItem("1 camera (Portland)", "pilot")
        self.mode.addItem("3 cameras", "validation")
        self.mode.addItem("All cameras", "production")

        self.products = QComboBox()
        self.products.addItem("Full run (polygons, Mapbox products, manifest)", None)
        self.products.addItem("Shapefiles only: exact 10 m polygons", "exact")
        self.products.addItem("Shapefiles only: smoothed web polygons", "web")
        self.products.setToolTip(
            "shapefiles-only runs write one EPSG:5070 shapefile per camera for ArcGIS "
            "and skip the combined GeoPackage, Mapbox products, and manifest"
        )

        self.combined = QCheckBox("Also rebuild the combined coverage tileset")
        # shapefiles-only runs make no coverage to combine
        self.products.currentIndexChanged.connect(
            lambda: self.combined.setEnabled(self.products.currentData() is None)
        )

        self.radius = QDoubleSpinBox()
        self.radius.setRange(0.1, 100.0)
        self.radius.setValue(12.0)
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

        self.smooth_iterations = QSpinBox()
        self.smooth_iterations.setRange(0, 3)
        self.smooth_iterations.setValue(3)
        self.smooth_iterations.setToolTip(
            "corner-cutting passes applied only to web polygons; 0 disables smoothing"
        )

        self.web_majority = QCheckBox("Smooth web mask with a 3×3 majority filter")
        self.web_majority.setChecked(True)
        self.web_majority.setToolTip(
            "a web cell is visible when at least 5 cells in its 3×3 neighborhood are visible"
        )

        self.web_clip = QCheckBox("Clip web polygons at Pacific Northwest coastlines")
        self.web_clip.setChecked(True)
        self.web_clip.setToolTip(f"uses {DEFAULT_CLIP_BOUNDARY}")

        self.patch_cells = QSpinBox()
        self.patch_cells.setRange(0, 10000)
        self.patch_cells.setValue(0)
        self.patch_cells.setToolTip("0 preserves all visible patches; higher values remove tiny web islands")

        self.jobs = QSpinBox()
        self.jobs.setRange(1, max(1, os.cpu_count() or 1))
        self.jobs.setValue(DEFAULT_JOBS)
        self.jobs.setToolTip("cameras processed at the same time; each needs roughly 1 GB of memory")

        self.exact = QCheckBox("Create exact 10 m EPSG:5070 polygons")
        self.exact.setChecked(True)
        self.keep_dems = QCheckBox("Keep per-camera working DEMs")
        self.overwrite = QCheckBox("Rebuild completed cameras instead of resuming")

        form.addRow(with_help("Camera set", self.mode,
            "Choose a small test run or process every camera in the selected sites file."), self.mode)
        form.addRow(with_help("Outputs", self.products,
            "Full run creates combined coverage files and web map files. Shapefiles only creates a separate file for each camera; choose exact edges or smoother web edges."), self.products)
        form.addRow(with_help(self.combined, self.combined,
            "When the run finishes, also dissolves this provider's new coverage with the other providers' saved coverage into the combined tileset. Adds a few minutes. Full runs only."))
        form.addRow(with_help("Maximum distance", self.radius,
            "How far from each camera to check visibility. Larger distances cover more ground and take more time and memory."), self.radius)
        form.addRow(with_help("Analysis cell size", self.cell_size,
            "The size of each terrain square used in the calculation. Smaller squares keep more detail but use more time and memory; they cannot add detail missing from the elevation data."), self.cell_size)
        form.addRow(with_help("Parallel cameras", self.jobs,
            "How many cameras to process at once. More can finish sooner, but each needs roughly 1 GB of memory."), self.jobs)

        form.addRow(reset_button("Run settings", [
            self.mode, self.products, self.combined, self.radius, self.cell_size, self.jobs,
        ]))

        # these are still the runner's defaults; the advanced tab just keeps setup compact
        self.advanced = QWidget()
        advanced_layout = QVBoxLayout(self.advanced)
        web_group = QGroupBox("Web polygon detail")
        web_form = QFormLayout(web_group)
        web_form.setSpacing(10)
        web_form.addRow(with_help("Grid resolution", self.web_resolution,
            "The size of each square used for web coverage shapes. Larger values make simpler shapes but lose small details. Exact shapes are unchanged."), self.web_resolution)
        web_form.addRow(with_help("Simplify tolerance", self.simplify,
            "How much small edge detail to remove from web shapes, in meters. Higher values make simpler outlines; 0 skips this step."), self.simplify)
        web_form.addRow(with_help("Smoothing passes", self.smooth_iterations,
            "How many times to round off corners in web shapes. More passes make softer edges; 0 leaves the corners unchanged."), self.smooth_iterations)
        web_form.addRow(with_help("Minimum patch cells", self.patch_cells,
            "Removes small groups of grid squares from the web mask, including small gaps. Higher values remove larger patches; 0 keeps them all."), self.patch_cells)
        web_form.addRow(with_help(self.web_majority, self.web_majority,
            "Reduces isolated specks and tiny holes in web coverage. A square is visible when at least 5 of its 9 neighboring squares, including itself, are visible."))
        web_form.addRow(with_help(self.web_clip, self.web_clip,
            "Trims web coverage to the Pacific Northwest land boundary, removing coverage over the ocean. Exact shapes are unchanged."))
        web_form.addRow(reset_button("Web polygon detail", [
            self.web_resolution, self.simplify, self.smooth_iterations,
            self.patch_cells, self.web_majority, self.web_clip,
        ]))
        advanced_layout.addWidget(web_group)
        files_group = QGroupBox("Files and repeat runs")
        files_layout = QVBoxLayout(files_group)
        files_layout.addWidget(with_help(self.exact, self.exact,
            "Also saves shapes that follow the analysis grid without web smoothing. Uncheck to skip these files in a full run. Exact shapefile runs always create them."))
        files_layout.addWidget(with_help(self.keep_dems, self.keep_dems,
            "Keeps the temporary terrain files made for each camera so you can inspect them later. This uses extra disk space."))
        files_layout.addWidget(with_help(self.overwrite, self.overwrite,
            "Recalculates cameras that already have completed results. Leave unchecked to reuse completed work and resume an interrupted run."))
        files_layout.addWidget(reset_button("Files and repeat runs", [
            self.exact, self.keep_dems, self.overwrite,
        ]))
        advanced_layout.addWidget(files_group)
        advanced_layout.addStretch(1)
        return group

    def build_progress(self) -> QGroupBox:
        group = QGroupBox("Progress")
        layout = QVBoxLayout(group)
        self.status = QLabel("Ready to start; choose inputs & check settings before starting a run!")
        self.status.setWordWrap(True)
        self.overall = QProgressBar()
        self.overall.setRange(0, 1000)
        self.overall.setValue(0)
        self.overall.setFormat("Overall: %p%")
        self.current = QProgressBar()
        self.current.setRange(0, 100)
        self.current.setValue(0)
        self.current.setFormat("Current stage")
        self.elapsed = QLabel("Elapsed: 0s")
        self.elapsed.setObjectName("elapsed")
        layout.addWidget(self.status)
        layout.addWidget(self.overall)
        layout.addWidget(self.current)
        layout.addWidget(self.elapsed)
        return group

    def build_buttons(self) -> QHBoxLayout:
        layout = QHBoxLayout()
        self.start_button = QPushButton("Start run")
        self.start_button.setObjectName("startButton")
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
            "--smooth-iterations",
            str(self.smooth_iterations.value()),
            "--min-web-patch-cells",
            str(self.patch_cells.value()),
            "--jobs",
            str(self.jobs.value()),
            "--json-progress",
        ]
        arguments.append(
            "--web-majority-filter" if self.web_majority.isChecked() else "--no-web-majority-filter"
        )
        arguments.append("--web-clip" if self.web_clip.isChecked() else "--no-web-clip")
        shapefiles = self.products.currentData()
        if shapefiles:
            arguments += ["--shapefiles-only", shapefiles]
        # exact shapefiles are built from the exact polygons, so the checkbox cannot skip them
        if not self.exact.isChecked() and shapefiles != "exact":
            arguments.append("--skip-exact-polygons")
        if self.combined.isChecked() and not shapefiles:
            arguments.append("--combined-coverage")
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
        clip_needed = self.web_clip.isChecked() and self.products.currentData() != "exact"
        if clip_needed and not DEFAULT_CLIP_BOUNDARY.is_file():
            problems.append(f"Web clip boundary not found: {DEFAULT_CLIP_BOUNDARY}")
        if not self.qgis_runtime.root.is_dir():
            problems.append(f"QGIS not found: {self.qgis_runtime.root}")
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
            self.elapsed_timer.stop()
            self.current.setRange(0, 100)
            self.current.setValue(0)
            self.status.setText("Could not start the runner — review the log.")
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
            if self.products.currentData():
                self.status.setText("Run complete — shapefiles are in the output folder")
            else:
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
        self.settings.setEnabled(idle)
        self.start_button.setEnabled(idle)
        self.cancel_button.setEnabled(not idle)
        self.open_output_button.setEnabled(idle and self.output.path().exists())
        exact = self.output.path() / "camera_viewsheds_exact_epsg5070.gpkg"
        web = self.output.path() / "mapbox/camera_viewsheds_web_epsg5070.gpkg"
        self.open_qgis_button.setEnabled(idle and (exact.exists() or web.exists()))

    def open_output(self) -> None:
        self.output.path().mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.output.path())))

    def open_in_qgis(self) -> None:
        combined = self.output.path() / "camera_viewsheds_exact_epsg5070.gpkg"
        web = self.output.path() / "mapbox/camera_viewsheds_web_epsg5070.gpkg"
        review_project = self.output.path() / "camera_viewsheds_review.qgz"
        if not combined.exists() and not web.exists():
            QMessageBox.information(self, "No polygons yet", "Run the viewshed workflow first.")
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
                "--web-gpkg",
                str(web),
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
    apply_dark_theme(app)
    app.setApplicationName("OWDCIC GDAL Viewsheds")
    window = ViewshedWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
