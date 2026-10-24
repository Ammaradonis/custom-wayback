/**
 * Browser-side runtime injected into every mirrored page.
 *
 * Exported as a string (not a file) because Phase 2 streams it through HTMLRewriter
 * inside the Worker, where a filesystem read is not available.
 *
 * It does four things:
 *   1. No-ops the legacy analytics/ad globals that old pages call at load time.
 *   2. Keeps every URL the page's own code produces inside the mirror: assets go to the
 *      same-origin resource route, same-site links to viewer routes. The server rewrites
 *      the markup it streams; this covers what a modern page builds afterwards.
 *   3. Swallows errors from dead third-party endpoints so the page looks intact
 *      instead of hanging for 30 s and spraying the console.
 *   4. Reports state to the host shell (toolbar) over postMessage, including a count
 *      of dead-request events for the "N unavailable resources" badge, and the links
 *      the shell should warm next.
 *
 * Constraints on the source: ASCII only (it is injected ahead of the page's own
 * `<meta charset>`), no closing script tag, and no template-literal interpolation.
 */

export const RUNTIME_SCRIPT = String.raw`
(function () {
  if (window.__cwRuntime) return;
  window.__cwRuntime = { dead: 0, errors: 0, ready: false };
  var framed = window.parent && window.parent !== window;

  var report = function (type, detail) {
    try {
      if (framed) window.parent.postMessage({ __cw: true, type: type, detail: detail || null }, '*');
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

  // The same origin rule makes reading document.cookie throw a SecurityError, and
  // modern pages read cookies first thing at startup: one uncaught throw there and the
  // rest of the page's script never runs. Keep an in-memory jar instead, only when the
  // browser actually refuses (a page served with a real origin keeps real cookies).
  try {
    var cookiesWork = true;
    try { void document.cookie; } catch (e) { cookiesWork = false; }
    if (!cookiesWork) {
      var jar = Object.create(null);
      var expired = function (attributes) {
        var maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(attributes);
        if (maxAge) return Number(maxAge[1]) <= 0;
        var expires = /;\s*expires\s*=\s*([^;]+)/i.exec(attributes);
        return !!expires && Date.parse(expires[1]) < Date.now();
      };
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () {
          var pairs = [];
          for (var cookieName in jar) pairs.push(cookieName + '=' + jar[cookieName]);
          return pairs.join('; ');
        },
        set: function (value) {
          var text = String(value);
          var semicolon = text.indexOf(';');
          var pair = semicolon >= 0 ? text.slice(0, semicolon) : text;
          var eq = pair.indexOf('=');
          var key = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
          if (!key) return;
          if (expired(semicolon >= 0 ? text.slice(semicolon) : '')) delete jar[key];
          else jar[key] = eq >= 0 ? pair.slice(eq + 1).trim() : '';
        }
      });
    }
  } catch (e) {}

  // A child frame the page creates for itself (about:blank, srcdoc) normally shares the
  // page's origin, and pages lean on that: text-zoom and resize detectors listen on an
  // empty iframe's window, ad slots write into its document. Under an opaque origin each
  // such frame gets an origin of its own, so the first touch throws and takes the
  // calling module down with it. Hand those calls a quiet stand-in: listeners attach to
  // nothing, writes land in a detached document, layout questions are answered by the
  // page's own window. Frames the page can reach, and frames with a real URL, are
  // returned exactly as the browser returns them.
  try {
    var frameProto = HTMLIFrameElement.prototype;
    var nativeContentWindow = Object.getOwnPropertyDescriptor(frameProto, 'contentWindow').get;
    var nativeContentDocument = Object.getOwnPropertyDescriptor(frameProto, 'contentDocument').get;
    var standIns = new WeakMap();
    var isBlankFrame = function (frame) {
      var src = frame.getAttribute('src');
      return frame.hasAttribute('srcdoc') || !src || /^\s*(?:about:|javascript:)/i.test(src);
    };
    var reachable = function (win) { try { void win.document; return true; } catch (e) { return false; } };
    var standInFor = function (frame, real) {
      var existing = standIns.get(frame);
      if (existing) return existing;
      var events = document.createElement('span');
      var own = {
        document: document.implementation.createHTMLDocument(''),
        frameElement: frame,
        parent: window,
        addEventListener: function (type, listener, options) { events.addEventListener(type, listener, options); },
        removeEventListener: function (type, listener, options) { events.removeEventListener(type, listener, options); },
        dispatchEvent: function (event) { return events.dispatchEvent(event); },
        postMessage: function () { try { return real.postMessage.apply(real, arguments); } catch (e) {} }
      };
      Object.defineProperty(own, 'innerWidth', { get: function () { return frame.clientWidth; } });
      Object.defineProperty(own, 'innerHeight', { get: function () { return frame.clientHeight; } });
      var standIn = new Proxy(own, {
        get: function (target, key) {
          if (key in target) return target[key];
          if (key === 'window' || key === 'self' || key === 'globalThis') return standIn;
          var value = window[key];
          // Methods need their receiver; constructors (Array, Object, ...) must stay intact.
          return typeof value === 'function' && !/^[A-Z]/.test(String(key)) ? value.bind(window) : value;
        },
        set: function (target, key, value) { target[key] = value; return true; },
        has: function (target, key) { return key in target || key in window; }
      });
      standIns.set(frame, standIn);
      return standIn;
    };
    Object.defineProperty(frameProto, 'contentWindow', {
      configurable: true,
      enumerable: true,
      get: function () {
        var real = nativeContentWindow.call(this);
        if (!real || !isBlankFrame(this) || reachable(real)) return real;
        return standInFor(this, real);
      }
    });
    Object.defineProperty(frameProto, 'contentDocument', {
      configurable: true,
      enumerable: true,
      get: function () {
        var real = nativeContentDocument.call(this);
        if (real || !isBlankFrame(this)) return real;
        var win = nativeContentWindow.call(this);
        return win ? standInFor(this, win).document : real;
      }
    });
  } catch (e) {}
  if (Array.isArray(window.dataLayer)) {
    var push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function () { try { return push.apply(null, arguments); } catch (e) { return 0; } };
  }
  // Beacons only ever went to analytics endpoints, which the policy blocks anyway.
  try { if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; }; } catch (e) {}

  // ---- 2. Keep the page's own URLs inside the mirror ----------------------
  //
  // The cw-mirror meta is emitted after this script on the on-demand path, so it is
  // read lazily, once, the first time something needs it.
  var mirrorInfo = null;
  var readMirror = function () {
    if (mirrorInfo) return mirrorInfo;
    try {
      var meta = document.querySelector('meta[name="cw-mirror"]');
      if (!meta) return null;
      mirrorInfo = JSON.parse(meta.getAttribute('content') || '{}') || {};
    } catch (e) { mirrorInfo = null; }
    return mirrorInfo;
  };
  var appOrigin = (function () { try { return new URL(location.href).origin; } catch (e) { return ''; } })();
  var routeMatch = /^\/a\/([^/]+)\/(\d{4}-\d{2}-\d{2})(?:\/|$)/.exec(location.pathname);
  var ROUTE_PATTERN = /^\/a\/[^/]+\/\d{4}-\d{2}-\d{2}(?:\/|$)/;

  // Analytics endpoints, as the server rewriter recognises them (isTrackerUrl). Proxied,
  // each beacon would ask the archive for a unique, never-captured URL on every page
  // view; left alone, the page's policy refuses it in the browser at no cost.
  var TRACKER_HOST = /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|googletagservices\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|facebook\.(?:com|net)|omtrdc\.net|2o7\.net|demdex\.net|everesttech\.net|adobedtm\.com|tiqcdn\.com|tealiumiq\.com|scorecardresearch\.com|quantserve\.com|bat\.bing\.com|clarity\.ms|hotjar\.com|krxd\.net|bluekai\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|adsrvr\.org|ads-twitter\.com|analytics\.tiktok\.com|snap\.licdn\.com|mixpanel\.com|mxpnl\.com|segment\.(?:io|com)|amplitude\.com|nr-data\.net|heapanalytics\.com|fullstory\.com|go-mpulse\.net)$/i;
  var isTracker = function (url) {
    return TRACKER_HOST.test(url.hostname) || /^(?:s?metrics|securemetrics|sstats)\./i.test(url.hostname) ||
      url.pathname.indexOf('/b/ss/') === 0;
  };
  var trackerRequest = function (raw) {
    try {
      if (raw && typeof raw === 'object' && raw.url) raw = raw.url;
      var mirror = readMirror();
      var target = new URL(String(raw), (mirror && mirror.url) || location.href);
      if (target.origin === appOrigin) target = new URL(target.pathname + target.search, (mirror && mirror.url) || location.href);
      return isTracker(target);
    } catch (e) { return false; }
  };

  // An archived resource URL: /_cw/r/<ts>/<scheme>/<host><path>?<query>. Path-shaped so
  // a script or stylesheet resolving a URL relative to itself stays in the mirror.
  var mirrorResourceUrl = function (raw, method) {
    var verb = String(method || 'GET').toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') return null;
    try {
      if (raw && typeof raw === 'object' && raw.url) raw = raw.url;
      if (raw instanceof URL) raw = raw.href;
      var value = String(raw == null ? '' : raw).trim();
      if (!value || /^(?:data|blob|javascript|about):/i.test(value) || value.charAt(0) === '#') return null;
      if (value.indexOf('/_cw/') === 0) return null;
      var mirror = readMirror();
      if (!mirror || !mirror.resourceProxy || !/^\d{14}$/.test(mirror.ts || '') || !mirror.url) return null;

      var target = new URL(value, mirror.url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
      if (target.origin === appOrigin) {
        if (target.pathname.indexOf('/_cw/') === 0 ||
            ROUTE_PATTERN.test(target.pathname) ||
            /^\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/i.test(target.pathname)) return null;
        // Built from location.origin, which is ours, not the site's: put it back on the site.
        target = new URL(target.pathname + target.search + target.hash, mirror.url);
      }
      if (isTracker(target)) return null;

      return '/_cw/r/' + mirror.ts + '/' + target.protocol.slice(0, -1) + '/' + target.host +
        target.pathname + target.search + target.hash;
    } catch (e) { return null; }
  };
  var asResource = function (raw) { return mirrorResourceUrl(raw, 'GET') || raw; };

  // srcset: comma-separated candidates; a URL never contains whitespace, a data URL
  // may contain commas, so split on the whitespace that ends each URL.
  var mirrorSrcset = function (value) {
    var text = String(value == null ? '' : value);
    var out = [];
    var changed = false;
    var cursor = 0;
    while (cursor < text.length) {
      while (cursor < text.length && /[\s,]/.test(text.charAt(cursor))) cursor++;
      if (cursor >= text.length) break;
      var start = cursor;
      while (cursor < text.length && !/\s/.test(text.charAt(cursor))) cursor++;
      var token = text.slice(start, cursor);
      var trailing = /,+$/.exec(token);
      var url = trailing ? token.slice(0, -trailing[0].length) : token;
      var descriptor = '';
      if (!trailing) {
        while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor++;
        var dStart = cursor;
        while (cursor < text.length && text.charAt(cursor) !== ',') cursor++;
        descriptor = text.slice(dStart, cursor).trim();
        if (text.charAt(cursor) === ',') cursor++;
      }
      if (!url) continue;
      var mapped = asResource(url);
      if (mapped !== url) changed = true;
      out.push(descriptor ? mapped + ' ' + descriptor : mapped);
    }
    // Unchanged input comes back as the same string, so re-applying it is not a mutation.
    return changed ? out.join(', ') : value;
  };

  var mirrorCss = function (css) {
    var value = String(css == null ? '' : css);
    if (value.indexOf('url(') < 0 && value.indexOf('@import') < 0) return value;
    value = value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (whole, quote, raw) {
      var target = mirrorResourceUrl(raw, 'GET');
      return target ? 'url("' + target + '")' : whole;
    });
    return value.replace(/(@import\s+)(['"])([^'"]+)\2/gi, function (whole, prefix, quote, raw) {
      var target = mirrorResourceUrl(raw, 'GET');
      return target ? prefix + quote + target + quote : whole;
    });
  };

  var registrableHost = function (host) {
    var parts = String(host || '').toLowerCase().split('.');
    if (parts.length <= 2) return parts.join('.');
    var lastTwo = parts.slice(-2).join('.');
    var twoLevel = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.kr', 'com.cn', 'co.in'];
    return twoLevel.indexOf(lastTwo) >= 0 ? parts.slice(-3).join('.') : lastTwo;
  };
  // A same-site URL as a viewer route, or null. Relative values resolve against the
  // original page, which is what they meant when the site was live.
  var viewerRouteFor = function (raw) {
    if (raw == null || String(raw) === '' || String(raw).charAt(0) === '#') return null;
    try {
      if (!routeMatch) return null;
      var value = String(raw);
      if (/^(?:javascript|mailto|tel|data|blob):/i.test(value)) return null;
      var appTarget = new URL(value, location.href);
      if (appTarget.origin === appOrigin && ROUTE_PATTERN.test(appTarget.pathname)) {
        var appRoute = appTarget.pathname;
        if (appTarget.search) appRoute += '%3F' + encodeURIComponent(appTarget.search.slice(1));
        return appRoute + appTarget.hash;
      }

      var mirror = readMirror();
      if (!mirror || !mirror.url) return null;
      var original = new URL(mirror.url);
      // A URL built from location.origin (ours) means the same path on the original site.
      var target = appTarget.origin === appOrigin
        ? new URL(appTarget.pathname + appTarget.search + appTarget.hash, original)
        : new URL(value, original);
      if ((target.protocol !== 'http:' && target.protocol !== 'https:') ||
          registrableHost(target.hostname) !== registrableHost(original.hostname)) return null;

      var route = '/a/' + routeMatch[1] + '/' + routeMatch[2] + (target.pathname || '/');
      if (target.search) route += '%3F' + encodeURIComponent(target.search.slice(1));
      return route + target.hash;
    } catch (e) { return null; }
  };

  var LINK_RELS = ['stylesheet', 'icon', 'preload', 'modulepreload', 'prefetch', 'mask-icon', 'apple-touch-icon'];
  var isResourceLink = function (element) {
    var rel = String(element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    for (var ri = 0; ri < rel.length; ri++) if (LINK_RELS.indexOf(rel[ri]) >= 0) return true;
    return false;
  };
  // The one place that decides what an attribute value should become.
  var rewriteResourceAttribute = function (element, name, raw) {
    if (raw == null) return raw;
    var tag = String(element && element.tagName || '').toLowerCase();
    var attr = String(name || '').toLowerCase();
    var value = String(raw);
    if (attr === 'style') return mirrorCss(value);
    if (value.indexOf('/_cw/') === 0) return raw;
    if (attr === 'src' && /^(script|img|source|video|audio|track|embed|input)$/.test(tag)) return asResource(value);
    if (attr === 'srcset' && (tag === 'img' || tag === 'source')) return mirrorSrcset(value);
    if (attr === 'poster' && tag === 'video') return asResource(value);
    if (attr === 'href' && tag === 'link') return isResourceLink(element) ? asResource(value) : raw;
    if (attr === 'href' && (tag === 'a' || tag === 'area')) {
      if (value.indexOf('/a/') === 0 || element.hasAttribute && element.hasAttribute('data-cw-external')) return raw;
      return viewerRouteFor(value) || raw;
    }
    return raw;
  };

  var nativeSetAttribute = Element.prototype.setAttribute;
  var REWRITTEN_ATTRIBUTES = ['src', 'srcset', 'href', 'poster', 'style'];
  var prepareAttribute = function (element, name) {
    try {
      var current = element.getAttribute(name);
      if (current == null) return;
      var next = rewriteResourceAttribute(element, name, current);
      if (next !== current) nativeSetAttribute.call(element, name, next);
    } catch (e) {}
  };
  var prepareStyleElement = function (element) {
    try {
      var css = element.textContent || '';
      var next = mirrorCss(css);
      if (next !== css) element.textContent = next;
    } catch (e) {}
  };
  var prepareElement = function (element) {
    for (var ai = 0; ai < REWRITTEN_ATTRIBUTES.length; ai++) {
      if (element.hasAttribute(REWRITTEN_ATTRIBUTES[ai])) prepareAttribute(element, REWRITTEN_ATTRIBUTES[ai]);
    }
    if (element.tagName === 'STYLE') prepareStyleElement(element);
  };
  var prepareMirrorNode = function (node) {
    if (!node || node.nodeType !== 1) {
      if (node && node.nodeType === 11 && node.querySelectorAll) {
        var fragmentNodes = node.querySelectorAll('*');
        for (var fi = 0; fi < fragmentNodes.length; fi++) prepareElement(fragmentNodes[fi]);
      }
      return;
    }
    prepareElement(node);
    if (node.firstElementChild) {
      var descendants = node.querySelectorAll('*');
      for (var di = 0; di < descendants.length; di++) prepareElement(descendants[di]);
    }
  };

  // Rewrite URL attributes inside a markup string, for the APIs that parse markup
  // (innerHTML, insertAdjacentHTML, document.write) and would otherwise start requests
  // for the URLs exactly as written.
  var rewriteMarkup = function (html) {
    if (typeof html !== 'string' || html.indexOf('<') < 0) return html;
    return html.replace(/<(script|img|link|source|video|audio|track|embed|input|a|area)\b([^>]*)>/gi, function (whole, tag, attrs) {
      var fake = {
        tagName: tag,
        getAttribute: function (n) {
          var found = new RegExp('\\s' + n + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i').exec(attrs);
          return found ? found[2] : null;
        },
        hasAttribute: function (n) { return new RegExp('\\s' + n + '(?:\\s|=|$)', 'i').test(attrs); }
      };
      var changed = false;
      var out = attrs.replace(/(\s(src|srcset|href|poster|style)\s*=\s*)(["'])([^"']*)\3/gi, function (m, prefix, attr, quote, value) {
        var decoded = value.replace(/&amp;/g, '&');
        var next = rewriteResourceAttribute(fake, attr, decoded);
        if (next === decoded) return m;
        changed = true;
        return prefix + quote + String(next).replace(/&/g, '&amp;').replace(new RegExp(quote, 'g'), quote === '"' ? '&quot;' : '&#39;') + quote;
      });
      return changed ? '<' + tag + out + '>' : whole;
    });
  };

  // Hook a property setter on a prototype, keeping the native getter.
  var hookSetter = function (proto, prop, rewrite) {
    try {
      var desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.set !== 'function' || !desc.configurable) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) { return desc.set.call(this, rewrite(this, value)); }
      });
    } catch (e) { /* a locked prototype keeps the browser's behavior */ }
  };

  try {
    // Attributes, the way frameworks set them.
    Element.prototype.setAttribute = function (name, value) {
      return nativeSetAttribute.call(this, name, rewriteResourceAttribute(this, name, value));
    };

    // Properties, the way lazy loaders, preloaders and bundlers set them: an image
    // starts its request the moment its src is assigned, inserted or not.
    var attributeSetter = function (attr) {
      return function (element, value) { return rewriteResourceAttribute(element, attr, value); };
    };
    var PROPERTY_HOOKS = [
      ['HTMLImageElement', 'src'], ['HTMLImageElement', 'srcset'],
      ['HTMLSourceElement', 'src'], ['HTMLSourceElement', 'srcset'],
      ['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'],
      ['HTMLMediaElement', 'src'], ['HTMLVideoElement', 'poster'],
      ['HTMLTrackElement', 'src'], ['HTMLEmbedElement', 'src'],
      ['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href']
    ];
    for (var hi = 0; hi < PROPERTY_HOOKS.length; hi++) {
      var ctor = window[PROPERTY_HOOKS[hi][0]];
      if (ctor) hookSetter(ctor.prototype, PROPERTY_HOOKS[hi][1], attributeSetter(PROPERTY_HOOKS[hi][1]));
    }

    // Inline styles and stylesheets built in script.
    var cssValue = function (element, value) { return typeof value === 'string' ? mirrorCss(value) : value; };
    var styleProto = window.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
    if (styleProto) {
      var nativeSetProperty = styleProto.setProperty;
      styleProto.setProperty = function (prop, value, priority) {
        return nativeSetProperty.call(this, prop, cssValue(this, value), priority);
      };
      var sample = document.documentElement && document.documentElement.style;
      var CSS_PROPS = ['cssText', 'background', 'backgroundImage', 'borderImage', 'borderImageSource',
                       'listStyle', 'listStyleImage', 'maskImage', 'webkitMaskImage', 'content'];
      for (var ci = 0; ci < CSS_PROPS.length; ci++) {
        for (var p = sample ? Object.getPrototypeOf(sample) : styleProto; p; p = Object.getPrototypeOf(p)) {
          if (Object.getOwnPropertyDescriptor(p, CSS_PROPS[ci])) { hookSetter(p, CSS_PROPS[ci], cssValue); break; }
        }
      }
    }
    var sheetProto = window.CSSStyleSheet && CSSStyleSheet.prototype;
    if (sheetProto) {
      var nativeInsertRule = sheetProto.insertRule;
      if (nativeInsertRule) sheetProto.insertRule = function (rule, index) {
        return arguments.length > 1 ? nativeInsertRule.call(this, mirrorCss(rule), index) : nativeInsertRule.call(this, mirrorCss(rule));
      };
      var nativeReplace = sheetProto.replace;
      if (nativeReplace) sheetProto.replace = function (text) { return nativeReplace.call(this, mirrorCss(text)); };
      var nativeReplaceSync = sheetProto.replaceSync;
      if (nativeReplaceSync) sheetProto.replaceSync = function (text) { return nativeReplaceSync.call(this, mirrorCss(text)); };
    }

    // Markup parsed from strings.
    var markupSetter = function (element, value) { return rewriteMarkup(value); };
    hookSetter(Element.prototype, 'innerHTML', markupSetter);
    hookSetter(Element.prototype, 'outerHTML', markupSetter);
    if (window.ShadowRoot) hookSetter(ShadowRoot.prototype, 'innerHTML', markupSetter);
    var nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    if (nativeInsertAdjacentHTML) Element.prototype.insertAdjacentHTML = function (position, html) {
      return nativeInsertAdjacentHTML.call(this, position, rewriteMarkup(html));
    };
    var wrapWrite = function (native) {
      return function () {
        var parts = [];
        for (var wi = 0; wi < arguments.length; wi++) parts.push(rewriteMarkup(String(arguments[wi])));
        return native.apply(document, parts);
      };
    };
    if (document.write) document.write = wrapWrite(document.write);
    if (document.writeln) document.writeln = wrapWrite(document.writeln);

    // Nodes built detached and then inserted: scripts and stylesheets start their
    // request on insertion, so rewriting here precedes it.
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
    wrapNodeInsertion(Element.prototype, 'before');
    wrapNodeInsertion(Element.prototype, 'after');
    wrapNodeInsertion(Element.prototype, 'replaceWith');
    wrapNodeInsertion(Element.prototype, 'replaceChildren');
  } catch (e) { /* locked browser prototypes keep normal page behavior */ }

  // The net under all of the above: whatever reached the document by a path no hook
  // sees (a template clone, a framework's own DOM ops, a style element's text) is
  // rewritten as soon as it lands. Rewrites are idempotent, so the work the hooks
  // already did costs one comparison here.
  try {
    new MutationObserver(function (records) {
      for (var ri = 0; ri < records.length; ri++) {
        var record = records[ri];
        if (record.type === 'attributes') { prepareAttribute(record.target, record.attributeName); continue; }
        if (record.target && record.target.nodeName === 'STYLE') prepareStyleElement(record.target);
        var added = record.addedNodes;
        for (var ni = 0; ni < added.length; ni++) prepareMirrorNode(added[ni]);
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: REWRITTEN_ATTRIBUTES
    });
  } catch (e) {}

  // ---- 3. Dead-endpoint interceptor -------------------------------------
  var countDead = function (why) {
    window.__cwRuntime.dead += 1;
    report('cw:dead-request', { why: String(why || '').slice(0, 200), count: window.__cwRuntime.dead });
  };

  window.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'IMG' || t.tagName === 'LINK')) {
      // Removing a node during navigation cancels its request and can fire an error;
      // disconnected nodes are lifecycle cancellations, not blocked archive assets.
      if (t.isConnected === false) return;
      // An image whose first URL was refused and that is already loading the mirrored
      // one is not missing; it is about to appear.
      if (t.tagName === 'IMG' && !t.complete) return;
      // A tracking pixel the policy refused is the mirror working, not a missing asset.
      if (trackerRequest(t.src || t.href || '')) return;
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
      var method = (init && init.method) || (input && input.method) || 'GET';
      var raw = input && input.url ? input.url : input;
      // Analytics calls get the empty answer a beacon endpoint gives, without a request.
      if (trackerRequest(raw)) return Promise.resolve(new Response(null, { status: 204 }));
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
      return origFetch.call(this, input, init).catch(function (error) {
        // Site routers routinely abort fetches when the visitor changes pages. Keep
        // the browser's normal AbortError behavior and do not call those requests blocked.
        if (error && error.name === 'AbortError') return Promise.reject(error);
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
      xhr.addEventListener('error', function () {
        if (!trackerRequest(xhr.__cwUrl)) countDead('xhr:' + (xhr.__cwUrl || ''));
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // Client-side routers sometimes navigate from buttons or call pushState
  // directly instead of following an anchor. Convert those same-site URLs into
  // viewer routes too, so the shell address, iframe and browser history stay in
  // step with the page the visitor is browsing.
  var nativePushState = history.pushState;
  var nativeReplaceState = history.replaceState;
  history.pushState = function (state, title, url) {
    var route = framed ? viewerRouteFor(url) : null;
    if (route) {
      // Store the new state without creating a duplicate iframe history entry;
      // the outer viewer owns the visible page navigation and Back/Forward stack.
      nativeReplaceState.call(this, state, title, location.href);
      report('cw:navigate', { url: route });
      return;
    }
    return nativePushState.apply(this, arguments);
  };
  history.replaceState = function (state, title, url) {
    var route = framed ? viewerRouteFor(url) : null;
    if (route) {
      nativeReplaceState.call(this, state, title, location.href);
      report('cw:navigate', { url: route, replace: true });
      return;
    }
    return nativeReplaceState.apply(this, arguments);
  };

  var anchorFrom = function (node) {
    var anchor = node;
    if (anchor && anchor.nodeType === 3) anchor = anchor.parentNode;
    while (anchor && anchor !== document && !/^(a|area)$/i.test(String(anchor.tagName || ''))) {
      anchor = anchor.parentNode;
    }
    return anchor && anchor !== document ? anchor : null;
  };
  var currentPage = location.pathname;

  // Keep same-site links inside the archive shell. This makes the shell's address
  // bar, Back button and day controls follow clicks as normal browser history does,
  // while the archived document remains isolated in its sandboxed iframe. A link the
  // page rendered with a root-relative href is resolved against the original site,
  // not followed onto the app's own origin.
  document.addEventListener('click', function (ev) {
    if (!framed) return;
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var anchor = anchorFrom(ev.target);
    if (!anchor || anchor.hasAttribute('download')) return;
    var target = (anchor.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self' && target !== '_top' && target !== '_parent') return;

    var route = viewerRouteFor(anchor.getAttribute('href'));
    if (!route) return;
    // A jump within this page scrolls; it is not a navigation.
    var hashAt = route.indexOf('#');
    if (hashAt >= 0 && route.slice(0, hashAt) === currentPage) return;
    ev.preventDefault();
    report('cw:navigate', { url: route });
  }, true);

  // ---- 4. Tell the shell what is happening -------------------------------
  var reportMetadata = function () {
    var mirror = readMirror();
    if (!mirror) return;
    report('cw:metadata', {
      source: mirror.source || null,
      resolvedDay: mirror.resolvedDay || null,
      deltaDays: typeof mirror.deltaDays === 'number' ? mirror.deltaDays : null
    });
  };

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

  // The in-site links the visitor is most likely to open next, for the shell to warm.
  // Document order puts the site's own navigation first, which is the point.
  var reportLinks = function () {
    var seen = {};
    var links = [];
    seen[currentPage] = true;
    var anchors = document.querySelectorAll('a[href]');
    for (var ai = 0; ai < anchors.length && links.length < 8; ai++) {
      var href = (anchors[ai].getAttribute('href') || '').split('#')[0];
      if (href.indexOf('/a/') === 0 && !seen[href]) {
        seen[href] = true;
        links.push(href);
      }
    }
    if (links.length > 0) report('cw:links', { urls: links });
  };

  // Hovering or touching a link is a strong hint it is about to be opened: tell the
  // shell, once per link, after a short dwell so a pointer sweeping past says nothing.
  var intentTimer = null;
  var intentSent = {};
  var reportIntent = function (ev, delay) {
    var anchor = anchorFrom(ev.target);
    if (!anchor) return;
    var href = (anchor.getAttribute('href') || '').split('#')[0];
    if (href.indexOf('/a/') !== 0 || href === currentPage || intentSent[href]) return;
    clearTimeout(intentTimer);
    intentTimer = setTimeout(function () {
      intentSent[href] = true;
      report('cw:intent', { url: href });
    }, delay);
  };
  document.addEventListener('pointerover', function (ev) { reportIntent(ev, 90); }, true);
  document.addEventListener('touchstart', function (ev) { reportIntent(ev, 0); }, { capture: true, passive: true });

  // Files archive.org refused to give the Worker (HTTP 429). A failed response is opaque
  // to the page except for its Server-Timing entry, which the Worker sets to
  // 'cw-throttled' for exactly this; the shell uses the count to say why the page may
  // look broken, and to offer archive.org's own replay instead.
  var throttled = { count: 0, styles: 0 };
  var throttleTimer = null;
  var reportThrottled = function () {
    if (throttled.count > 0) report('cw:throttled', { count: throttled.count, styles: throttled.styles });
  };
  var noteTimings = function (entries) {
    var found = 0;
    for (var ti = 0; ti < entries.length; ti++) {
      var timings = entries[ti].serverTiming || [];
      for (var tj = 0; tj < timings.length; tj++) {
        if (timings[tj].name !== 'cw-throttled') continue;
        found++;
        if (/\.css(?:[?#]|$)/i.test(entries[ti].name)) throttled.styles++;
        break;
      }
    }
    if (found === 0) return;
    throttled.count += found;
    // One message per burst: a throttled page fails dozens of files within a moment.
    if (throttleTimer === null) {
      throttleTimer = setTimeout(function () { throttleTimer = null; reportThrottled(); }, 400);
    }
  };
  try {
    if (framed && window.PerformanceObserver) {
      new PerformanceObserver(function (list) { noteTimings(list.getEntries()); })
        .observe({ type: 'resource', buffered: true });
    }
  } catch (e) { /* no resource timing here: the shell just cannot say why */ }

  var markReady = function () {
    if (window.__cwRuntime.ready) return;
    window.__cwRuntime.ready = true;
    var mirror = readMirror();
    // path is where the frame actually is, after any redirect the shell did not see.
    report('cw:ready', {
      title: document.title || '',
      path: location.pathname,
      flags: (mirror && mirror.flags) || { deadLinks: 0, missingAssets: 0, stubbedScripts: 0 }
    });
    reportMetadata();
    reportDeadLinks();
    reportLinks();
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
    if (data.type === 'cw:request-metadata') reportMetadata();
    if (data.type === 'cw:request-links') reportLinks();
    if (data.type === 'cw:request-throttled') reportThrottled();
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
