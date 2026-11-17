# The engine's docs site: the shared settings (docs/site/pbsite.py) plus its top-bar menus.
# Build: npm run docs   (or python3 docs/site/build.py docs/api <out>)

import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ.get("PB_SITE_DIR") or str(Path(__file__).resolve().parents[1] / "site"))
from pbsite import *  # noqa: E402,F401,F403
from pbsite import ORG, html_theme_options  # noqa: E402

project = html_title = "Paperboat"
if not os.environ.get("PB_VERSION"):
    version = "0 (protocol paperboat/0)"
cpp_index_common_prefix = ["paperboat::"]

html_theme_options["github_url"] = "https://github.com/paperboatlab/paperboat"
html_theme_options["nav_links"] = [
    {
        "title": "Manuals",
        "children": [
            {"title": "Installation", "url": "installation"},
            {"title": "Launcher", "url": "launcher"},
            {"title": "User Manual", "url": "user_manual"},
            {"title": "Technical Manual", "url": "technical_manual"},
            {"title": "Tutorials", "url": "tutorials"},
            {"title": "Quickstart", "url": "quickstart"},
        ],
    },
    {
        "title": "API Reference",
        "children": [
            {"title": "C++ SDK", "url": "cpp"},
            {"title": "Python SDK", "url": "python"},
            {"title": "Writing a toolkit", "url": "toolkit"},
            {"title": "Protocol", "url": "protocol"},
            {"title": "Descriptors", "url": "descriptor"},
        ],
    },
    {"title": "All docs", "url": ORG},
]
