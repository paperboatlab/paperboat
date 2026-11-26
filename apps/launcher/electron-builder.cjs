// The Launcher's packages (pb#9): `npm run package -w @paperboat/launcher` → release/. rpm x86_64 for
// now (deb pb#2, dmg pb#1). The desktop entry is linux/paperboat-launcher.desktop (electron-builder writes
// Exec itself: /opt/Paperboat Launcher/paperboat-launcher, linked as /usr/bin/paperboat-launcher), the icon
// the kit's Paperboat mark (the build copies it to dist/renderer/marks). Everything runs from the bundled
// dist/, so the package carries no node_modules.
const fs = require('node:fs');
const path = require('node:path');

const {Exec, Comment, ...entry} = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, 'linux/paperboat-launcher.desktop'), 'utf8')
    .split('\n').filter(l => /^[A-Za-z]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

module.exports = {
  appId: 'dev.paperboatlab.launcher',
  productName: 'Paperboat Launcher',
  electronVersion: require('electron/package.json').version,  // the installed one (package.json has a range)
  copyright: 'Copyright © Paperboat Lab (GPL-3.0-only)',
  directories: {output: 'release'},
  files: ['dist/**/*', '!**/*.map', 'package.json'],
  extraResources: [{from: '../../LICENSE', to: 'LICENSE'}],
  linux: {
    target: [{target: 'rpm', arch: 'x64'}],
    executableName: 'paperboat-launcher',
    syncDesktopName: true,
    category: entry.Categories.replace(/;$/, ''),
    description: Comment,
    desktop: {entry},
    icon: 'dist/renderer/marks/paperboat/icon.png',
    maintainer: 'Paperboat Lab',
    artifactName: 'paperboat-launcher-${version}.${arch}.${ext}',
  },
  // electron-builder's own list (Electron's libraries), and the CLI the Launcher runs (PAPERBOAT_BIN overrides)
  rpm: {
    packageName: 'paperboat-launcher', vendor: 'Paperboat Lab',
    depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', '(libXtst or libXtst6)', 'xdg-utils', 'at-spi2-core', '(libuuid or libuuid1)', 'paperboat-cli'],
  },
};
