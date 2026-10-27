// Builds dist/shenron.html: one self-contained page with the card data,
// the app, and the simulation worker (run from a blob URL) inlined.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const cards = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));

const common = { bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none' };

const worker = await build({ ...common, entryPoints: ['src/workers/sim.worker.ts'] });
const workerSrc = worker.outputFiles[0].text;

const app = await build({
  ...common,
  entryPoints: ['src/ui/app.tsx'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: {
    __WORKER_SOURCE__: JSON.stringify(workerSrc),
    __BUNDLED_CARDS__: JSON.stringify(cards),
    __BUNDLED_META__: JSON.stringify(meta),
  },
});
const css = readFileSync('src/ui/styles.css', 'utf8');
const js = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const html = `<meta charset="utf-8">
<title>Shenron Deck Lab</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&family=Saira+Condensed:wght@600;700;800&display=swap">
<style>${css}</style>
<div id="app"></div>
<script>${js}</script>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/shenron.html', html);
console.log(`dist/shenron.html ${(html.length / 1024).toFixed(0)} KB (worker ${(workerSrc.length / 1024).toFixed(0)} KB)`);
