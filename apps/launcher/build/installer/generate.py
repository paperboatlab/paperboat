#!/usr/bin/env python3
"""Generate macOS DMG and Windows MSI installer assets from editable SVG sources and LICENSE."""

from pathlib import Path
import shutil
import struct
import subprocess
from PIL import Image

HERE = Path(__file__).resolve().parent
BUILD = HERE.parent
REPO = BUILD.parent.parent.parent


def svg_to_png(svg: Path, png: Path, width: int, height: int) -> None:
    subprocess.run(
        ["rsvg-convert", "-w", str(width), "-h", str(height), str(svg), "-o", str(png)],
        check=True,
    )


def write_icns(icon_svg: Path, out_icns: Path) -> None:
    chunks = []
    for chunk_type, size in [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)]:
        tmp = HERE / f".tmp-icns-{size}.png"
        svg_to_png(icon_svg, tmp, size, size)
        data = tmp.read_bytes()
        tmp.unlink()
        chunks.append(struct.pack(">4sI", chunk_type, 8 + len(data)) + data)
    body = b"".join(chunks)
    out_icns.write_bytes(struct.pack(">4sI", b"icns", 8 + len(body)) + body)


def write_ico(icon_png_512: Path, out_ico: Path) -> None:
    im = Image.open(icon_png_512).convert("RGBA")
    im.save(
        out_ico,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def png_to_bmp24(png: Path, bmp: Path) -> None:
    im = Image.open(png).convert("RGB")
    im.save(bmp, format="BMP")
    png.unlink()


def write_license_rtf(license_path: Path, out_rtf: Path) -> None:
    text = license_path.read_text(encoding="utf-8")
    escaped = []
    for line in text.splitlines():
        line = line.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        escaped.append(line + r"\line ")
    header = (
        r"{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss Segoe UI;}{\f1\fmodern Consolas;}}"
        r"\fs18\f0\b Paperboat Launcher\b0\line "
        r"Copyright (C) PaperboatLab. Licensed under the GNU General Public License v3.0 (GPL-3.0-only).\line\line "
        r"\f1\fs16 "
    )
    out_rtf.write_text(header + "\n".join(escaped) + "\n}", encoding="ascii", errors="replace")


def main() -> None:
    icon_svg = BUILD / "icon.svg"
    icon_png = BUILD / "icon.png"
    svg_to_png(icon_svg, icon_png, 512, 512)
    write_ico(icon_png, BUILD / "icon.ico")
    write_icns(icon_svg, BUILD / "icon.icns")

    svg_to_png(HERE / "dmg-background.svg", HERE / "dmg-background.png", 540, 380)
    svg_to_png(HERE / "dmg-background.svg", HERE / "dmg-background@2x.png", 1080, 760)

    tmp_dialog = HERE / ".tmp-msi-dialog.png"
    tmp_banner = HERE / ".tmp-msi-banner.png"
    svg_to_png(HERE / "msi-dialog.svg", tmp_dialog, 493, 312)
    svg_to_png(HERE / "msi-banner.svg", tmp_banner, 493, 58)
    png_to_bmp24(tmp_dialog, HERE / "msi-dialog.bmp")
    png_to_bmp24(tmp_banner, HERE / "msi-banner.bmp")

    license_file = REPO / "LICENSE"
    shutil.copyfile(license_file, HERE / "LICENSE.txt")
    write_license_rtf(license_file, HERE / "license.rtf")


if __name__ == "__main__":
    main()
