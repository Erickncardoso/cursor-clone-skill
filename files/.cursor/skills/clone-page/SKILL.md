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

## 1. Decide the scope BEFORE capturing: whole page, one element, or just its style

Read what the user actually asked for — this changes which command you run:

- **Whole page** ("clona esse site", "extrai o design de `<url>`"): go straight to step 1a below.
- **One element/component** ("clica nesse botão e clona ele", "só esse card", "extrai só o
  header"): the user named something specific, not the whole page. Do **not** guess a CSS
  selector from the description alone — go to step 1b first to get a real one.
- **Just the style of one element** ("pega só o estilo desse botão", "qual a cor de fundo desse
  card", "só quero o CSS desse elemento"): same as above, but finish with `--styles-only` (step
  1c) — it's faster and skips downloading assets/DOM you don't need.

There's no live browser a human is pointing at here (unlike the old extension's click-to-pick
UI) — you resolve "that element" by cross-referencing `elements.json` (a selector inventory) and
the full-page screenshot against what the user described, THEN run a scoped capture with the
resolved selector. Never invent a selector without checking it exists on the page first — a wrong
guess either captures the wrong thing silently or fails outright.

### 1a. Whole-page capture

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
- Then skip to step 2.

### 1b. Find the right element first (required before any scoped capture)

```
node .cursor/skills/clone-page/scripts/capture.mjs "<url>" clone-capture/<slug> --list-elements
```

This writes `clone-capture/<slug>/elements.json` — a flat list of clickable/notable elements
(`button`, `a`, `input`, headings, `img`, `svg`, `nav`/`header`/`footer`/`section`, anything with a
`btn`/`button`/`card`-like class, `[role]`, `[onclick]`), each with a stable CSS `selector`, `tag`,
visible `text`, `classes`, and `rect` (position/size). It also writes
`screenshots/full-page.png` for visual context.

Match the user's description against this list using text content, tag, classes, and position
(cross-check against the screenshot if there's ambiguity — e.g. two elements with similar text at
different `rect.y`). Pick the single best `selector`. If nothing plausible matches, say so instead
of guessing — the site may render that element only after an interaction (hover/click) this
headless pass didn't trigger, which is out of scope (see limitations).

### 1c. Scoped capture with the resolved selector

Full element capture (DOM subtree + its assets + a cropped `screenshots/element.png`):

```
node .cursor/skills/clone-page/scripts/capture.mjs "<url>" clone-capture/<slug> --selector="<selector>"
```

Style-only (fast path — just that element's computed styles + `::before`/`::after`, no DOM tree,
no asset downloads, writes `element-styles.json` instead of the full file set):

```
node .cursor/skills/clone-page/scripts/capture.mjs "<url>" clone-capture/<slug> --selector="<selector>" --styles-only
```

- If the script exits with `selector_not_found`, the picked selector doesn't match anything —
  re-check `elements.json` (the page may have changed, or the element only appears after scroll/
  interaction) rather than retrying the same selector.
- `--selector` and `--styles-only` both reuse the same `<slug>` folder as `--list-elements` was
  run in — outputs land alongside `elements.json`, they don't overwrite it.

## 2. Read what was captured

**If you ran `--styles-only` (step 1c):** everything you need is in
`clone-capture/<slug>/element-styles.json` — `selector`, `tag`, `rect`, the computed `styles`
object, `pseudos` (`::before`/`::after`), and `textContent`. That's the whole answer for a "qual o
estilo desse elemento" / "pega a cor desse botão" request — skip the rest of this section and go
straight to applying those exact values wherever the user wants them (a CSS rule, a Tailwind
class, a design-token file). Don't invent additional structure or assets for a styles-only ask.

**Otherwise** (whole-page or scoped-element capture), read, in this order, from the output folder
(`clone-capture/<slug>/`):

1. `capture-manifest.json` — run metadata, `scopedSelector` (null for whole-page captures),
   `recording` (path to the screen recording when one was made — null otherwise), and the honest
   **knownLimitations** list. Always carry these into your final report to the user; don't imply
   higher fidelity than what was captured.
2. `layout.json`, `frameworks.json`, `typography.json`, `colors.json` — page-level facts that
   steer the reconstruction (detected stack, fonts, palette, viewport). Still page-wide even for a
   scoped capture — useful shared context (tokens, detected framework) for the one element too.
3. `screenshots/full-page.png` and the `screenshots/checkpoint-*.png` files for whole-page
   context; `screenshots/element.png` (scoped captures only) is the tight crop of just the picked
   element — use it as the visual ground truth for that element specifically.
   `recording/session.webm` (when present — see `capture-manifest.json`'s `recording` field) is a
   real screen recording of the scroll-through session, the "grava vídeo da página" feature; use it
   the same way you'd use the screenshots, as extra visual ground truth (e.g. to see scroll-triggered
   animations play out), not as something to embed in the reconstructed output.
4. `dom.json` — the structural source of truth (tag, attrs, computed `styles`, `rect`, children,
   text nodes, `::before`/`::after` as `pseudos`). For a scoped capture this is rooted at the
   picked element, not `<body>` — don't reconstruct the whole page when the user only asked for
   one component. Nodes with `omitted: true` mean the DOM budget was hit — call this out if it
   affects a part that matters. **`rect.x`/`rect.y` are page-absolute** (viewport position plus
   scroll offset), the same coordinate space for every node no matter how deeply nested — see the
   positioning guidance in step 4 before using them for CSS `top`/`left`.
5. `css.json` — keyframes, custom properties (CSS variables), media query breakpoints, and every
   readable CSS rule (page-wide, not scoped — use it to resolve variables/keyframes the element's
   styles reference). `inaccessibleSheets` lists cross-origin stylesheets that couldn't be read.
6. `assets-manifest.json` — maps every original asset URL to its local path under
   `clone-capture/<slug>/assets/<hash>.<ext>` (or a `status` explaining why it wasn't downloaded:
   `too_large`, `http_error`, `failed`, `skipped_budget`). For a scoped capture this only covers
   assets referenced by that element's subtree. **Always use the local path when one exists —
   never hotlink the original site's URLs in the output.**

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

**Capturing is not the deliverable.** A run that ends with "here's `clone-capture/<slug>/` and
here are the limitations" without any actual HTML/CSS/component code is an unfinished job, not a
cautious one — the whole point of this skill is producing working code the user can look at
immediately, informed by the captured data. Always finish this step before reporting back.

**Don't try to reconstruct a whole complex page in a single pass.** A real homepage can have
thousands of DOM nodes in `dom.json` — attempting to translate all of it into markup in one shot
is exactly what produces the "faltou coisas" result (silently dropped sections, wrong sizes,
approximated instead of faithful). Instead:
1. Run `--list-elements` and look at `screenshots/full-page.png` to identify the page's top-level
   sections (hero, nav, feature grid, footer, etc. — usually `header`/`nav`/`section`/`footer` or
   large direct children of `<body>`/`<main>`).
2. Reconstruct ONE section at a time: run a scoped `--selector` capture for that section (step 1c),
   build it, visually check it against that section's `screenshots/element.png`, THEN move to the
   next section. This mirrors how the original extension's human operator worked section-by-section
   with the picker — you're doing the same thing, just driven by `--list-elements` instead of a
   click.
3. Only skip straight to a single whole-page capture (step 1a) for genuinely simple/short pages
   where one pass is realistic — use judgment based on `elements.json`'s size and the screenshot.

**Get every image's on-page size right — this is the #1 cause of "veio pequeno".** Downloading the
asset file is not enough: an `<img>` with no explicit size renders at the file's intrinsic
resolution, which is often smaller (or a completely different aspect ratio) than how it's
displayed on the original site. For every image node in `dom.json`, explicitly set the rendered
box to that node's `rect.w` / `rect.h` (via width/height attributes, CSS width/height, or the
framework's Image component sizing) and match `styles.objectFit` / `styles.objectPosition` when
present — never let the browser fall back to the downloaded file's native size.

**Never flatten separate image layers into one — this is the #1 cause of "imagem grudada".** A
container can have BOTH a CSS `background-image` (on `node.styles.backgroundImage`) AND its own
`<img>` child or sibling (a separate node with its own `node.imageUrl` and `rect`) — these are two
independent layers in the original page (e.g. a section background photo plus a featured/foreground
image floating on top of it), captured as two structurally distinct things. When you see this,
reconstruct BOTH: the background stays a `background-image`/`background-position`/`background-size`
CSS property on its own element, and the foreground image stays a real, separately-positioned
`<img>` (or `next/image`, etc.) using its own asset path from `assets-manifest.json` — do not merge
them into a single flattened image or drop one in favor of the other because they visually overlap
in the screenshot.

**`dom.json`'s `rect.x`/`rect.y` are PAGE-ABSOLUTE coordinates, not parent-relative.** They're
`element.getBoundingClientRect()` plus scroll offset — i.e. the position on the whole page, the same
frame of reference for every node regardless of nesting. Do not copy `rect.x`/`rect.y` directly into
a child's CSS `top`/`left` — for a `position: absolute`/`fixed`/`sticky` element (e.g. that
overlaid foreground image), first check `node.styles.position`, then compute its offset RELATIVE TO
ITS POSITIONED PARENT (parent's `rect.x`/`rect.y` subtracted from the child's), and give the parent
`position: relative` if it doesn't already have positioning. For normally-flowed content (the common
case), don't use absolute positioning from `rect` at all — reproduce it via normal document flow /
flexbox / grid order instead, which is what keeps layered sections from collapsing into each other.

**Never dump literal `width`/`height` onto auto-sized content elements (buttons, pills, tags,
badges, nav links) — this is what causes "botão cortado" / text clipped or overlapping its
label.** For a button/link/badge whose size comes from padding + text rather than a deliberately
fixed box (the common case for CTAs), `node.styles.width`/`node.styles.height` in `dom.json` are
the CSS **content-box** size at capture time under the browser's default `box-sizing:
content-box` — NOT the element's rendered/visual size. `node.rect.w`/`node.rect.h` (from
`getBoundingClientRect()`) is always the true visual size, padding and border included. Applying
`styles.width`/`styles.height` literally as CSS `width`/`height` while also applying `padding`
double-subtracts the padding and renders a box smaller than the real button, clipping the label.
Fix:
1. For text-driven components (buttons, pills, tags, chips — heuristic: has text content, has
   padding, tag is `a`/`button`/`span`/`label`/`div[role=button]`), don't set explicit
   `width`/`height` at all. Apply `padding`, `font-size`, `font-family`, `line-height`,
   `border-radius`, etc. from `node.styles` and let the box size itself from content — this is how
   the original almost always achieves that size too.
2. If a node genuinely needs an explicit size (fixed-dimension containers, avatars, image
   wrappers), use `node.rect.w`/`node.rect.h`, not `node.styles.width`/`node.styles.height`, and
   set `box-sizing: border-box` on the rule so padding isn't added on top again.
3. `node.styles.boxSizing` is captured — when it's `content-box` (the default), `styles.width`/
   `styles.height` genuinely exclude padding/border; don't treat them as interchangeable with
   `rect.w`/`rect.h`.

**Interactive components (carousels, tabs, accordions) need real behavior, not just whichever
state was active at capture time.** The capture is one static DOM snapshot — it never clicks,
hovers, or advances a slide — so a gallery's dots/slides/tabs all land in `dom.json` as inert
markup, with only the item that was current/active at capture time actually visible; the site's
own JS driving transitions (autoplay timers, dot↔slide sync) isn't extracted (see
`capture-manifest.json`'s `knownLimitations`), which is why dots/arrows look "dead" if rendered
as-is. When `dom.json`/`elements.json` shows this pattern — repeated sibling "slide" nodes plus a
parallel row of dot/tab/indicator controls (look for classes/attrs like `slide`, `dot`,
`indicator`, `tab`, `carousel`, `gallery`, `active`/`current`/`is-active`, `aria-selected`,
`role="tablist"`/`role="tab"`) — don't ship it as static markup:
1. Identify which item was active/current at capture time (the node carrying the
   `active`/`current`/`aria-selected="true"`-type class or attribute) and keep it as the initial
   visible state.
2. Write minimal interaction code (vanilla JS, or the framework's native state — e.g. React
   `useState`) that wires each dot/tab click to show the matching slide and update the active
   class/`aria-selected` on the controls. A plain "click a dot → set active index → toggle
   classes" implementation is enough — you're building a working equivalent, not extracting the
   original bundle.
3. Say so plainly in your summary: autoplay timing, transition easing/animation, and any original
   JS behavior beyond click-to-switch are not reproduced — flag it like any other
   `knownLimitations` item instead of implying exact parity.

- For a scoped capture (`--selector` was used), only create/edit the one component the user
  asked about — don't rebuild the surrounding page just because page-level `css.json`/
  `colors.json` were also read for context.
- Walk `dom.json` and emit matching markup/JSX, preserving element order, text content, and
  structure (including mixed text/element children).
- Translate each node's `styles` object into the target styling approach (CSS rules, Tailwind
  classes, or styled-components) using the literal captured values — don't round or guess, EXCEPT
  for `width`/`height` on auto-sized content elements per the callout above.
- Wire up colors/typography from `colors.json` / `typography.json` as shared tokens
  (CSS variables, Tailwind theme extension, or a constants file) when the project has a place for
  them; otherwise inline them.
- Reproduce `@keyframes` / `animation` / `transition` from `css.json` where a node's styles
  reference them.
- Render `::before`/`::after` pseudo-content (`node.pseudos`) as real pseudo-element CSS, not as
  extra DOM nodes.
- Point every `src`/`href`/`background-image`/`font-face url()` at the local path from
  `assets-manifest.json`. If an asset's status isn't `ok`, keep the original remote URL as a
  fallback and flag it in your summary instead of silently breaking the layout. `assets-manifest.json`
  entries are tagged with `kind` (`image`/`font`/`video`) — public `<video>` files and their
  posters download like any other asset now, so embed the local video file, not the original URL.
- Inline SVGs (`dom.json` nodes with `svgContent`) should be embedded as real inline SVG, not
  screenshotted.

## 5. Verify before declaring done

- Run/build the project (or open the generated static file) and take a screenshot or visually
  compare it against `screenshots/full-page.png` (or `screenshots/element.png` for a scoped
  capture). Note real differences instead of assuming a pixel-perfect match.
- Check that every background-image + foreground-image pair you saw overlapping in the screenshot
  actually rendered as two distinct layers in the output, not one merged/missing image — this is
  the most common visual regression from this workflow.
- Check every button/pill/tag's text isn't clipped or overlapping its own background — if it is,
  you likely applied a literal `styles.width`/`styles.height` where the element should have been
  left to size itself from padding + content (see step 4).
- If the page had a carousel/tabs/accordion, click through it in the running result and confirm
  dots/tabs actually switch slides — a set of dots that doesn't respond to clicks means the
  interaction wiring from step 4 was skipped.
- Summarize for the user: what was captured and reconstructed faithfully, and what's listed under
  `capture-manifest.json`'s `knownLimitations` (canvas/WebGL, DRM/auth video, cross-origin CSS,
  closed shadow roots, budget-omitted nodes) so expectations stay honest.

## 6. Cleanup

- `clone-capture/` holds raw capture data (JSON + downloaded assets + screenshots), not the final
  deliverable. Suggest adding it to `.gitignore` unless the user wants to keep it as a reference
  snapshot. The reconstructed code itself (step 4's output) is what should be committed.
