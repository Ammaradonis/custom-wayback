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

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
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
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      xhr.addEventListener('error', function () { countDead('xhr:' + (xhr.__cwUrl || '')); });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

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
