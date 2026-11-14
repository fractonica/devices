#!/usr/bin/env node
// Screenshots of the dashboard served by a hub (normally the scratch hub of tools/dash-dev.ts), with headless Chrome
// driven over the DevTools protocol (tools/chrome.mjs: exact viewports, the page's console collected).
//
//   node tools/dash-shoot.mjs --url http://127.0.0.1:<port> --out <dir> [--label hub] [--route /] [--widths 1440,390]
//                              [--mode pure|earth] [--look now|a|b|c] [--css <file>] [--wait 1500] [--full] [--motion reduce] [route=label ...]
//
// Each route is shot at every width: 1440 x 900 (scale 1) and 390 x 844 (scale 2), as <label>-<width>.png in --out
// (`route=label` pairs shoot several pages in one run: `/=hub /devices=devices`). --mode sets the PURE / EARTH
// switch first (the dashboard remembers it in localStorage, as the site does); --look picks a design proposal the same
// way, and --css injects a stylesheet after the built ones (a proposal's file under work, with no rebuild). --full photographs the whole
// scrolling content instead of the viewport. It waits for the page's data-ready="1" and then --wait ms (live data,
// the core), prints every console error, warning and failed request, and exits 1 when there was any.

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { launchChrome } from './chrome.mjs';

const argv = process.argv.slice(2);
const opts = { url: process.env.FR_DASH_URL ?? '', out: '', label: 'hub', route: '/', widths: '1440,390', mode: '', look: '', css: '', wait: '1500', full: false, motion: '' };
const pairs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--full') {
    opts.full = true;
  } else if (a.startsWith('--')) {
    opts[a.slice(2)] = argv[++i];
  } else if (a.includes('=')) {
    const [route, label] = a.split('=');
    pairs.push({ route, label });
  }
}
if (!opts.url || !opts.out) {
  console.error('usage: node tools/dash-shoot.mjs --url <hub url> --out <dir> [--label name] [--route /path] [route=label ...]');
  process.exit(2);
}
if (!pairs.length) {
  pairs.push({ route: opts.route, label: opts.label });
}
const SIZES = { 1440: [1440, 900, 1], 390: [390, 844, 2] };
const widths = opts.widths.split(',').map((w) => SIZES[w.trim()] ?? [Number(w), 900, 1]);
const out = resolve(opts.out);
mkdirSync(out, { recursive: true });
const base = opts.url.replace(/\/$/, '');

const chrome = await launchChrome();
let problems = 0;
try {
  for (const { route, label } of pairs) {
    for (const [width, height, scale] of widths) {
      const target = `${base}/#${route.startsWith('/') ? route : `/${route}`}`;
      const page = await chrome.open(`${base}/`, { width, height, scale, reducedMotion: opts.motion === 'reduce' });
      if (opts.mode) {
        await page.evaluate(`localStorage.setItem('fractonica.mode', ${JSON.stringify(opts.mode)})`);
      }
      if (opts.look) {
        await page.evaluate(`localStorage.setItem('fractonica.hub.look', ${JSON.stringify(opts.look)})`);
      }
      await page.evaluate(`location.replace(${JSON.stringify(target)}); location.reload(); true`).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(await page.evaluate("document.documentElement.dataset.ready === '1'").catch(() => false))) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (opts.css) {
        // a stylesheet under work, injected after the built ones (design proposals: styles/looks/<x>.css, no rebuild)
        const text = readFileSync(resolve(opts.css), 'utf8');
        await page.evaluate(`(() => { const s = document.createElement('style'); s.id = 'dash-shoot-css'; s.textContent = ${JSON.stringify(text)}; document.head.append(s); return true; })()`);
      }
      await new Promise((r) => setTimeout(r, Number(opts.wait)));
      const file = join(out, `${label}-${width}.png`);
      await page.screenshot(file, { fullPage: opts.full });
      const bad = page.problems();
      problems += bad.length;
      console.log(`${file}${bad.length ? `\n  ${bad.map((p) => `${p.type}: ${p.text}`).join('\n  ')}` : ''}`);
      await page.close();
    }
  }
} finally {
  await chrome.close();
}
process.exit(problems ? 1 : 0);
