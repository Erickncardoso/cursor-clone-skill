// browser-capture.mjs
//
// Runs INSIDE the target page (injected via Playwright's `page.evaluate`).
// Must stay a single, fully self-contained function with ZERO references to
// Node.js scope, imports, or anything from capture.mjs — Playwright ships it
// to the browser with `Function.prototype.toString()` and re-evaluates it
// there, so any outer-scope reference will throw at runtime.
//
// This is a direct adaptation of VibeCloner's content.js capture routines
// (captureElement / captureCSS / captureAssets / captureLayout /
// captureTypography / detectFrameworks / extractColorPalette /
// capturePseudoElements), trimmed of extension-only concerns: no
// chrome.* messaging, no section picker UI, no interaction recorder, no
// video/HLS/DASH interception (that needs a network proxy, not page JS).
// Canvas/WebGL are still best-effort snapshots only, same limitation the
// original extension documents.

export function captureInBrowser(opts) {
  const { selector = null, stylesOnly = false } = opts || {};
  const CRITICAL_STYLES = [
    'display', 'position', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent',
    'gridTemplateColumns', 'gridTemplateRows', 'gridColumn', 'gridRow', 'gap', 'columnGap', 'rowGap',
    'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
    'color', 'textTransform', 'textDecoration', 'whiteSpace',
    'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
    'backgroundRepeat', 'backgroundAttachment', 'backgroundClip',
    'borderRadius', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
    'boxShadow', 'outline', 'outlineOffset',
    'opacity', 'transform', 'transformOrigin', 'transition', 'animation', 'animationName',
    'overflow', 'overflowX', 'overflowY', 'zIndex', 'top', 'left', 'right', 'bottom',
    'objectFit', 'objectPosition', 'cursor', 'pointerEvents', 'userSelect',
    'backdropFilter', 'filter', 'mixBlendMode', 'isolation',
    'aspectRatio', 'content', 'visibility', 'clipPath', 'mask',
  ];
  const SKIP_TAGS = new Set(['script', 'noscript', 'style', 'head', 'meta', 'link', 'base', 'title']);
  const SKIP_VALUES = new Set([
    'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'transparent', 'visible',
    'static', 'inline', 'start', 'nowrap', 'separate', 'scroll', 'clip', 'flat', 'ease', '1', '0',
  ]);

  function absUrl(url) {
    if (!url) return null;
    try { return new URL(url, location.href).href; } catch { return url; }
  }

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const cls = [...el.classList].slice(0, 2).map(c => '.' + c).join('');
    return el.tagName.toLowerCase() + cls;
  }

  function scopedList(root, selector) {
    if (root === document) return [...document.querySelectorAll(selector)];
    const list = [...root.querySelectorAll(selector)];
    try { if (root.matches?.(selector)) list.unshift(root); } catch {}
    return list;
  }

  function scopedMatches(root, selectorText) {
    if (root === document) return true;
    try { if (root.matches?.(selectorText)) return true; } catch {}
    try { return !!root.querySelector(selectorText); } catch { return false; }
  }

  function detectFrameworks() {
    const fw = {
      gsap: false, scrollTrigger: false, framerMotion: false, lottie: false, threeJs: false,
      animejs: false, motionOne: false, lenis: false, locomotiveScroll: false,
      react: false, nextjs: false, vue: false, svelte: false, tailwind: false,
      styledComponents: false, emotion: false,
    };
    if (window.gsap) fw.gsap = window.gsap.version || true;
    if (window.ScrollTrigger || window.gsap?.ScrollTrigger) fw.scrollTrigger = true;
    if (document.querySelector('[data-framer-component-type]') ||
        document.querySelector('[class*="framer-"]') ||
        document.querySelector('[data-projection-id]') ||
        window.FramerMotion) fw.framerMotion = true;
    if (window.lottie || window.LottiePlayer) fw.lottie = true;
    if (window.THREE) fw.threeJs = window.THREE.REVISION || true;
    if (window.anime) fw.animejs = true;
    if (window.Motion) fw.motionOne = true;
    if (window.Lenis || document.documentElement.dataset.lenis !== undefined ||
        document.querySelector('[data-lenis-prevent]')) fw.lenis = true;
    if (window.LocomotiveScroll || document.querySelector('[data-scroll-container]') ||
        document.querySelector('[data-scroll]')) fw.locomotiveScroll = true;
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || window.React ||
        document.querySelector('[data-reactroot]') ||
        document.querySelector('[data-reactid]')) fw.react = true;
    if (window.__NEXT_DATA__ || document.getElementById('__NEXT_DATA__') ||
        document.querySelector('#__next')) fw.nextjs = true;
    if (window.Vue || window.__VUE__ || document.querySelector('[data-v-app]')) fw.vue = true;
    if (document.querySelector('[class^="svelte-"]')) fw.svelte = true;
    const hasTailwind = Array.from(document.querySelectorAll('[class]')).some(el =>
      /\b(flex|grid|px-|py-|text-|bg-|rounded|font-|w-|h-|gap-|items-|justify-)/.test(el.className));
    if (hasTailwind) fw.tailwind = true;
    if (document.querySelector('[class*="sc-"]') || document.querySelector('style[data-styled]')) fw.styledComponents = true;
    if (document.querySelector('[class*="css-"]') || document.querySelector('style[data-emotion]')) fw.emotion = true;
    return fw;
  }

  function captureCSS() {
    const keyframes = [];
    const customProperties = {};
    const allRules = [];
    const mediaQueries = [];
    const fontFaces = [];
    const breakpoints = new Set();

    try {
      const rootStyle = getComputedStyle(document.documentElement);
      for (const prop of rootStyle) {
        if (prop.startsWith('--')) customProperties[prop] = rootStyle.getPropertyValue(prop).trim();
      }
    } catch {}

    const processSheet = (sheet) => {
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (!rules) return;
        for (const rule of rules) {
          if (rule instanceof CSSKeyframesRule || rule.type === 9) {
            const frames = [];
            for (const kf of rule.cssRules) frames.push({ keyText: kf.keyText, css: kf.cssText });
            keyframes.push({ name: rule.name, frames });
          } else if (rule instanceof CSSMediaRule) {
            const cond = rule.conditionText || '';
            const bpMatch = cond.match(/\d+px/g);
            if (bpMatch) bpMatch.forEach(bp => breakpoints.add(bp));
            mediaQueries.push({ condition: cond, cssText: rule.cssText });
            processSheet({ cssRules: rule.cssRules });
          } else if (rule instanceof CSSFontFaceRule) {
            fontFaces.push({ cssText: rule.cssText });
            allRules.push({ type: 'font-face', cssText: rule.cssText });
          } else if (rule.selectorText) {
            allRules.push({ type: 'rule', selector: rule.selectorText, cssText: rule.cssText });
          } else if (rule.cssRules) {
            processSheet({ cssRules: rule.cssRules }); // @supports, @container, @layer
          }
        }
      } catch {
        // Cross-origin sheet: cssRules throws. Recorded as a limitation, never
        // silently pretended to be empty.
      }
    };

    const inaccessibleSheets = [];
    for (const sheet of document.styleSheets) {
      try {
        if (!sheet.cssRules) inaccessibleSheets.push(sheet.href || '(inline)');
      } catch { inaccessibleSheets.push(sheet.href || '(inline)'); }
      processSheet(sheet);
    }

    return {
      keyframes, customProperties, allRules, mediaQueries, fontFaces,
      breakpoints: [...breakpoints].sort((a, b) => parseInt(a) - parseInt(b)),
      inaccessibleSheets,
    };
  }

  function capturePseudoElements() {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (!rule.selectorText) continue;
          for (const pseudo of ['::before', '::after']) {
            if (rule.selectorText.includes(pseudo)) {
              results.push({
                selector: rule.selectorText, pseudo,
                content: rule.style?.content || '', cssText: rule.cssText,
              });
            }
          }
        }
      } catch {}
    }
    return results;
  }

  function extractColorPalette() {
    const colorMap = {};
    const colorProps = ['color', 'backgroundColor', 'borderColor', 'fill', 'stroke'];
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      for (const prop of colorProps) {
        const val = cs[prop];
        if (val && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent' && val !== 'none') {
          colorMap[val] = (colorMap[val] || 0) + 1;
        }
      }
    });
    return Object.entries(colorMap).sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([color, count]) => ({ color, count }));
  }

  function captureElement(el, budget) {
    if (performance.now() > budget.deadline || budget.nodes >= budget.maxNodes || budget.bytes >= budget.maxBytes) {
      budget.omitted++;
      return { omitted: true, reason: 'budget_exceeded' };
    }
    if (el.nodeType === Node.TEXT_NODE) {
      const text = el.textContent || '';
      if (!text.trim()) return null;
      budget.bytes += text.length;
      return { nodeType: 'text', text };
    }
    if (el.nodeType === Node.COMMENT_NODE) return null;
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    budget.nodes++;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    const computed = getComputedStyle(el);
    if (computed.display !== 'contents' &&
        typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return null;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1 && computed.position === 'absolute' &&
        (computed.overflow === 'hidden' ||
         /rect\(\s*0(px)?\s*,?\s*0(px)?\s*,?\s*0(px)?\s*,?\s*0(px)?\s*\)/.test(computed.clip || '') ||
         /inset\(\s*(50|100)%/.test(computed.clipPath || ''))) {
      return null; // sr-only / visually-hidden pattern
    }

    const node = {
      tag, id: el.id || null,
      classes: [...el.classList].join(' ') || null,
      attrs: {}, styles: {},
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
      children: [],
    };

    for (const attr of el.attributes) {
      const isUrl = /^(src|href|poster|action|formaction|data-src|data-bg)$/i.test(attr.name);
      node.attrs[attr.name] = isUrl ? absUrl(attr.value) : attr.value;
      budget.bytes += attr.name.length + attr.value.length;
    }

    for (const prop of CRITICAL_STYLES) {
      const val = computed[prop];
      if (val && !SKIP_VALUES.has(val)) node.styles[prop] = val;
    }
    for (const prop of ['overflow', 'overflowX', 'overflowY']) {
      if (computed[prop] && computed[prop] !== 'visible') node.styles[prop] = computed[prop];
    }

    if (tag === 'img') {
      node.imageUrl = absUrl(el.currentSrc || el.src || node.attrs.src) || null;
      node.imageAlt = node.attrs.alt || '';
      node.srcset = node.attrs.srcset || null;
      node.naturalWidth = el.naturalWidth || null;
      node.naturalHeight = el.naturalHeight || null;
    }
    if (tag === 'video') {
      node.src = absUrl(el.src || el.currentSrc);
      node.poster = el.poster ? absUrl(el.poster) : null;
      node.autoplay = el.autoplay; node.loop = el.loop; node.muted = el.muted;
    }
    if (['input', 'textarea', 'select', 'option'].includes(tag)) {
      node.formState = {
        value: el.type === 'password' ? '[REDACTED]' : el.value,
        checked: !!el.checked, disabled: !!el.disabled,
      };
    }
    if (tag === 'svg') { node.svgContent = el.outerHTML; node.viewBox = el.getAttribute('viewBox'); }
    if (tag === 'canvas') {
      node.isCanvas = true;
      try { node.snapshot = el.toDataURL('image/jpeg', 0.6); } catch { node.snapshot = null; }
    }

    for (const which of ['::before', '::after']) {
      try {
        const ps = getComputedStyle(el, which);
        if (!ps || ps.content === 'none' || ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) === 0) continue;
        const pw = parseFloat(ps.width), ph = parseFloat(ps.height);
        const bg = ps.backgroundColor, bgImg = ps.backgroundImage;
        const hasPaint = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || (bgImg && bgImg !== 'none');
        const textContent = /^"(.+)"$/.test(ps.content) ? ps.content.slice(1, -1) : '';
        if (!hasPaint && !textContent) continue;
        if (hasPaint && (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0)) continue;
        (node.pseudos = node.pseudos || []).push({
          which, w: Number.isFinite(pw) ? Math.round(pw) : null, h: Number.isFinite(ph) ? Math.round(ph) : null,
          backgroundColor: bg !== 'rgba(0, 0, 0, 0)' ? bg : null,
          backgroundImage: bgImg !== 'none' ? bgImg : null,
          borderRadius: ps.borderRadius !== '0px' ? ps.borderRadius : null,
          opacity: parseFloat(ps.opacity), color: ps.color, fontSize: ps.fontSize, text: textContent || null,
        });
      } catch {}
    }

    if (el.shadowRoot && el.shadowRoot.mode === 'open') {
      node.shadowDOM = {
        mode: 'open',
        children: [...el.shadowRoot.childNodes].map(child => captureElement(child, budget)).filter(Boolean),
      };
    }

    for (const child of el.childNodes) {
      const childNode = captureElement(child, budget);
      if (childNode) node.children.push(childNode);
    }

    return node;
  }

  function captureAssets(root = document) {
    const assets = { fonts: [], images: [], svgs: [], videos: [], canvases: [] };
    const imageUrls = new Set();

    try {
      if (document.fonts) {
        document.fonts.forEach(font => {
          assets.fonts.push({ family: font.family, weight: font.weight, style: font.style, status: font.status, source: 'FontFaceSet' });
        });
      }
    } catch {}

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule instanceof CSSFontFaceRule) {
            const src = rule.style.getPropertyValue('src');
            const urls = (src.match(/url\(['"]?([^'")\s]+)['"]?\)/g) || []).map(u => {
              const m = u.match(/url\(['"]?([^'")\s]+)['"]?\)/);
              return m ? absUrl(m[1]) : null;
            }).filter(Boolean);
            assets.fonts.push({
              family: rule.style.getPropertyValue('font-family').replace(/['"]/g, ''),
              weight: rule.style.getPropertyValue('font-weight'),
              style: rule.style.getPropertyValue('font-style'),
              urls, source: 'font-face',
            });
          }
        }
      } catch {}
    }

    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const href = link.href || '';
      if (href.includes('fonts.googleapis.com') || href.includes('fonts.adobe.com') || href.includes('use.typekit.net')) {
        assets.fonts.push({ type: 'external-link', url: href });
      }
    });

    scopedList(root, 'img').forEach(img => {
      const rect = img.getBoundingClientRect();
      const urls = [img.currentSrc, img.src, img.dataset.src, img.dataset.bg].map(absUrl).filter(Boolean);
      for (const [index, url] of [...new Set(urls)].entries()) {
        if (imageUrls.has(url)) continue;
        imageUrls.add(url);
        assets.images.push({
          url, alt: img.alt || '', width: Math.round(rect.width), height: Math.round(rect.height),
          naturalWidth: img.naturalWidth || null, naturalHeight: img.naturalHeight || null,
          type: index === 0 ? 'img-current-src' : 'img-fallback',
        });
      }
    });

    root.querySelectorAll('picture source').forEach(src => {
      const srcset = src.srcset;
      if (srcset) {
        srcset.split(',').forEach(part => {
          const url = absUrl(part.trim().split(/\s+/)[0]);
          if (url && !imageUrls.has(url)) { imageUrls.add(url); assets.images.push({ url, type: 'picture-source' }); }
        });
      }
    });

    scopedList(root, '[style*="background"]').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (m && !m[1].startsWith('data:')) {
          const url = absUrl(m[1]);
          if (!imageUrls.has(url)) { imageUrls.add(url); assets.images.push({ url, type: 'background', element: getSelector(el) }); }
        }
      }
    });

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          const bg = rule.style?.backgroundImage || '';
          if (bg && bg !== 'none') {
            if (!scopedMatches(root, rule.selectorText)) continue;
            const matches = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/g) || [];
            matches.forEach(u => {
              const match = u.match(/url\(['"]?([^'")\s]+)['"]?\)/);
              if (match && !match[1].startsWith('data:')) {
                const url = absUrl(match[1]);
                if (!imageUrls.has(url)) { imageUrls.add(url); assets.images.push({ url, type: 'css-background', selector: rule.selectorText }); }
              }
            });
          }
        }
      } catch {}
    }

    scopedList(root, 'svg').forEach((svg, i) => {
      const rect = svg.getBoundingClientRect();
      assets.svgs.push({
        index: i, width: Math.round(rect.width), height: Math.round(rect.height),
        content: svg.outerHTML, viewBox: svg.getAttribute('viewBox'),
        id: svg.id || null, classes: [...svg.classList].join(' ') || null,
      });
    });

    scopedList(root, 'video, video source').forEach(v => {
      const src = absUrl(v.src || v.currentSrc || v.getAttribute('src') || '');
      if (src) {
        assets.videos.push({
          src, poster: v.poster ? absUrl(v.poster) : null,
          autoplay: !!v.autoplay, loop: !!v.loop, muted: !!v.muted, tag: v.tagName.toLowerCase(),
        });
      }
    });

    scopedList(root, 'canvas').forEach((c, i) => {
      const rect = c.getBoundingClientRect();
      let snapshot = null;
      try { snapshot = c.toDataURL('image/jpeg', 0.7); } catch {}
      assets.canvases.push({ index: i, width: Math.round(rect.width), height: Math.round(rect.height), snapshot });
    });

    return assets;
  }

  function captureLayout() {
    const body = document.body, html = document.documentElement;
    const bodyCS = getComputedStyle(body), htmlCS = getComputedStyle(html);
    let maxContainer = null;
    for (const el of document.querySelectorAll('div, section, main, article')) {
      const cs = getComputedStyle(el);
      if (cs.maxWidth && cs.maxWidth !== 'none' && cs.maxWidth !== '100%') {
        maxContainer = { selector: getSelector(el), maxWidth: cs.maxWidth };
        break;
      }
    }
    return {
      url: location.href, title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageSize: { width: Math.max(body.scrollWidth, html.scrollWidth), height: Math.max(body.scrollHeight, html.scrollHeight) },
      devicePixelRatio: window.devicePixelRatio,
      bodyBg: bodyCS.backgroundColor, htmlBg: htmlCS.backgroundColor, bodyFont: bodyCS.fontFamily,
      maxContainer,
      metaDescription: document.querySelector('meta[name="description"]')?.content || '',
      ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
      lang: html.lang || 'en',
      favicon: document.querySelector('link[rel="icon"],link[rel="shortcut icon"]')?.href || '',
      charset: document.characterSet || 'UTF-8',
    };
  }

  function captureTypography() {
    const families = {}, headings = {};
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const el = document.querySelector(tag);
      if (el) {
        const cs = getComputedStyle(el);
        headings[tag] = { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, fontFamily: cs.fontFamily, color: cs.color };
      }
    }
    const bodyEl = document.querySelector('p, [class*="body"], [class*="text"]');
    const bodyCS = bodyEl ? getComputedStyle(bodyEl) : getComputedStyle(document.body);
    const bodyType = { fontSize: bodyCS.fontSize, fontWeight: bodyCS.fontWeight, lineHeight: bodyCS.lineHeight, fontFamily: bodyCS.fontFamily, color: bodyCS.color };
    document.querySelectorAll('*').forEach(el => {
      const ff = getComputedStyle(el).fontFamily;
      if (ff) families[ff] = (families[ff] || 0) + 1;
    });
    const topFamilies = Object.entries(families).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f);
    return { headings, body: bodyType, topFamilies };
  }

  // Resolve the capture root: the whole page (default) or a single picked
  // element + its subtree, when the caller wants just one component/button/
  // card instead of the entire page.
  let root = document.body;
  if (selector) {
    root = document.querySelector(selector);
    if (!root) {
      throw new Error(`selector_not_found: no element matches "${selector}". Run --list-elements first to get a selector that actually exists on this page.`);
    }
  }

  // "Just the style of this element" — skip DOM tree/assets/CSS entirely and
  // return only what a targeted style tweak needs. Much faster than a full
  // capture, and the obviously-correct shape for "pega só o estilo desse
  // botão" style requests.
  if (stylesOnly) {
    const computed = getComputedStyle(root);
    const rect = root.getBoundingClientRect();
    const styles = {};
    for (const prop of CRITICAL_STYLES) {
      const val = computed[prop];
      if (val && !SKIP_VALUES.has(val)) styles[prop] = val;
    }
    for (const prop of ['overflow', 'overflowX', 'overflowY']) {
      if (computed[prop] && computed[prop] !== 'visible') styles[prop] = computed[prop];
    }
    const pseudos = {};
    for (const which of ['::before', '::after']) {
      try {
        const ps = getComputedStyle(root, which);
        if (ps && ps.content !== 'none') {
          pseudos[which] = { content: ps.content, backgroundColor: ps.backgroundColor, backgroundImage: ps.backgroundImage, width: ps.width, height: ps.height };
        }
      } catch {}
    }
    return {
      selector,
      tag: root.tagName.toLowerCase(),
      id: root.id || null,
      classes: [...root.classList].join(' ') || null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      styles,
      pseudos,
      textContent: (root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
    };
  }

  const budget = { deadline: performance.now() + 20000, nodes: 0, maxNodes: 40000, bytes: 0, maxBytes: 15_000_000, omitted: 0 };

  return {
    scopedSelector: selector,
    frameworks: detectFrameworks(),
    css: captureCSS(),
    pseudoElements: capturePseudoElements(),
    colors: extractColorPalette(),
    layout: captureLayout(),
    typography: captureTypography(),
    assets: captureAssets(root),
    dom: captureElement(root, budget),
    domBudget: { nodesVisited: budget.nodes, omittedSubtrees: budget.omitted, approxBytes: budget.bytes },
  };
}

// listElementsInBrowser — runs INSIDE the page, same rules as captureInBrowser
// above (self-contained, no outer-scope references). Produces a flat
// inventory of clickable/notable elements with a stable CSS selector for
// each, so the agent can match a natural-language description ("o botão de
// login", "aquele card verde") to a real element BEFORE running a scoped
// capture with --selector. This is the headless equivalent of the original
// extension's click-to-pick UI — since there's no human clicking a live
// page here, the agent picks from this list (cross-referenced with the
// full-page screenshot) instead.
export function listElementsInBrowser() {
  function buildRobustSelector(el) {
    if (!(el instanceof Element)) return null;
    if (el === document.body) return 'body';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); node = null; break; }
      const parent = node.parentElement;
      let part = node.tagName.toLowerCase();
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    if (parts[0] && !parts[0].startsWith('#')) parts.unshift('body');
    return parts.join(' > ') || 'body';
  }

  const CANDIDATE_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea', '[role]',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'svg',
    'header', 'nav', 'footer', 'section', 'main', 'form',
    '[class*="btn"]', '[class*="button"]', '[class*="card"]', '[onclick]',
  ].join(', ');

  const seen = new Set();
  const results = [];
  document.querySelectorAll(CANDIDATE_SELECTOR).forEach(el => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const selector = buildRobustSelector(el);
    if (!selector || seen.has(selector)) return;
    seen.add(selector);
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
    results.push({
      selector,
      tag: el.tagName.toLowerCase(),
      text,
      id: el.id || null,
      classes: [...el.classList].slice(0, 4).join(' ') || null,
      role: el.getAttribute('role') || null,
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
    });
  });
  return results.slice(0, 400);
}
