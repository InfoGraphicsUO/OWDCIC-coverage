"""checks the plain explanations the GUI shows for failed runs"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from run_errors import explain  # noqa: E402


class ExplainTests(unittest.TestCase):
    def test_unknown_errors_have_no_explanation(self):
        self.assertIsNone(explain('ERROR: something unexpected'))

    def test_counts_from_the_error_reach_the_explanation(self):
        log = ('[1m 2s] publishing failed: outputs/gdal_viewsheds_alertwest_test lacks 12 published '
               'viewsheds (a, b); published data left unchanged')
        self.assertIn('missing 12 viewsheds', explain(log))

    def test_a_root_cause_wins_over_the_failures_it_causes(self):
        log = ('[5m] FAILED Mount Hood: [Errno 28] No space left on device\n'
               '[6m] publishing skipped: the run must finish with web coverage, MBTiles, and no failures')
        self.assertIn('disk is full', explain(log))

    def test_signed_out_release_upload(self):
        self.assertIn('gh auth login', explain('GitHub CLI is not signed in; run gh auth login in a terminal'))

    def test_dem_download_network_error(self):
        log = 'ERROR: USGS_13_n46w123.tif failed: <urlopen error [Errno 8] nodename nor servname provided>'
        self.assertIn('internet connection', explain(log))


if __name__ == '__main__':
    unittest.main()
