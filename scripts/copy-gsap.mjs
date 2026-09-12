// Copies the GSAP files the marketing pages use from node_modules into
// public/js/gsap/, so plain HTML pages load the npm-installed version
// rather than a CDN copy. Run after installing or upgrading gsap:
//
//   npm run copy:gsap
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const FILES = ['gsap.min.js', 'SplitText.min.js'];
const src = new URL('../node_modules/gsap/dist/', import.meta.url);
const dest = new URL('../public/js/gsap/', import.meta.url);

mkdirSync(dest, { recursive: true });
for (const f of FILES) copyFileSync(new URL(f, src), new URL(f, dest));

const { version } = JSON.parse(readFileSync(new URL('../node_modules/gsap/package.json', import.meta.url), 'utf8'));
console.log(`Copied gsap ${version} (${FILES.join(', ')}) to public/js/gsap/`);
