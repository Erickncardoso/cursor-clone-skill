#!/usr/bin/env node
// capture.mjs
//
// Standalone capture step of the "clone-page" Cursor skill. Opens a real
// page in headless Chromium (via Playwright), captures DOM/CSS/assets the
// same way the VibeCloner browser extension did, downloads real asset bytes
// locally (hashed, deduped), and writes everything straight into a folder
// inside the current project. No popup, no ZIP, no manual download step —
// the Cursor agent runs this from the terminal and then reads the output
// files directly.
//
// Usage:
//   node scripts/clone/capture.mjs <url> [outDir] [options]
//
// Options:
//   --viewport=1440x900     Viewport size for the capture (default 1440x900)
//   --steps=6                Number of scroll checkpoints, 2-12 (default 6)
//   --no-assets               Skip downloading asset bytes (URLs only)
//   --max-asset-bytes=8000000 Per-file cap while downloading assets (default 8MB)
//   --max-total-bytes=80000000 Total asset budget for the whole capture (default 80MB)
//   --timeout=45000           Navigation timeout in ms (default 45000)
//
// Output layout (written under outDir, default ./clone-capture/<slug>-<ts>):
//   capture-manifest.json   run metadata + honest limitations list
//   layout.json  typography.json  colors.json  frameworks.json
//   css.json  pseudo-elements.json
//   dom.json                 full DOM tree with computed styles
//   assets-manifest.json     originalUrl -> localPath map + failures
//   assets/<sha256>.<ext>    downloaded image/font/css bytes
//   screenshots/checkpoint-*.png + full-page.png

import { chromium } from 'playwright';
import { captureInBrowser } from './browser-capture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const [url, maybeOutDir, ...rest] = argv;
  if (!url) {
    console.error('Usage: node scripts/clone/capture.mjs <url> [outDir] [options]');
    process.exit(1);
  }
  const flags = { url, outDir: null, viewport: '1440x900', steps: 6, downloadAssets: true, maxAssetBytes: 8_000_000, maxTotalBytes: 80_000_000, timeout: 45000 };
  const args = maybeOutDir && !maybeOutDir.startsWith('--') ? [maybeOutDir, ...rest] : [maybeOutDir, ...rest].filter(Boolean);
  if (maybeOutDir && !maybeOutDir.startsWith('--')) flags.outDir = maybeOutDir;
  for (const arg of args) {
    if (!arg || !arg.startsWith('--')) continue;
    const [key, val] = arg.replace(/^--/, '').split('=');
    if (key === 'viewport') flags.viewport = val;
    if (key === 'steps') flags.steps = Math.min(12, Math.max(2, parseInt(val, 10) || 6));
    if (key === 'no-assets') flags.downloadAssets = false;
    if (key === 'max-asset-bytes') flags.maxAssetBytes = parseInt(val, 10) || flags.maxAssetBytes;
    if (key === 'max-total-bytes') flags.maxTotalBytes = parseInt(val, 10) || flags.maxTotalBytes;
    if (key === 'timeout') flags.timeout = parseInt(val, 10) || flags.timeout;
  }
  return flags;
}

function slugify(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'page';
  } catch { return 'page'; }
}

function extFromContentType(ct, fallbackUrl) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/avif': '.avif',
    'image/svg+xml': '.svg', 'image/gif': '.gif', 'image/x-icon': '.ico',
    'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
    'application/font-woff2': '.woff2', 'application/font-woff': '.woff',
    'text/css': '.css',
  };
  if (ct && map[ct.split(';')[0].trim()]) return map[ct.split(';')[0].trim()];
  try {
    const p = new URL(fallbackUrl).pathname;
    const m = p.match(/\.[a-z0-9]{2,5}$/i);
    if (m) return m[0];
  } catch {}
  return '.bin';
}

function collectAssetUrls(captured) {
  const urls = new Set();
  const { assets, css, layout } = captured;
  for (const img of assets.images || []) if (img.url) urls.add(img.url);
  for (const font of assets.fonts || []) {
    if (font.url) urls.add(font.url);
    for (const u of font.urls || []) urls.add(u);
  }
  if (layout.favicon) urls.add(layout.favicon);
  // url(...) references inside captured CSS rules that aren't already covered
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  for (const rule of css.allRules || []) {
    let m;
    while ((m = urlRe.exec(rule.cssText || '')) !== null) {
      const raw = m[1];
      if (raw.startsWith('data:')) continue;
      urls.add(raw);
    }
  }
  return [...urls].filter(Boolean);
}

async function downloadAsset(url, outDir, budget, maxAssetBytes) {
  if (budget.used >= budget.total) return { url, status: 'skipped_budget' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { url, status: 'http_error', code: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxAssetBytes) return { url, status: 'too_large', bytes: buf.byteLength };
    if (budget.used + buf.byteLength > budget.total) return { url, status: 'skipped_budget' };
    budget.used += buf.byteLength;
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const ext = extFromContentType(res.headers.get('content-type'), url);
    const filename = `${hash}${ext}`;
    await writeFile(path.join(outDir, 'assets', filename), buf);
    return { url, status: 'ok', localPath: `assets/${filename}`, bytes: buf.byteLength, contentType: res.headers.get('content-type') || null };
  } catch (err) {
    return { url, status: 'failed', error: String(err?.message || err) };
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const [vw, vh] = flags.viewport.split('x').map(Number);
  const outDir = path.resolve(flags.outDir || path.join('clone-capture', `${slugify(flags.url)}-${Date.now()}`));

  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(path.join(outDir, 'screenshots'), { recursive: true });

  console.log(`[clone] launching Chromium...`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: vw || 1440, height: vh || 900 } });
  const page = await context.newPage();

  const warnings = [];
  console.log(`[clone] navigating to ${flags.url}`);
  try {
    await page.goto(flags.url, { waitUntil: 'networkidle', timeout: flags.timeout });
  } catch (err) {
    warnings.push(`navigation_warning: ${err.message} (continuing with whatever loaded)`);
  }

  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  await page.waitForTimeout(500);

  const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const stepCount = flags.steps;
  console.log(`[clone] scrolling through ${stepCount} checkpoints to trigger lazy-loaded content...`);
  for (let i = 0; i < stepCount; i++) {
    const y = Math.round((fullHeight * i) / (stepCount - 1 || 1));
    await page.evaluate((pos) => window.scrollTo(0, pos), y);
    await page.waitForTimeout(350);
    try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
    const shot = path.join(outDir, 'screenshots', `checkpoint-${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  console.log(`[clone] capturing full-page screenshot...`);
  try { await page.screenshot({ path: path.join(outDir, 'screenshots', 'full-page.png'), fullPage: true }); }
  catch (err) { warnings.push(`fullpage_screenshot_failed: ${err.message}`); }

  console.log(`[clone] running DOM/CSS/asset capture in page context...`);
  const captured = await page.evaluate(captureInBrowser);

  await browser.close();

  let assetsManifest = { downloaded: false, entries: [] };
  if (flags.downloadAssets) {
    console.log(`[clone] downloading asset bytes locally...`);
    const urls = collectAssetUrls(captured);
    const budget = { used: 0, total: flags.maxTotalBytes };
    const entries = [];
    for (const url of urls) {
      entries.push(await downloadAsset(url, outDir, budget, flags.maxAssetBytes));
    }
    assetsManifest = { downloaded: true, totalBytesUsed: budget.used, totalBytesBudget: budget.total, entries };
    console.log(`[clone] downloaded ${entries.filter(e => e.status === 'ok').length}/${entries.length} assets (${(budget.used / 1e6).toFixed(1)}MB)`);
  } else {
    assetsManifest = { downloaded: false, entries: collectAssetUrls(captured).map(url => ({ url, status: 'not_downloaded' })) };
  }

  await writeFile(path.join(outDir, 'dom.json'), JSON.stringify(captured.dom, null, 2));
  await writeFile(path.join(outDir, 'css.json'), JSON.stringify(captured.css, null, 2));
  await writeFile(path.join(outDir, 'pseudo-elements.json'), JSON.stringify(captured.pseudoElements, null, 2));
  await writeFile(path.join(outDir, 'colors.json'), JSON.stringify(captured.colors, null, 2));
  await writeFile(path.join(outDir, 'layout.json'), JSON.stringify(captured.layout, null, 2));
  await writeFile(path.join(outDir, 'typography.json'), JSON.stringify(captured.typography, null, 2));
  await writeFile(path.join(outDir, 'frameworks.json'), JSON.stringify(captured.frameworks, null, 2));
  await writeFile(path.join(outDir, 'assets-raw.json'), JSON.stringify(captured.assets, null, 2));
  await writeFile(path.join(outDir, 'assets-manifest.json'), JSON.stringify(assetsManifest, null, 2));

  const manifest = {
    sourceUrl: flags.url,
    capturedAt: new Date().toISOString(),
    viewport: { width: vw || 1440, height: vh || 900 },
    checkpoints: stepCount,
    domBudget: captured.domBudget,
    warnings,
    knownLimitations: [
      'Canvas/WebGL content is a best-effort raster snapshot only (toDataURL); scenes, shaders and buffers are not extracted.',
      'Cross-origin stylesheets that block cssRules() cannot be read; check css.json.inaccessibleSheets for what was skipped.',
      'DRM-protected or authenticated video/audio is never downloaded, only its public URL if present in the DOM.',
      'Closed shadow roots are inaccessible by browser design and are not represented in dom.json.',
      'GSAP/Framer Motion/Lottie/scroll-library state reflects the DOM at capture time, not full timeline/animation logic.',
      'Nodes beyond the DOM budget (domBudget.omittedSubtrees) are marked but not expanded — re-run with a narrower page/section if this is non-zero and matters.',
    ],
  };
  await writeFile(path.join(outDir, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n[clone] done. Output written to:\n  ${outDir}\n`);
  console.log(`[clone] next: read capture-manifest.json, layout.json, frameworks.json, dom.json, css.json, colors.json, typography.json, assets-manifest.json, and screenshots/*.png, then reconstruct.`);
}

main().catch(err => {
  console.error('[clone] fatal error:', err);
  process.exit(1);
});
