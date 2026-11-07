#!/usr/bin/env python3
"""Keep the preloaded Quick Switcher presentation equal to its CSS sources."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
styles = {"theme": (root / "theme-vars.css").read_text(),
          "component": (root / "quick-switcher.css").read_text()}
(root / "quick-switcher-styles.js").write_text(
    "// Package-local presentation preloaded before the search client.\n"
    "// Keep the strings equal to theme-vars.css and quick-switcher.css.\n"
    "globalThis.LaterOnQuickSwitcherStyles = " + json.dumps(styles, ensure_ascii=False) + ";\n"
)
