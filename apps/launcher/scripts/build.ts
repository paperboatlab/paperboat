// Builds dist/: main.cjs and preload.cjs (Electron's main process and the page's door) and renderer/
// (the page: bundle, css, fonts, the app marks, index.html). `--watch` rebuilds the page on change.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const page = path.join(dist, 'renderer');
const kit = path.dirname(fileURLToPath(import.meta.resolve('@paperboatlab/ui/tokens.css')));
fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(page, {recursive: true});
fs.cpSync(path.join(kit, 'marks'), path.join(page, 'marks'), {recursive: true});
fs.writeFileSync(path.join(page, 'index.html'), `<!doctype html>
<html lang="en" data-app="paperboat">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">
<title>Paperboat Launcher</title>
<link rel="icon" href="marks/paperboat/rest.webp">
<link rel="stylesheet" href="main.css">
</head>
<body><div id="root"></div><script type="module" src="main.js"></script></body>
</html>
`);
const node: esbuild.BuildOptions = {bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning'};
await esbuild.build({...node, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(dist, 'main.cjs')});
await esbuild.build({...node, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(dist, 'preload.cjs')});
const renderer: esbuild.BuildOptions = {
  entryPoints: [path.join(root, 'src/main.tsx')], bundle: true, format: 'esm', outdir: page, jsx: 'automatic', target: 'es2022',
  minify: !process.argv.includes('--watch') && !process.env.PB_DEBUG, sourcemap: true, loader: {'.woff2': 'file', '.woff': 'file', '.ttf': 'file'}, assetNames: 'fonts/[name]-[hash]', logLevel: 'warning',
};
if (process.argv.includes('--watch')) await (await esbuild.context(renderer)).watch();
else await esbuild.build(renderer);
