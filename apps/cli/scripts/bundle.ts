// The TUI as one file for the packages (share/paperboat/cli/main.js): Ink, React and the client
// inlined, so it runs on a bare `node` with no node_modules.
import {build} from 'esbuild';

await build({
  entryPoints: [new URL('../src/main.tsx', import.meta.url).pathname],
  outfile: new URL('../dist/main.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  // Ink's devtools (only with DEV=true) import react-devtools-core statically: an empty module here
  plugins: [{name: 'no-devtools', setup: b => {
    b.onResolve({filter: /^react-devtools-core$/}, () => ({path: 'devtools', namespace: 'empty'}));
    b.onLoad({filter: /.*/, namespace: 'empty'}, () => ({contents: 'export default {}'}));
  }}],
  define: {'process.env.NODE_ENV': '"production"'},
  banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);"},
  minify: true,
  legalComments: 'none',
});
