// Prints apps/landing/whitepaper.html to apps/landing/rein-whitepaper.pdf.
// Run after any text change to the whitepaper (RELEASING.md bumps the counts in it).
//
//   npm i --prefix <dir> playwright-core      # once, outside the repo; not a workspace dependency
//   PLAYWRIGHT_DIR=<dir> node scripts/whitepaper-pdf.mjs
//
// It uses an already installed Playwright Chromium (newest ms-playwright/chromium-*),
// or CHROME_PATH if set. Margins and footer reproduce the PDF published since S100:
// A4, 15 pages at 0.8.0, footer "Rein whitepaper . reinconsole.com . n/N".
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const landing = fileURLToPath(new URL('../apps/landing/', import.meta.url));
const require = createRequire(join(process.env.PLAYWRIGHT_DIR ?? process.cwd(), 'noop.js'));
const { chromium } = require('playwright-core');

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.platform === 'win32'
    ? join(homedir(), 'AppData', 'Local', 'ms-playwright')
    : join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(join(base, d, rel))) return join(base, d, rel);
    }
  }
  return undefined; // playwright-core's own expected path
}

const port = 4199;
const server = spawn(process.execPath, ['serve.mjs'], { cwd: landing, env: { ...process.env, PORT: String(port) } });
const url = `http://127.0.0.1:${port}/whitepaper.html`;
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try { up = (await fetch(url)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

const browser = up ? await chromium.launch({ executablePath: chromePath() }) : undefined;
try {
  if (!browser) throw new Error(`landing server did not answer on ${url}`);
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: join(landing, 'rein-whitepaper.pdf'),
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="width:100%;text-align:center;font-size:6pt;font-family:Segoe UI,sans-serif;color:#666">' +
      'Rein whitepaper &middot; reinconsole.com &middot; <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  });
  console.log('wrote apps/landing/rein-whitepaper.pdf');
} finally {
  await browser?.close();
  server.kill();
}
