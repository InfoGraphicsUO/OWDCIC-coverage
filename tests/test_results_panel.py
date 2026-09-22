"""Source checks for the results panel contract (donuts, copy, export)."""
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / 'js/results-panel.js').read_text()
CSS = (ROOT / 'css/results-panel.css').read_text()


def donut_types():
    match = re.search(r'const POLYGON_DONUT_TYPES = new Set\(\[([^\]]+)\]\)', JS)
    if not match:
        raise AssertionError('POLYGON_DONUT_TYPES is missing')
    return {
        token.strip().strip('\'"')
        for token in match.group(1).split(',')
        if token.strip()
    }


class ResultsPanelContractTests(unittest.TestCase):
    def test_donuts_are_limited_to_districts_and_utility(self):
        types = donut_types()
        self.assertEqual(types, {'house', 'us-house', 'senate', 'utility'})
        for excluded in ('state', 'county', 'national-forest', 'national-park',
                         'federal-land', 'tribal-land'):
            self.assertNotIn(excluded, types)

    def test_camera_unavailable_copy_never_uses_zero_percent_fallback(self):
        self.assertIn("'Coverage unavailable'", JS)
        self.assertIn('cameraCoverageAvailable', JS)
        self.assertIn('% covered by fire-spotting cameras', JS)
        self.assertNotRegex(
            JS,
            r"Viewshed coverage['\"],\s*['\"]0",
        )

    def test_export_modal_and_self_explanatory_copy(self):
        self.assertIn('Export as…', JS)
        self.assertIn('createExportModal', JS)
        self.assertIn("setAttribute('role', 'dialog')", JS)
        self.assertIn("setAttribute('aria-modal', 'true')", JS)
        self.assertIn('results-export-modal', CSS)
        self.assertIn('backdrop-filter: blur', CSS)
        self.assertIn('prefers-reduced-motion', CSS)
        self.assertIn('results-panel__footer', CSS)
        self.assertIn('LAND_MIX_COLORS', JS)
        self.assertIn('#2f2e2e', CSS)
        self.assertIn('color: #fff', CSS)

    def test_utility_qualifier_is_exact_product_copy(self):
        self.assertIn("Approximate service area boundary", JS)

    def test_png_export_covers_required_pieces_and_skips_pdf(self):
        self.assertIn('composeExport', JS)
        self.assertIn('drawLegendOverlay', JS)
        self.assertIn('drawExportLegendSwatch', JS)
        self.assertIn('EXPORT_LEGEND_VISUALS', JS)
        self.assertIn('resolveLegendRowsForExport', JS)
        self.assertIn('drawStatsOverlay', JS)
        self.assertIn("ctx.fillText('Legend'", JS)
        self.assertIn("'Camera viewsheds': { type: 'swatch', style: 'fill', color: '#F28D05' }", JS)
        self.assertIn('MAP_ATTRIBUTION', JS)
        self.assertIn('exportLandMixRows', JS)
        self.assertIn('Plotly?.toImage', JS)
        self.assertNotIn('mapHeight + bottomHeight', JS)
        self.assertNotRegex(JS.lower(), r'\bpdf\b')
        self.assertNotRegex(CSS.lower(), r'\bpdf\b')

    def test_results_panel_floats_with_content_height(self):
        self.assertIn('--results-float-gap', CSS)
        self.assertIn('--results-bottom-clearance', CSS)
        self.assertIn('bottom: auto', CSS)
        self.assertIn('max-height: calc(100% - (var(--results-float-gap) * 2) - var(--results-bottom-clearance))', CSS)
        self.assertIn('flex: 0 1 auto', CSS)
        self.assertNotRegex(
            CSS,
            r'#results-panel,\s*\n\.results-panel\s*\{[^}]*\bbottom:\s*0\b',
        )

    def test_plotly_is_optional(self):
        self.assertIn('Plotly?.newPlot', JS)
        self.assertIn('Chart unavailable. Land shares are listed below.', JS)

    def test_narrow_sheet_and_focus_states(self):
        self.assertIn('@media (max-width: 900px)', CSS)
        self.assertIn('results-panel__handle', CSS)
        self.assertIn(':focus-visible', CSS)
        self.assertIn('prefers-reduced-motion', CSS)

    def test_dom_contract_for_donuts_unavailable_copy_and_png(self):
        result = subprocess.run(
            ['node', str(ROOT / 'tests' / 'results_panel_dom_test.mjs')],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == '__main__':
    unittest.main()
