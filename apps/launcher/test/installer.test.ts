import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");

test("electron-builder.cjs configures branded DMG and MSI targets", () => {
  const cfg = require(resolve(root, "electron-builder.cjs"));
  assert.equal(cfg.mac.icon, "build/icon.icns");
  assert.equal(cfg.dmg.icon, "build/icon.icns");
  assert.equal(cfg.dmg.background, "build/installer/dmg-background.png");
  assert.deepEqual(cfg.dmg.window, { width: 540, height: 380 });
  assert.equal(cfg.win.icon, "build/icon.ico");
  assert.equal(cfg.msi.perMachine, false);
  assert.equal(cfg.msi.oneClick, false);
  assert.equal(typeof cfg.msiProjectCreated, "function");

  for (const rel of [
    "build/icon.icns",
    "build/icon.ico",
    "build/icon.png",
    "build/installer/dmg-background.png",
    "build/installer/dmg-background@2x.png",
    "build/installer/msi-dialog.bmp",
    "build/installer/msi-banner.bmp",
    "build/installer/license.rtf",
    "build/installer/LICENSE.txt",
  ]) {
    assert.ok(existsSync(resolve(root, rel)), `missing generated asset: ${rel}`);
  }
});

test("patchWixXml injects WiX branding bitmaps, license RTF, and launch-on-finish", () => {
  const { patchWixXml } = require(resolve(root, "build/msi-hook.cjs"));
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Paperboat Launcher">
    <UI>
      <UIRef Id="WixUI_InstallDir" />
    </UI>
  </Product>
</Wix>`;
  const patched = patchWixXml(sample, "/tmp/installer");
  assert.match(patched, /WixVariable Id="WixUIDialogBmp" Value="\/tmp\/installer\/msi-dialog\.bmp"/);
  assert.match(patched, /WixVariable Id="WixUIBannerBmp" Value="\/tmp\/installer\/msi-banner\.bmp"/);
  assert.match(patched, /WixVariable Id="WixUILicenseRtf" Value="\/tmp\/installer\/license\.rtf"/);
  assert.match(patched, /WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT/);
  assert.match(patched, /LaunchApplication/);
  assert.match(readFileSync(resolve(root, "build/installer/license.rtf"), "utf8"), /^\\?\{\\rtf1/);
});
