#!/usr/bin/env python3
"""Write explicit blocked-source collections for datasets not locally available.

This prevents fabricated boundaries from silently entering the UI.  Re-run the
main division builder after supplying the official utility/PAD-US endpoints.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "divisions"
BLOCKED = {
    "utility": "Official Oregon/Washington utility service-area layers were not accessible from the documented state endpoints during this build.",
    "federal-land": "PAD-US fee-land download was not accessible during this build; no federal-land geometry is fabricated.",
}
for kind, reason in BLOCKED.items():
    payload = {"type":"FeatureCollection","features":[],"metadata":{
        "schemaVersion":1,"divisionType":kind,"source":"official source access blocked",
        "sourceStatus":"blocked","buildStatus":"incomplete","reason":reason,
        "areaCrs":"EPSG:5070","metricsStatus":"unavailable"
    }}
    (OUT / f"{kind}.geojson").write_text(json.dumps(payload, separators=(",",":"))+"\n", encoding="utf-8")
    print(f"wrote blocked {kind} collection")
