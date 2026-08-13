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
//   --max-asset-bytes=8000000 Per-file cap for images/fonts/css (default 8MB)
//   --max-video-bytes=80000000 Per-file cap for video (default 80MB) — videos are streamed to
//                              disk (never fully buffered in memory), so this is safe to raise.
//   --max-total-bytes=200000000 Total asset budget for the whole capture (default 200MB)
//   --timeout=45000           Navigation timeout in ms (default 45000)
//   --list-elements           Discovery mode: dump elements.json (selector + text + rect for
//                              every clickable/notable element) instead of capturing. Run this
//                              FIRST when the user names one element/component instead of the
//                              whole page — pick the right selector from here, then re-run with
//                              --selector.
//   --selector="<css>"        Scope the capture to one element + its subtree instead of the
//                              whole page (dom.json/assets/screenshot become just that element).
//   --styles-only              Combine with --selector: skip DOM tree/assets entirely, just
//                              write element-styles.json with that element's computed styles.
//                              Fast path for "só quero o estilo desse botão" requests.
//   --video / --no-video      Force screen recording on/off. Default: ON for whole-page and
//                              --selector captures (records the actual scroll-through of the
//                              session as recording/session.webm — this is the "grava vídeo da
//                              página" feature, a real screen recording, not a downloaded
//                              <video> tag), OFF for --list-elements/--styles-only (those are
//                              fast discovery/lookup paths and don't need a recording).
//
// Output layout (written under outDir, default ./clone-capture/<slug>-<ts>):
//   capture-manifest.json   run metadata + honest limitations list
//   layout.json  typography.json  colors.json  frameworks.json   (full-page mode only)
//   css.json  pseudo-elements.json                                (full-page mode only)
//   dom.json                 DOM tree with computed styles (whole page, or just --selector's subtree)
//   assets-manifest.json     originalUrl -> localPath map + failures (each entry tagged with kind)
//   assets/<sha256>.<ext>    downloaded image/font/css/video bytes (streamed, not buffered)
//   recording/session.webm   screen recording of the capture session (scroll-through), when enabled
//   screenshots/checkpoint-*.png + full-page.png (+ element.png when --selector matches)
//   elements.json             only in --list-elements mode: selector inventory for picking a target
//   element-styles.json       only in --styles-only mode: just the computed styles of one element

import { chromium } from 'playwright';
import { captureInBrowser, listElementsInBrowser } from './browser-capture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, rename, copyFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

function parseArgs(argv) {
  const [url, maybeOutDir, ...rest] = argv;
  if (!url) {
    console.error('Usage: node scripts/clone/capture.mjs <url> [outDir] [options]');
    console.error('       node scripts/clone/capture.mjs <url> [outDir] --list-elements');
    console.error('       node scripts/clone/capture.mjs <url> [outDir] --selector="<css>" [--styles-only]');
    process.exit(1);
  }
  const flags = {
    url, outDir: null, viewport: '1440x900', steps: 6, downloadAssets: true,
    maxAssetBytes: 8_000_000, maxVideoBytes: 80_000_000, maxTotalBytes: 200_000_000, timeout: 45000,
    listElements: false, selector: null, stylesOnly: false,
    recordVideo: true, videoFlagSet: false,
  };
  const args = maybeOutDir && !maybeOutDir.startsWith('--') ? [maybeOutDir, ...rest] : [maybeOutDir, ...rest].filter(Boolean);
  if (maybeOutDir && !maybeOutDir.startsWith('--')) flags.outDir = maybeOutDir;
  for (const arg of args) {
    if (!arg || !arg.startsWith('--')) continue;
    const eqIdx = arg.indexOf('=');
    const key = (eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx));
    const val = eqIdx === -1 ? '' : arg.slice(eqIdx + 1);
    if (key === 'viewport') flags.viewport = val;
    if (key === 'steps') flags.steps = Math.min(12, Math.max(2, parseInt(val, 10) || 6));
    if (key === 'no-assets') flags.downloadAssets = false;
    if (key === 'max-asset-bytes') flags.maxAssetBytes = parseInt(val, 10) || flags.maxAssetBytes;
    if (key === 'max-video-bytes') flags.maxVideoBytes = parseInt(val, 10) || flags.maxVideoBytes;
    if (key === 'max-total-bytes') flags.maxTotalBytes = parseInt(val, 10) || flags.maxTotalBytes;
    if (key === 'timeout') flags.timeout = parseInt(val, 10) || flags.timeout;
    if (key === 'list-elements') flags.listElements = true;
    if (key === 'selector') flags.selector = val;
    if (key === 'styles-only') flags.stylesOnly = true;
    if (key === 'no-video') { flags.recordVideo = false; flags.videoFlagSet = true; }
    if (key === 'video') { flags.recordVideo = true; flags.videoFlagSet = true; }
  }
  // Discovery (--list-elements) and styles-only lookups are meant to be
  // fast/cheap — don't record a video for them unless the user explicitly
  // asked for one with --video.
  if (!flags.videoFlagSet && (flags.listElements || flags.stylesOnly)) {
    flags.recordVideo = false;
  }
  if (flags.stylesOnly && !flags.selector) {
    console.error('[clone] --styles-only requires --selector="<css>" — styles of what element?');
    process.exit(1);
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
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv',
  };
  if (ct && map[ct.split(';')[0].trim()]) return map[ct.split(';')[0].trim()];
  try {
    const p = new URL(fallbackUrl).pathname;
    const m = p.match(/\.[a-z0-9]{2,5}$/i);
    if (m) return m[0];
  } catch {}
  return '.bin';
}

// Returns [{url, kind}] instead of plain strings — `kind` picks the right
// byte cap and file extension hint downstream (videos need a much bigger
// cap than images/fonts, and are streamed rather than buffered).
function collectAssetUrls(captured) {
  const seen = new Set();
  const entries = [];
  const add = (url, kind) => {
    if (!url || typeof url !== 'string' || url.startsWith('data:') || seen.has(url)) return;
    seen.add(url);
    entries.push({ url, kind });
  };
  const { assets, css, layout } = captured;
  for (const img of assets.images || []) add(img.url, 'image');
  for (const font of assets.fonts || []) {
    add(font.url, 'font');
    for (const u of font.urls || []) add(u, 'font');
  }
  // Videos were previously captured as metadata-only (URL/poster/autoplay)
  // and never actually downloaded — that's the "vídeo não veio" gap. Public,
  // non-DRM <video src> and poster images now download like any other asset;
  // DRM/authenticated streams still fail cleanly (reported in the manifest,
  // never silently faked).
  for (const video of assets.videos || []) {
    add(video.src, 'video');
    add(video.poster, 'image');
  }
  add(layout.favicon, 'image');
  // url(...) references inside captured CSS rules that aren't already covered
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  for (const rule of css.allRules || []) {
    let m;
    while ((m = urlRe.exec(rule.cssText || '')) !== null) add(m[1], 'image');
  }
  return entries;
}

// Streams the response straight to disk while hashing on the fly — never
// buffers the whole file in memory (the old `res.arrayBuffer()` approach
// was fine for small images but risky for video). If the response declares
// a Content-Length over the cap, it's rejected before any bytes transfer;
// otherwise the stream self-aborts the moment it crosses the cap and the
// partial temp file is removed.
async function downloadAsset(url, outDir, budget, maxBytesForThisAsset) {
  if (budget.used >= budget.total) return { url, status: 'skipped_budget' };
  let tempPath = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { url, status: 'http_error', code: res.status };
    const declaredLen = parseInt(res.headers.get('content-length') || '0', 10);
    if (declaredLen && declaredLen > maxBytesForThisAsset) return { url, status: 'too_large', bytes: declaredLen };
    if (!res.body) return { url, status: 'failed', error: 'no_response_body' };

    const hash = createHash('sha256');
    let total = 0;
    tempPath = path.join(outDir, 'assets', `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > maxBytesForThisAsset) { cb(new Error('too_large')); return; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tempPath));

    if (budget.used + total > budget.total) {
      await unlink(tempPath).catch(() => {});
      return { url, status: 'skipped_budget' };
    }
    budget.used += total;
    const digest = hash.digest('hex').slice(0, 16);
    const ext = extFromContentType(res.headers.get('content-type'), url);
    const finalPath = path.join(outDir, 'assets', `${digest}${ext}`);
    await rename(tempPath, finalPath);
    return { url, status: 'ok', localPath: `assets/${digest}${ext}`, bytes: total, contentType: res.headers.get('content-type') || null };
  } catch (err) {
    if (tempPath) await unlink(tempPath).catch(() => {});
    const tooLarge = String(err?.message || '').includes('too_large');
    return tooLarge ? { url, status: 'too_large' } : { url, status: 'failed', error: String(err?.message || err) };
  }
}

// Closes the context (required to finalize the recorded video, if any) and
// then the browser, moving the finished video from Playwright's internal
// temp location into <outDir>/recording/session.webm. Safe to call whether
// or not recordVideo was actually enabled for this context — page.video()
// is null when it wasn't, so this just closes cleanly in that case.
async function closeAndSaveVideo(browser, context, page, outDir) {
  let videoRelPath = null;
  try {
    const video = page.video();
    await context.close(); // must close the CONTEXT (not just the browser) to finalize the video file
    if (video) {
      const tmpPath = await video.path();
      const destDir = path.join(outDir, 'recording');
      await mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, 'session.webm');
      try {
        await rename(tmpPath, destPath);
      } catch {
        // Cross-device temp dirs can make rename() fail (EXDEV) — copy+delete
        // always works regardless of filesystem.
        await copyFile(tmpPath, destPath);
        await unlink(tmpPath).catch(() => {});
      }
      videoRelPath = 'recording/session.webm';
    }
  } catch (err) {
    console.error(`[clone] video finalize warning: ${err.message}`);
  } finally {
    await rm(path.join(outDir, '.video-tmp'), { recursive: true, force: true }).catch(() => {});
    await browser.close().catch(() => {});
  }
  return videoRelPath;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const [vw, vh] = flags.viewport.split('x').map(Number);
  const outDir = path.resolve(flags.outDir || path.join('clone-capture', `${slugify(flags.url)}-${Date.now()}`));

  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(path.join(outDir, 'screenshots'), { recursive: true });
  const videoTmpDir = path.join(outDir, '.video-tmp');
  if (flags.recordVideo) await mkdir(videoTmpDir, { recursive: true });

  console.log(`[clone] launching Chromium...`);
  const browser = await chromium.launch();
  // deviceScaleFactor: 2 matters a lot for image fidelity — sites that serve
  // responsive `srcset`/`<picture>` images pick the candidate that matches
  // the browser's reported pixel density. At the default factor of 1,
  // Chromium requests the LOW-density variant (what a non-Retina display
  // would ask for), which is what was producing visibly softer/smaller
  // images than the original site. Requesting 2x matches what a normal
  // laptop screen asks for and pulls the higher-resolution asset instead.
  const context = await browser.newContext({
    viewport: { width: vw || 1440, height: vh || 900 },
    deviceScaleFactor: 2,
    // Screen recording of the actual capture session — this is what "grava
    // vídeo da página" means (matching the original extension's tab-capture
    // recording feature), distinct from downloading <video> tag files.
    ...(flags.recordVideo
      ? { recordVideo: { dir: videoTmpDir, size: { width: vw || 1440, height: vh || 900 } } }
      : {}),
  });
  const page = await context.newPage();
  if (flags.recordVideo) console.log(`[clone] recording screen video of the capture session...`);

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

  // Discovery mode: dump a selector inventory instead of capturing anything,
  // so the agent can match "o botão de login" to a real, stable selector
  // before running a scoped capture.
  if (flags.listElements) {
    console.log(`[clone] listing clickable/notable elements...`);
    const elements = await page.evaluate(listElementsInBrowser);
    await closeAndSaveVideo(browser, context, page, outDir);
    await writeFile(path.join(outDir, 'elements.json'), JSON.stringify(elements, null, 2));
    console.log(`\n[clone] done. Found ${elements.length} candidate elements.\n  ${path.join(outDir, 'elements.json')}\n`);
    console.log(`[clone] next: look at elements.json + screenshots/full-page.png, pick the "selector" that matches what the user described, then re-run:`);
    console.log(`  node .cursor/skills/clone-page/scripts/capture.mjs "${flags.url}" ${flags.outDir || outDir} --selector="<selector>"`);
    return;
  }

  if (flags.selector) {
    console.log(`[clone] scoping capture to: ${flags.selector}`);
    try {
      await page.locator(flags.selector).first().scrollIntoViewIfNeeded({ timeout: 5000 });
      await page.locator(flags.selector).first().screenshot({ path: path.join(outDir, 'screenshots', 'element.png') });
    } catch (err) {
      warnings.push(`element_screenshot_failed: ${err.message}`);
    }
  }

  console.log(`[clone] running DOM/CSS/asset capture in page context...`);
  let captured;
  try {
    captured = await page.evaluate(captureInBrowser, { selector: flags.selector, stylesOnly: flags.stylesOnly });
  } catch (err) {
    await closeAndSaveVideo(browser, context, page, outDir).catch(() => {});
    console.error(`[clone] capture failed: ${err.message}`);
    if (String(err.message).includes('selector_not_found')) {
      console.error(`[clone] run with --list-elements first to get a selector that actually exists on this page.`);
    }
    process.exit(1);
  }

  if (flags.stylesOnly) {
    await closeAndSaveVideo(browser, context, page, outDir);
    await writeFile(path.join(outDir, 'element-styles.json'), JSON.stringify(captured, null, 2));
    console.log(`\n[clone] done. Output written to:\n  ${path.join(outDir, 'element-styles.json')}\n`);
    return;
  }

  const videoPath = await closeAndSaveVideo(browser, context, page, outDir);
  if (videoPath) console.log(`[clone] screen recording saved: ${path.join(outDir, videoPath)}`);

  let assetsManifest = { downloaded: false, entries: [] };
  if (flags.downloadAssets) {
    console.log(`[clone] downloading asset bytes locally (images/fonts/css + public video)...`);
    const urls = collectAssetUrls(captured);
    const budget = { used: 0, total: flags.maxTotalBytes };
    const entries = [];
    for (const { url, kind } of urls) {
      const cap = kind === 'video' ? flags.maxVideoBytes : flags.maxAssetBytes;
      entries.push({ kind, ...(await downloadAsset(url, outDir, budget, cap)) });
    }
    assetsManifest = { downloaded: true, totalBytesUsed: budget.used, totalBytesBudget: budget.total, entries };
    const videoCount = entries.filter(e => e.kind === 'video').length;
    console.log(`[clone] downloaded ${entries.filter(e => e.status === 'ok').length}/${entries.length} assets (${(budget.used / 1e6).toFixed(1)}MB)${videoCount ? `, including ${entries.filter(e => e.kind === 'video' && e.status === 'ok').length}/${videoCount} videos` : ''}`);
  } else {
    assetsManifest = { downloaded: false, entries: collectAssetUrls(captured).map(({ url, kind }) => ({ url, kind, status: 'not_downloaded' })) };
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
    scopedSelector: flags.selector || null,
    capturedAt: new Date().toISOString(),
    viewport: { width: vw || 1440, height: vh || 900 },
    checkpoints: stepCount,
    domBudget: captured.domBudget,
    warnings,
    recording: videoPath ? { path: videoPath, note: 'Screen recording of the scripted scroll-through session (not user interactions/hover/click states).' } : null,
    knownLimitations: [
      'Canvas/WebGL content is a best-effort raster snapshot only (toDataURL); scenes, shaders and buffers are not extracted.',
      'Cross-origin stylesheets that block cssRules() cannot be read; check css.json.inaccessibleSheets for what was skipped. Per-element computed styles in dom.json are NOT affected by this — they reflect the final rendered result regardless of stylesheet origin.',
      'Public <video>/<source> files and their posters ARE downloaded now (check assets-manifest.json, kind:"video") — only DRM-protected or authenticated streams still fail, reported as http_error/failed rather than silently skipped.',
      videoPath
        ? 'The screen recording (recording/session.webm) only covers the automated scroll-through used to trigger lazy content — it does not capture hover states, clicks, or other interactions a human would trigger.'
        : 'No screen recording was produced for this run (disabled by default for --list-elements/--styles-only, or --no-video was passed) — re-run with --video to force one.',
      'Closed shadow roots are inaccessible by browser design and are not represented in dom.json.',
      'GSAP/Framer Motion/Lottie/scroll-library state reflects the DOM at capture time, not full timeline/animation logic.',
      'Interactive JS behavior (carousel dot/slide sync, tab switching, accordions, autoplay timers) is not extracted — only the DOM/CSS state of whichever slide/tab was active at capture time is captured. The reconstruction needs its own minimal interaction script to make dots/tabs functional (see SKILL.md step 4).',
      'dom.json node.styles.width/height are the CSS content-box size at capture time (getComputedStyle), NOT the rendered visual size — use node.rect.w/rect.h (getBoundingClientRect, always the true visual size) instead when an element genuinely needs an explicit size, especially for padded buttons/pills/tags.',
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
