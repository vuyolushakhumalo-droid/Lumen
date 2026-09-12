// Regenerates the motion kit's CSS and JS inside the demo page
// (public/kit/lintel-motion-kit.html, served at /kit) from
// lib/motion-kit.js, so the demo always shows exactly what builds get.
//
//   node scripts/build-kit-demo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { MOTION_KIT_CSS, MOTION_KIT_JS } from '../lib/motion-kit.js';

const path = new URL('../public/kit/lintel-motion-kit.html', import.meta.url);
const html = readFileSync(path, 'utf8');

const blocks = [
  ['/* ==== MOTION KIT CSS', '/* ==== END MOTION KIT CSS ==== */', MOTION_KIT_CSS],
  ['/* ==== MOTION KIT JS', '/* ==== END MOTION KIT JS ==== */', MOTION_KIT_JS],
];

let out = html;
for (const [startTag, endTag, body] of blocks) {
  const start = out.indexOf(startTag);
  const end = out.indexOf(endTag);
  if (start < 0 || end < start) throw new Error(`Marker not found in the demo page: ${startTag}`);
  const startLineEnd = out.indexOf('\n', start) + 1;
  out = out.slice(0, startLineEnd) + body + '\n' + out.slice(end);
}

writeFileSync(path, out);
console.log(out === html ? 'Demo already up to date.' : 'Demo updated from lib/motion-kit.js.');
