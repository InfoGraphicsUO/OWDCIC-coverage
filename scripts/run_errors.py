"""turns the errors a failed run leaves in its log into a plain explanation and fix"""
from __future__ import annotations

import re

# checked in order, so a root cause such as a full disk wins over the failures it causes
RUN_ERRORS = (
    (r'No space left on device|ENOSPC|Errno 28',
     'The disk is full. Free up at least 10 GB, then start again; finished work is kept.'),
    (r'no GeoTIFF DEMs found in',
     'The DEM folder has no terrain files. Use Download missing DEMs in the Setup tab, or choose the '
     'folder that holds them in Inputs and outputs.'),
    (r'viewshed has no visible cells',
     'A camera had no terrain around it, which usually means a DEM tile is missing. Check the Setup tab '
     'and download the missing DEMs.'),
    (r"already holds another provider's viewsheds",
     "The output folder holds another provider's viewsheds. Choose this provider's own output folder "
     'in Inputs and outputs.'),
    (r'tippecanoe is required',
     'tippecanoe, which builds the map tiles, is not installed. Install it with brew install tippecanoe, '
     'or turn off publishing and the combined coverage.'),
    (r'lacks (\d+) published viewsheds',
     'Nothing was published: the output folder is missing {0} viewsheds the map already shows. Run in '
     "the provider's main output folder rather than a test folder, or copy it from the previous maintainer."),
    (r'no published coverage to measure',
     "Some providers have no saved viewsheds, so the metrics cannot be measured. Copy the "
     'outputs/gdal_viewsheds_* folders from the previous maintainer.'),
    (r'GitHub CLI is not signed in|GitHub CLI \(gh\) not found',
     'The GitHub CLI is not signed in, so the release was not uploaded. Run gh auth login in a terminal, '
     'then build the release again.'),
    (r'urlopen error|timed out|Connection (reset|refused)|nodename nor servname|Name or service not known'
     r'|Network is unreachable|Temporary failure in name resolution',
     'A download lost its connection. Check the internet connection and start again; finished work is kept.'),
    (r'publishing skipped: the run must finish',
     'Nothing was published because some cameras failed or the map tiles were not built. Look for FAILED '
     'lines in the log, fix them, and start again; finished cameras are kept.'),
)


def explain(log: str) -> str | None:
    """the explanation for the first known error in the log, or None when none is recognised"""
    for pattern, explanation in RUN_ERRORS:
        match = re.search(pattern, log)

        if match:
            return explanation.format(*match.groups())

    return None
