"""Dashboard contract checks — no services, no browser, one command.

Verifies the invariant the live U8 validation established by hand: every
element id the JS reaches for exists in index.html (a typo'd id is a
silent runtime null, and the dashboard's first paint looks fine without it).

    uv run python scripts/check_dashboard.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"

html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
js = (DASHBOARD / "app.js").read_text(encoding="utf-8")

html_ids = set(re.findall(r'id="([^"]+)"', html))
js_ids = set(re.findall(r'\$\("([^"]+)"\)', js))
js_ids |= set(re.findall(r'getElementById\("([^"]+)"\)', js))

missing = sorted(js_ids - html_ids)
if missing:
    print(f"FAIL: ids referenced in app.js but absent from index.html: {missing}")
    sys.exit(1)
print(f"ok: {len(js_ids)} referenced ids all present in index.html "
      f"({len(html_ids)} ids defined)")
