/**
 * Static UI for the local mirror. Shipped as a string so Phase 2 can reuse it as a
 * Worker template without a build step. Intentionally dependency-free: this is the
 * "does the mirror actually work in a browser" harness, not the final product shell
 * (that is the React PWA described in plan.md section 2.3).
 *
 * Three things it has to get right, because they are the whole point of the tool:
 *   1. Navigation - pick a day, click through the site, go back, without ever falling
 *      out of the mirror or hitting an unexplained dead end.
 *   2. Progress   - you can always see what is loading and how far along it is.
 *   3. Honesty    - a link this mirror does not have says so, immediately.
 */

export const VIEWER_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex,nofollow">
<title>custom-wayback — local mirror</title>
<style>
  :root {
    --bg:#0b0d10; --panel:#14181d; --panel2:#1b2027; --line:#262c34;
    --fg:#e7eaee; --muted:#939cab; --accent:#4c9aff; --warn:#f5a524; --bad:#f2555a;
    --ok:#3ecf8e;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; }
  body {
    background:var(--bg); color:var(--fg); overflow:hidden; display:flex; flex-direction:column;
    font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Inter,system-ui,sans-serif;
    -webkit-text-size-adjust:100%; touch-action:manipulation;
  }

  /* ── header ─────────────────────────────────────────────────────────── */
  header {
    display:flex; align-items:center; gap:8px; flex:0 0 auto; z-index:6;
    padding:8px 12px; padding-top:calc(8px + env(safe-area-inset-top));
    background:color-mix(in srgb, var(--panel) 92%, transparent);
    backdrop-filter:blur(12px); border-bottom:1px solid var(--line);
  }
  .brand { font-weight:650; letter-spacing:-.01em; white-space:nowrap; }
  .brand span { color:var(--muted); font-weight:450; }
  select, button {
    font:inherit; color:var(--fg); background:var(--panel2); border:1px solid var(--line);
    border-radius:9px; padding:7px 10px; min-height:36px;
  }
  button { cursor:pointer; }
  button:hover:not(:disabled) { background:#222a33; }
  button:disabled { opacity:.4; cursor:default; }
  button.icon { padding:7px 11px; font-size:15px; line-height:1; }
  button.go { border-color:color-mix(in srgb,var(--accent) 55%,var(--line)); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .url {
    flex:1 1 240px; min-width:0; font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--muted); background:#0e1216; border:1px solid var(--line); border-radius:9px;
    padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .chip {
    font-size:11px; padding:3px 8px; border-radius:999px; white-space:nowrap;
    border:1px solid var(--line); background:var(--panel2); color:var(--muted);
  }
  .chip[hidden] { display:none; }
  .chip.bad { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 45%,var(--line)); }
  .chip.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 45%,var(--line)); }

  /* ── progress ───────────────────────────────────────────────────────── */
  .progress { flex:0 0 auto; height:3px; background:transparent; overflow:hidden; position:relative; }
  .progress[hidden] { display:none; }
  .bar {
    height:100%; width:35%; border-radius:0 3px 3px 0;
    background:linear-gradient(90deg, transparent, var(--accent));
    animation:slide 1.1s ease-in-out infinite;
  }
  .progress.done .bar { width:100%; animation:none; background:var(--ok); transition:width .18s ease; }
  @keyframes slide { 0% { transform:translateX(-100%);} 100% { transform:translateX(320%);} }
  @media (prefers-reduced-motion: reduce) { .bar { animation:none; width:100%; opacity:.5; } }

  /* ── day strip ──────────────────────────────────────────────────────── */
  .days {
    display:flex; gap:6px; flex:0 0 auto; overflow-x:auto; padding:8px 12px;
    background:var(--panel); border-bottom:1px solid var(--line); -webkit-overflow-scrolling:touch;
  }
  .days:empty { display:none; }
  .day {
    flex:0 0 auto; min-width:64px; text-align:center; padding:6px 8px; border-radius:10px;
    border:1px solid var(--line); background:var(--panel2); line-height:1.15;
  }
  .day b { display:block; font-size:13px; }
  .day small { color:var(--muted); font-size:10px; }
  .day[aria-current="true"] { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 18%,var(--panel2)); }

  /* ── main ───────────────────────────────────────────────────────────── */
  main { flex:1 1 auto; min-height:0; position:relative; background:#fff; }
  iframe { border:0; width:100%; height:100%; display:block; background:#fff; }
  iframe[hidden] { display:none; }
  .empty { display:grid; place-content:center; gap:10px; text-align:center; padding:28px; color:var(--muted); }
  .empty h2 { color:var(--fg); margin:0; font-size:18px; }
  code { background:var(--panel2); padding:3px 7px; border-radius:6px; color:var(--fg); font-size:12px; }

  /* ── report panel ───────────────────────────────────────────────────── */
  aside {
    position:fixed; inset:auto 0 0 0; max-height:80vh; overflow:auto; z-index:20;
    background:var(--panel); border-top:1px solid var(--line); border-radius:16px 16px 0 0;
    padding:14px 14px calc(20px + env(safe-area-inset-bottom)); box-shadow:0 -18px 40px rgba(0,0,0,.45);
  }
  aside[hidden] { display:none; }
  aside h3 { margin:14px 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  aside h3:first-child { margin-top:0; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:550; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .card { background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
  .card b { font-size:19px; display:block; font-variant-numeric:tabular-nums; }
  .card small { color:var(--muted); }
  a { color:var(--accent); }

  /* ── page list ──────────────────────────────────────────────────────── */
  .pagelist { display:flex; flex-direction:column; gap:4px; }
  .pagelist a {
    display:block; padding:7px 9px; border-radius:8px; text-decoration:none; color:var(--fg);
    background:var(--panel2); border:1px solid transparent; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; font-size:12.5px;
  }
  .pagelist a:hover { border-color:var(--accent); }
  .pagelist a small { color:var(--muted); font-family:ui-monospace,Menlo,monospace; font-size:11px; }

  .toast {
    position:fixed; left:50%; transform:translateX(-50%); bottom:22px; z-index:40; max-width:min(92vw,520px);
    background:var(--panel2); border:1px solid var(--line); color:var(--fg); font-size:12.5px;
    padding:10px 14px; border-radius:12px; opacity:0; pointer-events:none; transition:opacity .18s ease;
    box-shadow:0 10px 30px rgba(0,0,0,.5);
  }
  .toast.show { opacity:1; }
  @media (min-width:820px) {
    aside { inset:0 0 0 auto; width:440px; max-height:none; border-radius:0; border-top:0; border-left:1px solid var(--line); }
  }
</style>
</head>
<body>
<header>
  <div class="brand">custom-wayback <span>local mirror</span></div>
  <select id="site" aria-label="Domain and month"></select>
  <div class="url" id="url" title=""></div>
  <span class="chip" id="chipDead" hidden></span>
  <span class="chip bad" id="chipBlocked" hidden></span>
  <button class="icon" id="back" title="Back" aria-label="Back" disabled>&#8249;</button>
  <button class="icon" id="fwd" title="Forward" aria-label="Forward" disabled>&#8250;</button>
  <button class="icon" id="reload" title="Reload" aria-label="Reload" disabled>&#8635;</button>
  <button class="icon" id="open" title="Open the original capture on web.archive.org" aria-label="Open original">&#8599;</button>
  <button class="icon" id="stats" title="Ingest report" aria-label="Ingest report">&#8942;</button>
</header>
<div class="progress" id="progress" hidden><div class="bar" id="bar"></div></div>
<div class="days" id="days"></div>
<main id="main">
  <div class="empty" id="empty">
    <h2 id="emptyTitle">No mirror loaded yet</h2>
    <div id="emptyBody">Run an ingest, then pick a site above.</div>
    <div><code>npm run crawl -- --domain=example.com --month=2024-01 --max-pages=25</code></div>
  </div>
  <iframe id="frame" hidden sandbox="allow-scripts allow-forms allow-popups" title="Archived page"></iframe>
</main>
<aside id="panel" hidden></aside>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var state = {
    domain:null, month:null, day:null, route:null, manifest:null,
    stack:[], index:-1, busy:false, loadStart:0, dead:0, errors:0, flags:null
  };
  var mainFrame = null; // not used; kept explicit for clarity
  function $(id) { return document.getElementById(id); }

  // ── feedback ─────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3200);
  }
  function fmtBytes(n) {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function num(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString(); }
  function decodeRoute(route) {
    var m = /^\/a\/[^/]+\/\d{4}-\d{2}-\d{2}(\/.*)?$/.exec(route);
    var path = (m && m[1]) ? m[1] : '/';
    return path.replace(/%3F/i, '?');
  }
  function dayOf(route) {
    var m = /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})/.exec(route);
    return m ? m[1] : null;
  }

  // ── progress ─────────────────────────────────────────────────────────
  function startProgress() {
    state.busy = true; state.loadStart = Date.now();
    var p = $('progress'); p.hidden = false; p.classList.remove('done');
  }
  function finishProgress() {
    if (!state.busy) return;
    state.busy = false;
    var p = $('progress'), elapsed = Date.now() - state.loadStart;
    p.classList.add('done');
    // Let the completed bar register, then get out of the way. If the load was
    // genuinely fast, hold it slightly so the user sees that it was fast.
    setTimeout(function () {
      if (!state.busy) { p.hidden = true; p.classList.remove('done'); }
    }, Math.max(180, Math.min(700, elapsed / 2)));
  }
  function setNav() {
    $('back').disabled = state.index <= 0;
    $('fwd').disabled = state.index >= state.stack.length - 1;
    $('reload').disabled = !state.route;
  }

  // ── chips ────────────────────────────────────────────────────────────
  function setChips(data) {
    var deadChip = $('chipDead'), blockedChip = $('chipBlocked');
    var deadCount = data && data.count ? data.count : 0;
    if (deadCount > 0) {
      deadChip.hidden = false;
      deadChip.className = 'chip warn';
      deadChip.textContent = deadCount + ' link' + (deadCount === 1 ? '' : 's') + ' not in this mirror';
      deadChip.title = (data.samples || []).join('\n');
    } else {
      deadChip.hidden = true;
    }
    if (state.dead > 0) {
      blockedChip.hidden = false;
      blockedChip.textContent = state.dead + ' blocked request' + (state.dead === 1 ? '' : 's');
      blockedChip.title = 'Requests the archived page made to endpoints that no longer exist. ' +
        'They were silenced so the page cannot hang waiting for them.';
    } else {
      blockedChip.hidden = true;
    }
  }

  // ── site selection ───────────────────────────────────────────────────
  fetch('/api/sites').then(function (r) { return r.json(); }).then(function (data) {
    var sel = $('site');
    if (!data.sites.length) return;
    data.sites.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.domain + '|' + s.month;
      o.textContent = s.domain + ' \u00b7 ' + s.month + ' \u2014 ' + s.pages + ' page' +
        (s.pages === 1 ? '' : 's') + ', ' + s.days + ' day' + (s.days === 1 ? '' : 's');
      sel.appendChild(o);
    });
    sel.onchange = function () { selectSite(sel.value); };
    var qs = new URLSearchParams(location.search);
    if (qs.get('domain') && qs.get('month')) {
      var want = qs.get('domain') + '|' + qs.get('month');
      if (data.sites.some(function (s) { return s.domain + '|' + s.month === want; })) sel.value = want;
    }
    selectSite(sel.value);
  }).catch(function (e) { toast('could not list sites: ' + e.message); });

  function selectSite(value) {
    if (!value) return;
    var parts = value.split('|');
    state.domain = parts[0]; state.month = parts[1];
    state.stack = []; state.index = -1;
    fetch('/api/manifest?domain=' + encodeURIComponent(state.domain) + '&month=' + encodeURIComponent(state.month))
      .then(function (r) { return r.json(); })
      .then(function (m) {
        state.manifest = m;
        renderDays();
        var qs = new URLSearchParams(location.search);
        var wanted = qs.get('day');
        var day = (wanted && m.days.indexOf(wanted) >= 0) ? wanted : m.days[0];
        var start = entryPageFor(day);
        if (!start) { showEmpty('Nothing stored for ' + (day || state.month), 'This mirror has no pages to show.'); return; }
        go(start.route, true);
      })
      .catch(function (e) { toast('manifest error: ' + e.message); });
  }

  /** The most likely entry point for a day: shallowest, then shortest URL. */
  function entryPageFor(day) {
    var pages = (state.manifest.pages || []).filter(function (p) { return p.day === day; });
    if (!pages.length) return null;
    var qs = new URLSearchParams(location.search);
    var wantedRoute = qs.get('route');
    if (wantedRoute) {
      var exact = pages.filter(function (p) { return p.route === wantedRoute; })[0];
      if (exact) return exact;
    }
    return pages.slice().sort(function (a, b) {
      var da = (a.url.split('/').length), db = (b.url.split('/').length);
      if (da !== db) return da - db;
      return a.url.length - b.url.length;
    })[0];
  }

  function renderDays() {
    var wrap = $('days'); wrap.innerHTML = '';
    var m = state.manifest; if (!m) return;
    var counts = {};
    (m.pages || []).forEach(function (p) { counts[p.day] = (counts[p.day] || 0) + 1; });
    (m.days || []).forEach(function (day) {
      var b = document.createElement('button');
      b.className = 'day'; b.type = 'button';
      b.innerHTML = '<b>' + day.slice(8) + '</b><small>' + day.slice(5, 7) + ' \u00b7 ' +
        (counts[day] || 0) + 'p</small>';
      b.setAttribute('aria-current', String(day === state.day));
      b.onclick = function () {
        var first = entryPageFor(day);
        if (first) go(first.route, true);
        else toast('no pages stored for ' + day);
      };
      wrap.appendChild(b);
    });
  }

  // ── navigation ───────────────────────────────────────────────────────
  function go(route, push) {
    if (!route) return;
    var day = dayOf(route) || state.day;
    if (push) {
      state.stack = state.stack.slice(0, state.index + 1);
      state.stack.push(route);
      state.index = state.stack.length - 1;
    }
    state.route = route; state.day = day;
    state.dead = 0; state.flags = null;
    setChips(null);

    startProgress();
    var frame = $('frame');
    $('empty').hidden = true; frame.hidden = false;
    frame.src = route;

    var label = 'https://' + state.domain + decodeRoute(route);
    $('url').textContent = label; $('url').title = label;

    var qs = new URLSearchParams({ domain: state.domain, month: state.month, day: day, route: route });
    history.replaceState(null, '', location.pathname + '?' + qs.toString());
    renderDays(); setNav();
  }

  function showEmpty(title, body) {
    $('frame').hidden = true;
    var e = $('empty'); e.hidden = false;
    $('emptyTitle').textContent = title;
    $('emptyBody').textContent = body;
  }

  $('back').onclick = function () {
    if (state.index > 0) { state.index -= 1; go(state.stack[state.index], false); }
  };
  $('fwd').onclick = function () {
    if (state.index < state.stack.length - 1) { state.index += 1; go(state.stack[state.index], false); }
  };
  $('reload').onclick = function () { if (state.route) go(state.route, false); };
  $('open').onclick = function () {
    if (!state.route || !state.manifest) return;
    var page = (state.manifest.pages || []).filter(function (p) { return p.route === state.route; })[0];
    if (!page) { toast('no original capture recorded for this page'); return; }
    window.open('https://web.archive.org/web/' + page.ts + '/' + page.url, '_blank', 'noopener');
  };

  // Keyboard navigation, but never while the user is typing into the archived page.
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { $('back').click(); }
    else if (e.key === 'ArrowRight') { $('fwd').click(); }
    else if (e.key === 'r') { $('reload').click(); }
  });

  window.addEventListener('popstate', function () {
    var qs = new URLSearchParams(location.search);
    if (qs.get('route') && qs.get('route') !== state.route) go(qs.get('route'), false);
  });

  // ── report panel ─────────────────────────────────────────────────────
  $('stats').onclick = function () {
    var panel = $('panel');
    if (!panel.hidden) { panel.hidden = true; return; }
    var s = state.manifest && state.manifest.stats;
    if (!s) { toast('no ingest report for this mirror'); return; }
    panel.innerHTML = report(s);
    panel.hidden = false;
  };

  function rows(list) {
    return list.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>';
    }).join('');
  }
  function card(label, value, note) {
    return '<div class="card"><small>' + label + '</small><b>' + value + '</b><small>' + note + '</small></div>';
  }

  function report(s) {
    var h = '<h3>Ingest report</h3>';
    h += '<div class="grid2">'
      + card('pages stored', num(s.pages.rewritten), num(s.pages.fetched) + ' fetched, ' + num(s.pages.failed) + ' failed')
      + card('archive.org requests', num(s.ia.attempts), s.archiveRequestsPerPage + ' per page, ' + num(s.ia.throttled) + ' throttled')
      + card('wall clock', (s.wallClockMs / 1000).toFixed(1) + 's', s.wallClockPerPageMs + ' ms per page')
      + card('on disk', fmtBytes(s.storage.blobBytes), 'including verbatim originals')
      + '</div>';

    if (s.survey.degraded || s.survey.usedSeedFallback) {
      h += '<h3 style="color:var(--warn)">Survey was incomplete</h3><table>' + rows([
        ['reason', s.survey.degradedReason || 'seed-only fallback'],
        ['frontier', s.survey.frontierNote || 'not bootstrapped'],
      ]) + '</table>';
    }

    h += '<h3>The day policy</h3><table>' + rows([
      ['captures in the CDX index', num(s.survey.htmlRows)],
      ['pageloads ingested (one per day per URL)', num(s.pages.selected)],
      ['captures collapsed away', num(s.survey.capturesDiscarded)],
      ['distinct URLs in the month', num(s.survey.distinctUrls)],
      ['deferred to on-demand', num(s.pages.skippedByBudget)],
    ]) + '</table>';

    h += '<h3>Assets</h3><table>' + rows([
      ['asset references', num(s.assets.referenced)],
      ['unique assets stored', num(s.assets.uniqueStored)],
      ['bytes stored for assets', fmtBytes(s.assets.storedBytes)],
      ['bytes without dedupe', fmtBytes(s.assets.naiveBytes)],
      ['saved by dedupe', fmtBytes(s.assets.dedupeSavedBytes) + ' (' + (s.assets.dedupeRatio * 100).toFixed(1) + '%)'],
      ['shared by more than one page', num(s.assets.sharedAcrossPages)],
      ['unavailable', num(s.assets.failed + s.assets.missing)],
    ]) + '</table>';

    h += '<h3>Links</h3><table>' + rows([
      ['internal link edges', num(s.links.edges)],
      ['resolved to a stored capture', num(s.links.resolved)],
      ['same day', num(s.links.sameDay)],
      ['drifted to a nearby day', num(s.links.drifted) + ' (max ' + s.links.maxDriftDays + 'd)'],
      ['no capture in range', num(s.links.unresolved)],
    ]) + '</table>';

    // The page list doubles as the navigation fallback when the archived page's own
    // links are mostly unavailable.
    var pages = (state.manifest.pages || []);
    h += '<h3>Pages in this mirror (' + pages.length + ')</h3><div class="pagelist">';
    h += pages.map(function (p) {
      return '<a href="#" data-route="' + encodeURI(p.route).replace(/'/g, '%27') + '">' +
        (p.title ? escapeHtml(p.title) + ' ' : '') +
        '<small>' + p.day + ' \u00b7 ' + decodeRoute(p.route) + '</small></a>';
    }).join('');
    h += '</div>';

    if (s.failures && s.failures.length) {
      h += '<h3>Failures</h3><table><tr><th>URL</th><th>reason</th></tr>' +
        s.failures.map(function (f) {
          return '<tr><td style="word-break:break-all">' + escapeHtml(f.url) + '</td><td>' +
            escapeHtml(f.reason) + '</td></tr>';
        }).join('') + '</table>';
    }
    return h;
  }

  function escapeHtml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Page-list links inside the report panel.
  $('panel').addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-route]') : null;
    if (!a) return;
    e.preventDefault();
    go(decodeURI(a.getAttribute('data-route')), true);
  });

  // ── messages from the archived page ──────────────────────────────────
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__cw !== true) return;
    if (d.type === 'cw:ready') {
      state.flags = d.detail && d.detail.flags ? d.detail.flags : null;
      var ms = Date.now() - state.loadStart;
      finishProgress();
      if (state.flags && state.flags.deadLinks > 0) {
        // cw:dead-links carries the samples; this is just a fallback count.
      }
      if (ms > 1500) toast('loaded in ' + (ms / 1000).toFixed(1) + 's');
    } else if (d.type === 'cw:dead-links') {
      setChips(d.detail || {});
    } else if (d.type === 'cw:dead-request') {
      state.dead = (d.detail && d.detail.count) ? d.detail.count : state.dead + 1;
      setChips({ count: 0 });
    } else if (d.type === 'cw:error') {
      state.errors += 1;
    }
  });

  // ── archived-page link interception ──────────────────────────────────
  var frameEl = $('frame');
  frameEl.addEventListener('load', function () {
    // A load event can fire for about:blank or the initial about:blank document.
    if (!state.busy && !state.route) return;
    finishProgress();
    try {
      var doc = frameEl.contentDocument;
      if (!doc) return;

      doc.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;

        var dead = a.getAttribute('data-cw-dead');
        if (dead) {
          e.preventDefault();
          toast('Not captured in this mirror: ' + decodeRoute('/' + dead.replace(/^https?:\/\/[^/]+/, '')) +
            ' \u2014 the ingest budget did not reach it.', 4200);
          return;
        }

        var href = a.getAttribute('href') || '';
        if (href.indexOf('/a/') !== 0) return; // external or anchor: leave alone
        e.preventDefault();
        go(href, true);
      }, true);

      // Keep the toolbar's day indicator honest when the page itself navigates.
      state.dead = 0;
    } catch (err) {
      // Same-origin is expected; if a browser refuses, the page's own links still work
      // and the toolbar simply keeps showing the last server-rendered route.
    }
    setNav();
  });

  setNav();
})();
</script>
</body>
</html>
`;
