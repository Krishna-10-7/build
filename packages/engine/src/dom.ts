/**
 * Runs inside the page. Kept as plain JavaScript in a string so the TypeScript
 * toolchain cannot inject helpers that do not exist in the browser.
 *
 * Exposes window.__sq with:
 *   fingerprint(el)  -> Fingerprint
 *   collect()        -> Candidate[] (every visible element worth targeting)
 */
export const DOM_SCRIPT = String.raw`
(() => {
  if (window.__sq) return;
  const LANDMARK_TAGS = new Set(['main', 'header', 'footer', 'nav', 'aside', 'section', 'article', 'form', 'dialog']);
  const LANDMARK_ROLES = new Set(['main', 'banner', 'contentinfo', 'navigation', 'complementary', 'region', 'form', 'dialog', 'search']);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'number') return 'spinbutton';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    return 'generic';
  }

  function labelText(el) {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    return wrap ? clean(wrap.textContent) : '';
  }

  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      return labelText(el) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));
    }
    if (tag === 'img') return clean(el.getAttribute('alt'));
    return clean(el.innerText || el.textContent) || clean(el.getAttribute('title'));
  }

  function isLandmark(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    return LANDMARK_TAGS.has(tag) || (role && LANDMARK_ROLES.has(role));
  }

  function container(el) {
    let n = el.parentElement;
    while (n && n !== document.body) {
      if (isLandmark(n)) return n;
      n = n.parentElement;
    }
    return document.body;
  }

  function near(el) {
    const label = labelText(el);
    if (label && !el.getAttribute('aria-label')) return label;
    // Inside a link or button (a badge in "Cart 3"): the parent's own words tell it apart.
    const host = el.parentElement && el.parentElement.closest('a, button, label');
    if (host) {
      const own = clean(el.textContent);
      const rest = clean(host.textContent).replace(own, '').trim();
      if (rest) return rest;
    }
    const box = container(el);
    const heading = box.querySelector('h1, h2, h3, h4, legend');
    if (heading && heading !== el) return clean(heading.textContent);
    return clean(box.getAttribute('aria-label'));
  }

  function landmarks(el) {
    const out = [];
    let n = el.parentElement;
    while (n && n !== document.body) {
      if (isLandmark(n)) out.unshift(n.getAttribute('role') || n.tagName.toLowerCase());
      n = n.parentElement;
    }
    return out;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  }

  function fingerprint(el) {
    const role = implicitRole(el);
    const box = container(el);
    const peers = Array.from(box.querySelectorAll('*')).filter((n) => implicitRole(n) === role && visible(n));
    return {
      role,
      name: accName(el),
      text: clean(el.innerText || el.textContent).slice(0, 80),
      near: near(el),
      landmarks: landmarks(el),
      testid: el.getAttribute('data-testid') || '',
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      type: el.getAttribute('type') || '',
      attrName: el.getAttribute('name') || '',
      href: el.getAttribute('href') || '',
      placeholder: el.getAttribute('placeholder') || '',
      index: Math.max(0, peers.indexOf(el)),
      siblings: peers.length,
      visible: visible(el),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    };
  }

  function cssPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body) {
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : tag);
      n = n.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }

  const TARGETS = 'a, button, input, select, textarea, [role], [data-testid], [id], h1, h2, h3, p, span, strong, li, label';

  function collect() {
    document.querySelectorAll('[data-sq-idx]').forEach((n) => n.removeAttribute('data-sq-idx'));
    const out = [];
    const els = Array.from(document.body.querySelectorAll(TARGETS)).filter(visible).slice(0, 600);
    els.forEach((el, i) => {
      el.setAttribute('data-sq-idx', String(i));
      out.push({ idx: i, fingerprint: fingerprint(el), css: cssPath(el) });
    });
    return out;
  }

  window.__sq = { fingerprint, collect, cssPath };
})();
`;
