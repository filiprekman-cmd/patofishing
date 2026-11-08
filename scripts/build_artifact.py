"""Build the claude.ai Artifact version of the site into ./artifact-build.

The Artifact host wraps the main page in its own <html>/<head>/<body>, so the page is written
without them. Every other file is copied unchanged.
"""

import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = ROOT / "artifact-build"


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE, OUT, ignore=shutil.ignore_patterns("*.tmp", "CNAME"))
    page = (SITE / "index.html").read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", page, flags=re.DOTALL).group(1)
    body = re.search(r"<body>(.*?)</body>", page, flags=re.DOTALL).group(1)
    head = "\n".join(line for line in head.strip().splitlines()
                     if not re.match(r"\s*<meta (charset|name=\"viewport\")", line))
    (OUT / "index.html").write_text(head + "\n" + body.strip() + "\n", encoding="utf-8")
    scripts = OUT / "scripts"
    scripts.mkdir()
    for source in (ROOT / "scripts").glob("*.py"):
        if source.name != "build_artifact.py":
            shutil.copy(source, scripts / source.name)
    print(f"Zbudowano {OUT}")


if __name__ == "__main__":
    main()
