// Customize the electron-builder generated WiX .wxs project with Paperboat branding,
// the GPL-3.0 licence agreement, and an optional Launch checkbox on the finish dialog.
const fs = require("fs");
const path = require("path");

function patchWixXml(xml, assetsDir) {
  const wixPath = (name) => path.join(assetsDir, name).replace(/\\/g, "/");
  let out = xml;

  const vars = [
    `<WixVariable Id="WixUIDialogBmp" Value="${wixPath("msi-dialog.bmp")}" />`,
    `<WixVariable Id="WixUIBannerBmp" Value="${wixPath("msi-banner.bmp")}" />`,
    `<WixVariable Id="WixUILicenseRtf" Value="${wixPath("license.rtf")}" />`,
  ].join("\n    ");

  if (!out.includes('Id="WixUIDialogBmp"')) {
    out = out.replace(/<Product\b[^>]*>/, (m) => `${m}\n    ${vars}`);
  }

  if (!out.includes("WIXUI_EXITDIALOGOPTIONALCHECKBOX")) {
    const launchProps = [
      `<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Launch Paperboat Launcher" />`,
      `<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1" />`,
      `<Property Id="WixShellExecTarget" Value="[APPLICATIONFOLDER]Paperboat Launcher.exe" />`,
      `<CustomAction Id="LaunchApplication" BinaryKey="WixCA" DllEntry="WixShellExec" Impersonate="yes" />`,
    ].join("\n    ");
    out = out.replace("</Product>", `    ${launchProps}\n  </Product>`);

    const finishPublish = `<Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchApplication">WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 and NOT Installed</Publish>`;
    if (out.includes("</UI>")) {
      out = out.replace("</UI>", `      ${finishPublish}\n    </UI>`);
    } else {
      out = out.replace("</Product>", `    <UI>\n      ${finishPublish}\n    </UI>\n  </Product>`);
    }
  }

  return out;
}

module.exports = async function msiProjectCreated(projectPath) {
  const wxsPath = fs.statSync(projectPath).isDirectory()
    ? path.join(projectPath, "project.wxs")
    : projectPath;
  if (!fs.existsSync(wxsPath)) return;
  const xml = fs.readFileSync(wxsPath, "utf8");
  const patched = patchWixXml(xml, path.join(__dirname, "installer"));
  fs.writeFileSync(wxsPath, patched, "utf8");
};

module.exports.patchWixXml = patchWixXml;
