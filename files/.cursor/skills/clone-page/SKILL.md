---
name: clone-page
description: Clone/replicate the visual design of a live webpage (DOM structure, CSS, colors, typography, assets) directly into this project's existing stack, using a local Playwright capture instead of a browser extension/ZIP. Use whenever the user asks to clone, copy, replicate, extract, or recreate a site/page/design/layout from a URL.
---

# Clone Page — capture a live site and rebuild it in this project

Trigger phrases (pt-BR and en): "clona esse site", "clona essa página", "extrai o design de <url>",
"copia o layout de <url>", "replica essa landing page", "clone this page", "recreate this design from <url>".

This replaces the old two-step workflow (browser extension → export ZIP → paste into chat).
Everything now happens in one pass, driven by you (the agent), with no manual download step.

## 0. Preconditions

- The URL must be something the user is authorized to clone: their own site, a client site, a
  public reference/inspiration page. Never use this to bypass login, paywalls, or DRM — the
  capture script already refuses to touch authenticated/protected content and will just report it
  as unavailable. If the user's intent looks like evading access controls, stop and say so.
- If this project has no `node_modules/playwright` yet, install it once at the project root:
  ```
  npm install playwright && npx playwright install chromium
  ```
  (Only Chromium is needed — don't install the full browser matrix.)

## 1. Capture

Run the capture script from the project root, pointing at the target URL:

```
node .cursor/skills/clone-page/scripts/capture.mjs "<url>" clone-capture/<slug>
```

- Pick `<slug>` from the page (e.g. `air-inc-home`). If the user didn't give a target folder,
  this default is fine.
- Wait for it to finish — it prints the output directory path when done. Typical run takes
  20–60s depending on page weight; it scrolls through checkpoints to trigger lazy-loaded content
  and downloads real asset bytes (images/fonts/css), not just URLs.
- If it errors on navigation (timeout, blocked, etc.), read the printed warning and decide whether
  to retry with `--timeout=90000` or a narrower URL before giving up.

## 2. Read what was captured

Read, in this order, from the output folder (`clone-capture/<slug>/`):

1. `capture-manifest.json` — run metadata and the honest **knownLimitations** list. Always carry
   these into your final report to the user; don't imply higher fidelity than what was captured.
2. `layout.json`, `frameworks.json`, `typography.json`, `colors.json` — page-level facts that
   steer the reconstruction (detected stack, fonts, palette, viewport).
3. `screenshots/full-page.png` and the `screenshots/checkpoint-*.png` files — look at these as the
   visual ground truth before writing any code.
4. `dom.json` — the structural source of truth (tag, attrs, computed `styles`, `rect`, children,
   text nodes, `::before`/`::after` as `pseudos`). Nodes with `omitted: true` mean the DOM budget
   was hit — call this out if it affects a section that matters.
5. `css.json` — keyframes, custom properties (CSS variables), media query breakpoints, and every
   readable CSS rule. `inaccessibleSheets` lists cross-origin stylesheets that couldn't be read.
6. `assets-manifest.json` — maps every original asset URL to its local path under
   `clone-capture/<slug>/assets/<hash>.<ext>` (or a `status` explaining why it wasn't downloaded:
   `too_large`, `http_error`, `failed`, `skipped_budget`). **Always use the local path when one
   exists — never hotlink the original site's URLs in the output.**

## 3. Decide the output format from the CURRENT project, not a fixed default

Before writing anything, check what this project already is:

- Look at `package.json`, `next.config.*`, `tailwind.config.*`, `tsconfig.json`, existing
  component folders.
- If it's a **Next.js/React project**: build the clone as a page/component using the project's
  existing conventions (App Router vs Pages Router, TypeScript vs JS, CSS Modules vs
  Tailwind vs styled-components — match what's already there). If Tailwind is present, prefer
  Tailwind utilities and fall back to arbitrary-value classes (`w-[1240px]`, `top-[86px]`) for
  values with no close utility match, rather than approximating and drifting from the capture.
- If it's a **plain HTML/CSS/JS project** (or an empty folder): generate static
  `index.html` + `styles.css`, mirroring the DOM tree and computed styles closely.
- If the user explicitly names a stack ("faz isso em Vue", "quero como componente React"), that
  instruction wins over what's auto-detected.
- Never invent a framework that isn't already in the project unless the user asked for it.

## 4. Reconstruct

- Walk `dom.json` and emit matching markup/JSX, preserving element order, text content, and
  structure (including mixed text/element children).
- Translate each node's `styles` object into the target styling approach (CSS rules, Tailwind
  classes, or styled-components) using the literal captured values — don't round or guess.
- Wire up colors/typography from `colors.json` / `typography.json` as shared tokens
  (CSS variables, Tailwind theme extension, or a constants file) when the project has a place for
  them; otherwise inline them.
- Reproduce `@keyframes` / `animation` / `transition` from `css.json` where a node's styles
  reference them.
- Render `::before`/`::after` pseudo-content (`node.pseudos`) as real pseudo-element CSS, not as
  extra DOM nodes.
- Point every `src`/`href`/`background-image`/`font-face url()` at the local path from
  `assets-manifest.json`. If an asset's status isn't `ok`, keep the original remote URL as a
  fallback and flag it in your summary instead of silently breaking the layout.
- Inline SVGs (`dom.json` nodes with `svgContent`) should be embedded as real inline SVG, not
  screenshotted.

## 5. Verify before declaring done

- Run/build the project (or open the generated static file) and take a screenshot or visually
  compare it against `screenshots/full-page.png`. Note real differences instead of assuming a
  pixel-perfect match.
- Summarize for the user: what was captured and reconstructed faithfully, and what's listed under
  `capture-manifest.json`'s `knownLimitations` (canvas/WebGL, DRM/auth video, cross-origin CSS,
  closed shadow roots, budget-omitted nodes) so expectations stay honest.

## 6. Cleanup

- `clone-capture/` holds raw capture data (JSON + downloaded assets + screenshots), not the final
  deliverable. Suggest adding it to `.gitignore` unless the user wants to keep it as a reference
  snapshot. The reconstructed code itself (step 4's output) is what should be committed.
