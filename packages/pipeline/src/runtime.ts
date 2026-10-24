/**
 * Browser-side runtime injected into every mirrored page.
 *
 * Exported as a string (not a file) because Phase 2 streams it through HTMLRewriter
 * inside the Worker, where a filesystem read is not available.
 *
 * It does three things:
 *   1. No-ops the legacy analytics/ad globals that old pages call at load time.
 *   2. Swallows errors from dead third-party endpoints so the page looks intact
 *      instead of hanging for 30 s and spraying the console.
 *   3. Reports state to the host shell (toolbar) over postMessage, including a count
 *      of dead-request events for the "N blocked requests" badge.
 */

export const RUNTIME_SCRIPT = String.raw`
(function () {
  if (window.__cwRuntime) return;
  window.__cwRuntime = { dead: 0, errors: 0, ready: false };

  var report = function (type, detail) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __cw: true, type: type, detail: detail || null }, '*');
      }
    } catch (e) { /* parent blocked; nothing to do */ }
  };

  // ---- 1. Shim legacy globals so old inline code does not throw ----------
  var chain = function () {
    var proxy;
    var f = function () { return proxy; };
    proxy = new Proxy(f, {
      get: function (t, k) {
        if (k === 'then') return undefined;
        if (k === 'toString') return function () { return ''; };
        if (k === Symbol.toPrimitive) return function () { return ''; };
        return proxy;
      },
      apply: function () { return proxy; },
      set: function () { return true; }
    });
    return proxy;
  };
  var NAMES = ['dataLayer','ga','gaq','_gaq','gtag','fbq','_fbq','hj','_hjSettings','mixpanel',
               'amplitude','_paq','optimizely','utag','digitalData','adobeDataLayer','_satellite'];
  for (var i = 0; i < NAMES.length; i++) {
    var name = NAMES[i];
    try {
      if (!(name in window)) {
        if (name === 'dataLayer') window[name] = [];
        else if (name === '_hjSettings' || name === 'digitalData') window[name] = {};
        else window[name] = chain();
      }
    } catch (e) { /* frozen global; ignore */ }
  }

  // Sandboxed pages have an opaque origin, so browsers deny native Web Storage.
  // Keep the common localStorage/sessionStorage APIs available in memory so modern
  // site code can initialize without receiving a SecurityError. Nothing persists
  // between archived documents or escapes to the live site.
  var makeMemoryStorage = function () {
    var values = Object.create(null);
    return {
      get length() { return Object.keys(values).length; },
      key: function (index) { return Object.keys(values)[index] || null; },
      getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
      setItem: function (key, value) { values[String(key)] = String(value); },
      removeItem: function (key) { delete values[String(key)]; },
      clear: function () { values = Object.create(null); }
    };
  };
  var ensureStorage = function (name) {
    try {
      var existing = window[name];
      if (existing && typeof existing.getItem === 'function' && typeof existing.setItem === 'function') return;
    } catch (e) {}
    var storage = makeMemoryStorage();
    try { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return storage; } }); }
    catch (e) { try { window[name] = storage; } catch (ignored) {} }
  };
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');
  if (Array.isArray(window.dataLayer)) {
    var push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function () { try { return push.apply(null, arguments); } catch (e) { return 0; } };
  }

  // ---- 2. Dead-endpoint interceptor -------------------------------------
  var countDead = function (why) {
    window.__cwRuntime.dead += 1;
    report('cw:dead-request', { why: String(why || '').slice(0, 200), count: window.__cwRuntime.dead });
  };

  window.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'IMG' || t.tagName === 'LINK')) {
      countDead('asset:' + (t.tagName || '?') + ':' + (t.src || t.href || ''));
      return;
    }
    window.__cwRuntime.errors += 1;
    report('cw:error', { message: ev && ev.message ? String(ev.message).slice(0, 300) : 'error' });
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    window.__cwRuntime.errors += 1;
    report('cw:error', { message: 'unhandledrejection', reason: String((ev && ev.reason) || '').slice(0, 200) });
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  });

  var mirrorResourceUrl = function (raw, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET' && String(method || 'GET').toUpperCase() !== 'HEAD') return null;
    try {
      if (raw && typeof raw === 'object' && raw.url) raw = raw.url;
      if (raw instanceof URL) raw = raw.href;
      var meta = document.querySelector('meta[name="cw-mirror"]');
      if (!meta) return null;
      var mirror = JSON.parse(meta.getAttribute('content') || '{}');
      if (!mirror.resourceProxy || !/^\d{14}$/.test(mirror.ts || '') || !mirror.url) return null;

      var value = String(raw || '');
      if (value.indexOf('/_cw/resource') === 0) return null;
      var target = new URL(value, mirror.url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
      var appOrigin = new URL(location.href).origin;
      if (target.origin === appOrigin && (
        target.pathname.indexOf('/_cw/') === 0 ||
        target.pathname.indexOf('/a/') === 0 ||
        /^\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/i.test(target.pathname)
      )) return null;

      target.hash = '';
      var query = new URLSearchParams({ ts: mirror.ts, url: target.href });
      return '/_cw/resource?' + query.toString();
    } catch (e) { return null; }
  };

  // Modern sites commonly add code-split scripts, stylesheets and images after
  // their first paint. The server rewriter only sees the initial HTML, so rewrite
  // reflected URL attributes before a newly-created element is inserted into the
  // document and the browser starts its request.
  var nativeSetAttribute = Element.prototype.setAttribute;
  var mirrorCss = function (css) {
    var value = String(css || '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (whole, quote, raw) {
      var target = mirrorResourceUrl(raw, 'GET');
      return target ? 'url("' + target + '")' : whole;
    });
    return value.replace(/(@import\s+)(['"])([^'"]+)\2/gi, function (whole, prefix, quote, raw) {
      var target = mirrorResourceUrl(raw, 'GET');
      return target ? prefix + quote + target + quote : whole;
    });
  };
  var rewriteResourceAttribute = function (element, name, raw) {
    var tag = String(element && element.tagName || '').toLowerCase();
    var attr = String(name || '').toLowerCase();
    if (attr === 'style') return mirrorCss(raw);
    if (attr === 'src' && /^(script|img|source|video|audio|track|embed|input)$/.test(tag)) {
      return mirrorResourceUrl(raw, 'GET') || raw;
    }
    if (attr === 'poster' && tag === 'video') return mirrorResourceUrl(raw, 'GET') || raw;
    if (attr === 'href' && tag === 'link') {
      var rel = String(element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      if (rel.some(function (item) { return ['stylesheet', 'icon', 'preload', 'modulepreload', 'mask-icon', 'apple-touch-icon'].indexOf(item) >= 0; })) {
        return mirrorResourceUrl(raw, 'GET') || raw;
      }
    }
    return raw;
  };
  var prepareMirrorNode = function (node) {
    if (!node) return;
    if (node.nodeType === 1) {
      var attrs = ['src', 'href', 'poster', 'style'];
      for (var ai = 0; ai < attrs.length; ai++) {
        var attrValue = node.getAttribute(attrs[ai]);
        if (attrValue == null) continue;
        var rewritten = rewriteResourceAttribute(node, attrs[ai], attrValue);
        if (rewritten !== attrValue) nativeSetAttribute.call(node, attrs[ai], rewritten);
      }
    }
    if (node.querySelectorAll) {
      var descendants = node.querySelectorAll('*');
      for (var di = 0; di < descendants.length; di++) prepareMirrorNode(descendants[di]);
    }
  };
  try {
    Element.prototype.setAttribute = function (name, value) {
      return nativeSetAttribute.call(this, name, rewriteResourceAttribute(this, name, value));
    };
    var wrapNodeInsertion = function (prototype, name) {
      var original = prototype && prototype[name];
      if (typeof original !== 'function') return;
      prototype[name] = function () {
        for (var ai = 0; ai < arguments.length; ai++) prepareMirrorNode(arguments[ai]);
        return original.apply(this, arguments);
      };
    };
    wrapNodeInsertion(Node.prototype, 'appendChild');
    wrapNodeInsertion(Node.prototype, 'insertBefore');
    wrapNodeInsertion(Node.prototype, 'replaceChild');
    wrapNodeInsertion(Element.prototype, 'append');
    wrapNodeInsertion(Element.prototype, 'prepend');
    wrapNodeInsertion(Element.prototype, 'replaceChildren');
  } catch (e) { /* locked browser prototypes keep normal page behavior */ }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || 'GET';
      var raw = input && input.url ? input.url : input;
      var mirrorUrl = mirrorResourceUrl(raw, method);
      if (mirrorUrl) {
        var proxyOptions = {
          method: String(method).toUpperCase(),
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow'
        };
        try {
          var request = input instanceof Request ? input : null;
          var accept = (request && request.headers.get('Accept')) || (init && init.headers && init.headers.Accept) || '';
          if (accept) proxyOptions.headers = { Accept: accept };
          if ((init && init.signal) || (request && request.signal)) proxyOptions.signal = (init && init.signal) || request.signal;
        } catch (e) {}
        input = mirrorUrl;
        init = proxyOptions;
      }
      return origFetch.call(this, input, init).catch(function () {
        countDead('fetch:' + String((input && input.url) || input || ''));
        return new Response('', { status: 599, statusText: 'blocked-by-mirror' });
      });
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__cwUrl = String(url); } catch (e) {}
    var mirrorUrl = mirrorResourceUrl(url, method);
    if (mirrorUrl) arguments[1] = mirrorUrl;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      xhr.addEventListener('error', function () { countDead('xhr:' + (xhr.__cwUrl || '')); });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // Keep same-site links inside the archive shell. This makes the shell's address
  // bar, Back button and day controls follow clicks as normal browser history does,
  // while the archived document remains isolated in its sandboxed iframe.
  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var anchor = ev.target;
    if (anchor && anchor.nodeType === 3) anchor = anchor.parentNode;
    while (anchor && anchor !== document && String(anchor.tagName || '').toLowerCase() !== 'a') {
      anchor = anchor.parentNode;
    }
    if (!anchor || anchor === document || anchor.hasAttribute('download')) return;
    var target = (anchor.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self') return;

    try {
      var destination = new URL(anchor.href || anchor.getAttribute('href') || '', location.href);
      var documentOrigin = new URL(location.href).origin;
      if (destination.origin !== documentOrigin || !/^\/a\/[^/]+\/\d{4}-\d{2}-\d{2}(?:\/|$)/.test(destination.pathname)) return;
      ev.preventDefault();
      report('cw:navigate', { url: destination.pathname + destination.search + destination.hash });
    } catch (e) { /* malformed links keep their browser behavior */ }
  }, true);

  // ---- 3. Tell the shell we are interactive ------------------------------
  var flags = { deadLinks: 0, missingAssets: 0, stubbedScripts: 0 };
  try {
    var meta = document.querySelector('meta[name="cw-mirror"]');
    if (meta) {
      var parsed = JSON.parse(meta.getAttribute('content') || '{}');
      if (parsed && parsed.flags) flags = parsed.flags;
    }
  } catch (e) { /* flags are decoration; never break the page over them */ }

  // Surface unresolvable links the moment the page is interactive, so the shell can
  // say "18 links here point at pages this mirror does not have" instead of letting
  // the visitor discover it one dead click at a time.
  var reportDeadLinks = function () {
    var dead = document.querySelectorAll('a[data-cw-dead]');
    if (dead.length === 0) return;
    report('cw:dead-links', {
      count: dead.length,
      samples: Array.prototype.slice.call(dead, 0, 5).map(function (a) {
        return a.getAttribute('data-cw-dead');
      })
    });
  };

  var markReady = function () {
    if (window.__cwRuntime.ready) return;
    window.__cwRuntime.ready = true;
    report('cw:ready', { title: document.title || '', flags: flags });
    reportDeadLinks();
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(markReady, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(markReady, 0); });
  }
  window.addEventListener('load', markReady);

  window.addEventListener('message', function (ev) {
    var data = ev && ev.data;
    if (!data || data.__cw !== true) return;
    if (data.type === 'cw:ping') report('cw:pong', { href: location.href, title: document.title || '' });
    if (data.type === 'cw:request-links') {
      // Collect unique /a/ hrefs for SW prefetch, deduped, top 8.
      var seen = {};
      var links = [];
      var anchors = document.querySelectorAll('a[href]');
      for (var ai = 0; ai < anchors.length && links.length < 8; ai++) {
        var href = anchors[ai].getAttribute('href') || '';
        if (href.indexOf('/a/') === 0 && !seen[href]) {
          seen[href] = true;
          links.push(href);
        }
      }
      if (links.length > 0) report('cw:links', { urls: links });
    }
  });
})();
`;

/** Injected stylesheet: mirror chrome that must not depend on the archived page's CSS. */
export const RUNTIME_CSS = String.raw`
html { -webkit-text-size-adjust: 100%; }
body.cw-rewritten { overflow-anchor: none; }
.cw-stub { display: none !important; }
img[data-cw-missing] { outline: 1px dashed rgba(127,127,127,.5); outline-offset: -1px; }
/* A link we found but could not resolve. It stays clickable so the shell can explain
   why, rather than looking like a broken page. */
a.cw-dead-link { cursor: help; }
a.cw-dead-link:not([data-cw-external]) { text-decoration: line-through;
  text-decoration-color: rgba(242,85,90,.6); text-decoration-thickness: 1px; }
`;

export interface MirroredPageFlags {
  deadLinks: number;
  missingAssets: number;
  stubbedScripts: number;
}

export const RUNTIME_STYLE_ID = 'cw-runtime-style';
export const RUNTIME_SCRIPT_ID = 'cw-runtime-script';
