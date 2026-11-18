# Launcher Installer Assets

Editable SVG sources and generated assets for the macOS `.dmg` and Windows `.msi` installers:

- `dmg-background.svg` → `dmg-background.png` (`540×380`) and `dmg-background@2x.png` (`1080×760`)
- `msi-dialog.svg` → `msi-dialog.bmp` (`493×312`, 24-bit BMP for `WixUIDialogBmp`)
- `msi-banner.svg` → `msi-banner.bmp` (`493×58`, 24-bit BMP for `WixUIBannerBmp`)
- `../icon.svg` → `../icon.png` (`512×512`), `../icon.ico` (16–256px), `../icon.icns` (128–1024px)
- `../../../../LICENSE` → `LICENSE.txt` (DMG) and `license.rtf` (`WixUILicenseRtf`)

## Regenerate

Requires `rsvg-convert` (`librsvg2-tools`) and Python `Pillow`:

```sh
python3 apps/launcher/build/installer/generate.py
```
