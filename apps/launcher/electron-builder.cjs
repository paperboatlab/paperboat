const msiProjectCreated = require("./build/msi-hook.cjs");

module.exports = {
  appId: "dev.paperboatlab.launcher",
  productName: "Paperboat Launcher",
  copyright: "Copyright © PaperboatLab (GPL-3.0-only)",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: [
    "dist/**/*",
    "electron/**/*",
    "public/favicon.svg",
    "package.json",
  ],
  extraResources: [
    { from: "../../LICENSE", to: "LICENSE" },
    { from: "resources/paperboat", to: "paperboat", filter: ["**/*"] },
  ],
  fileAssociations: [
    { ext: "pst", name: "Paperboat Station Package", role: "Viewer" },
  ],
  linux: {
    target: [
      { target: "deb", arch: "x64" },
      { target: "rpm", arch: "x64" },
    ],
    category: "Development",
    maintainer: "PaperboatLab <hello@paperboatlab.dev>",
    executableName: "paperboat-launcher",
    syncDesktopName: true,
    artifactName: "paperboat-launcher-${version}-${arch}.${ext}",
    icon: "build/icon.png",
  },
  deb: {
    packageName: "paperboat-launcher",
    afterInstall: "build/linux-after-install.sh",
    afterRemove: "build/linux-after-remove.sh",
  },
  rpm: {
    packageName: "paperboat-launcher",
    afterInstall: "build/linux-after-install.sh",
    afterRemove: "build/linux-after-remove.sh",
  },
  mac: {
    target: [{ target: "dmg", arch: "arm64" }],
    category: "public.app-category.developer-tools",
    artifactName: "Paperboat-Launcher-${version}-${arch}.${ext}",
    icon: "build/icon.icns",
  },
  dmg: {
    title: "Paperboat Launcher ${version}",
    icon: "build/icon.icns",
    background: "build/installer/dmg-background.png",
    iconSize: 80,
    window: { width: 540, height: 380 },
    contents: [
      { x: 145, y: 192, type: "file" },
      { x: 395, y: 192, type: "link", path: "/Applications" },
      { x: 270, y: 326, type: "file", path: "build/installer/LICENSE.txt", name: "LICENSE.txt" },
    ],
  },
  win: {
    target: [{ target: "msi", arch: "x64" }],
    artifactName: "Paperboat-Launcher-${version}-${arch}.${ext}",
    icon: "build/icon.ico",
  },
  msi: {
    oneClick: false,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Paperboat Launcher",
    additionalWixArgs: ["-ext", "WixUtilExtension"],
  },
  msiProjectCreated,
};
