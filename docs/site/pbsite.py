# The Sphinx settings every Paperboat docs site shares: the engine's (docs/api), each toolkit's
# (<toolkit>/docs) and each program's (<repo>/docs). build.py passes the site's own values in the
# environment. A docs folder with no conf.py is built with docs/site/conf.py (just this); one that
# needs more (the engine's top-bar menus) keeps a conf.py that imports this and adds them.
#
#   python3 docs/site/build.py <docs dir> <out dir> --name control --title "control toolkit"

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SITE = os.environ.get("PB_SITE", "paperboat")
ORG = os.environ.get("PB_ORG_URL", "https://paperboatlab.github.io/")

project = os.environ.get("PB_TITLE", SITE)
author = "Paperboat"
release = os.environ.get("PB_VERSION", "")
version = release

extensions = ["helpjson"]  # help.json, the apps' Help bundle
pb_site = SITE
exclude_patterns = ["_build"]

html_theme = "shibuya"
html_static_path = [str(HERE.parent / "_static")]
html_css_files = ["fonts.css", "blocks.css"]
html_title = project
html_baseurl = os.environ.get("PB_SITE_URL", ORG + SITE + "/")
html_favicon = str(HERE.parent / "_static/favicon.svg")
html_show_sphinx = False
highlight_language = "none"
primary_domain = None

html_theme_options = {
    "accent_color": "orange",
    "color_mode": "auto",
    "light_logo": "_static/logo-light.svg",
    "dark_logo": "_static/logo-dark.svg",
    "github_url": os.environ.get("PB_REPO_URL", "https://github.com/paperboatlab"),
    # Every site's top bar leads back to the hub, so the org reads as one site.
    "nav_links": [{"title": "All docs", "url": ORG}],
}

_versions_raw = os.environ.get("PB_VERSIONS_JSON", "").strip()
if _versions_raw:
    _parsed = json.loads(_versions_raw)
    _choices = [(v["version"], v["url"]) if isinstance(v, dict) else (v[0], v[1]) for v in _parsed]
    html_context = {
        "versions": _choices,
        "current_version": release or (_choices[0][0] if _choices else ""),
    }
