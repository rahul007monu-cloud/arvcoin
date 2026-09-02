/**
 * Rasterise favicon.svg into the PNG sizes the manifest asks for.
 *
 *   node tools/build-icons.mjs
 *
 * Needs Playwright's chromium:  npm i -D playwright && npx playwright install chromium
 * Set CHROMIUM_PATH to use a Chrome you already have instead.
 *
 * Why PNGs at all, when the manifest already lists the SVG: Chrome will install a
 * PWA from an SVG, but Android's launcher and the splash screen want real PNGs at
 * known sizes, and a manifest pointing at files that do not exist is an install
 * warning on every load.
 *
 * The maskable variant is not the standard icon scaled down. A maskable icon is
 * cropped to whatever shape the launcher prefers — circle, squircle, rounded
 * square — so the plate is painted edge to edge by the page and the mark is drawn
 * at 60% inside it. Reusing the standard icon would put a rounded box inside the
 * launcher's own rounded crop, a frame inside a frame, and have its corners
 * shaved off.
 *
 * Run this after any change to favicon.svg, and commit the output — the icons are
 * checked in so a deploy needs no build step.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(ROOT, 'favicon.svg'), 'utf8');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (_) {
  console.error('Playwright is not installed. Run:\n'
    + '  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox']
});

async function shoot(size, { maskable = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1
  });

  const inner = maskable ? Math.round(size * 0.60) : size;
  const art = maskable
    ? svg.replace(/<rect width="64" height="64"[^>]*\/>\s*/g, '')
         .replace(/<rect x="\.5" y="\.5"[\s\S]*?\/>\s*/g, '')
    : svg;

  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;width:${size}px;height:${size}px;
    background:${maskable ? '#07070a' : 'transparent'};
    display:flex;align-items:center;justify-content:center">
    <div style="width:${inner}px;height:${inner}px;line-height:0">
      ${art.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}
    </div></body></html>`);

  const buf = await page.screenshot({ omitBackground: !maskable, type: 'png' });
  await page.close();
  return buf;
}

writeFileSync(join(ROOT, 'icons/icon-192.png'), await shoot(192));
writeFileSync(join(ROOT, 'icons/icon-512.png'), await shoot(512));
writeFileSync(join(ROOT, 'icons/icon-maskable-512.png'), await shoot(512, { maskable: true }));

await browser.close();
console.log('Wrote icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png');
