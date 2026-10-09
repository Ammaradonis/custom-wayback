/**
 * Static UI for the local mirror. Shipped as a string so Phase 2 can reuse it as a
 * Worker template without a build step. Intentionally dependency-free: this is the
 * "does the mirror actually work in a browser" harness, not the final product shell
 * (that is the React PWA described in plan.md section 2.3).
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
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; }
  body {
    background:var(--bg); color:var(--fg); overflow:hidden; display:flex; flex-direction:column;
    font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Inter,system-ui,sans-serif;
    -webkit-text-size-adjust:100%; touch-action:manipulation;
  }
  header {
    display:flex; align-items:center; gap:8px; flex:0 0 auto; z-index:5;
    padding:8px 12px calc(8px); padding-top:calc(8px + env(safe-area-inset-top));
    background:color-mix(in srgb, var(--panel) 90%, transparent);
    backdrop-filter:blur(12px); border-bottom:1px solid var(--line);
  }
  .brand { font-weight:650; letter-spacing:-.01em; white-space:nowrap; }
  .brand span { color:var(--muted); font-weight:450; }
  select, button {
    font:inherit; color:var(--fg); background:var(--panel2); border:1px solid var(--line);
    border-radius:9px; padding:7px 10px; min-height:36px;
  }
  button { cursor:pointer; }
  button:hover { background:#222a33; }
  button.icon { padding:7px 11px; font-size:15px; line-height:1; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .url {
    flex:1 1 260px; min-width:0; font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--muted); background:#0e1216; border:1px solid var(--line); border-radius:9px;
    padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .days {
    display:flex; gap:6px; flex:0 0 auto; overflow-x:auto; padding:8px 12px;
    background:var(--panel); border-bottom:1px solid var(--line); -webkit-overflow-scrolling:touch;
  }
  .day {
    flex:0 0 auto; min-width:64px; text-align:center; padding:6px 8px; border-radius:10px;
    border:1px solid var(--line); background:var(--panel2); line-height:1.15;
  }
  .day b { display:block; font-size:13px; }
  .day small { color:var(--muted); font-size:10px; }
  .day[aria-current="true"] { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 18%,var(--panel2)); }
  main { flex:1 1 auto; min-height:0; position:relative; background:#fff; }
  iframe { border:0; width:100%; height:100%; display:block; background:#fff; }
  .empty { display:grid; place-content:center; gap:10px; text-align:center; padding:28px; color:var(--muted); }
  .empty h2 { color:var(--fg); margin:0; font-size:18px; }
  code { background:var(--panel2); padding:3px 7px; border-radius:6px; color:var(--fg); font-size:12px; }
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
  .toast {
    position:fixed; left:50%; transform:translateX(-50%); bottom:22px; z-index:40;
    background:var(--panel2); border:1px solid var(--line); color:var(--fg); font-size:12.5px;
    padding:9px 14px; border-radius:999px; opacity:0; pointer-events:none; transition:opacity .18s ease;
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
  <button class="icon" id="back" title="Back" aria-label="Back">&#8249;</button>
  <button class="icon" id="reload" title="Reload" aria-label="Reload">&#8635;</button>
  <button class="icon" id="open" title="Open the original capture on web.archive.org" aria-label="Open original">&#8599;</button>
  <button class="icon" id="stats" title="Ingest report" aria-label="Ingest report">&#8942;</button>
</header>
<div class="days" id="days"></div>
<main id="main">
  <div class="empty" id="empty">
    <h2>No mirror loaded yet</h2>
    <div>Run an ingest, then pick a site above.</div>
    <div><code>npm run crawl -- --domain=example.com --month=2024-01 --max-pages=25</code></div>
  </div>
  <iframe id="frame" hidden sandbox="allow-scripts allow-forms allow-popups" title="Archived page"></iframe>
</main>
<aside id="panel" hidden></aside>
<div class="toast" id="toast"></div>
<script>
(function () {
  var state = { domain:null, month:null, day:null, route:null, manifest:null, stack:[], dead:0, errors:0 };
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2800);
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

  fetch('/api/sites').then(function (r) { return r.json(); }).then(function (data) {
    var sel = $('site');
    if (!data.sites.length) return;
    data.sites.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.domain + '|' + s.month;
      o.textContent = s.domain + ' \u00b7 ' + s.month + ' (' + s.pages + ' pages, ' + s.days + ' days)';
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
    state.domain = parts[0]; state.month = parts[1]; state.stack = [];
    fetch('/api/manifest?domain=' + encodeURIComponent(state.domain) + '&month=' + encodeURIComponent(state.month))
      .then(function (r) { return r.json(); })
      .then(function (m) {
        state.manifest = m;
        renderDays();
        var qs = new URLSearchParams(location.search);
        var day = (qs.get('day') && m.days.indexOf(qs.get('day')) >= 0) ? qs.get('day') : m.days[0];
        var start = shortest(m.pages.filter(function (p) { return p.day === day; }));
        if (start) go(day, start.route, true);
        else toast('this month has no stored pages');
      })
      .catch(function (e) { toast('manifest error: ' + e.message); });
  }

  function shortest(list) {
    return list.slice().sort(function (a, b) { return a.url.length - b.url.length; })[0];
  }

  function renderDays() {
    var wrap = $('days'); wrap.innerHTML = '';
    var m = state.manifest; if (!m) return;
    var counts = {};
    m.pages.forEach(function (p) { counts[p.day] = (counts[p.day] || 0) + 1; });
    m.days.forEach(function (day) {
      var b = document.createElement('button');
      b.className = 'day'; b.type = 'button';
      b.innerHTML = '<b>' + day.slice(8) + '</b><small>' + day.slice(5, 7) + ' \u00b7 ' + (counts[day] || 0) + 'p</small>';
      b.setAttribute('aria-current', String(day === state.day));
      b.onclick = function () {
        var first = shortest(m.pages.filter(function (p) { return p.day === day; }));
        if (first) go(day, first.route, true); else toast('no pages stored for ' + day);
      };
      wrap.appendChild(b);
    });
  }

  function go(day, route, push) {
    state.day = day; state.route = route;
    var frame = $('frame');
    frame.hidden = false; $('empty').hidden = true;
    if (push && state.route) state.stack.push(route);
    frame.src = route;
    var label = 'https://' + state.domain + decodeRoute(route);
    $('url').textContent = label; $('url').title = label;
    var qs = new URLSearchParams({ domain: state.domain, month: state.month, day: day });
    history.replaceState(null, '', location.pathname + '?' + qs.toString());
    renderDays();
  }

  $('back').onclick = function () {
    if (state.stack.length > 1) {
      state.stack.pop();
      go(state.day, state.stack[state.stack.length - 1], false);
    } else toast('nothing to go back to in the mirror');
  };
  $('reload').onclick = function () { if (state.route) $('frame').src = state.route; };
  $('open').onclick = function () {
    if (!state.route || !state.manifest) return;
    var page = state.manifest.pages.filter(function (p) { return p.route === state.route; })[0];
    if (!page) return;
    window.open('https://web.archive.org/web/' + page.ts + '/' + page.url, '_blank', 'noopener');
  };
  $('stats').onclick = function () {
    var panel = $('panel');
    if (!panel.hidden) { panel.hidden = true; return; }
    var s = state.manifest && state.manifest.stats;
    if (!s) { toast('no ingest report for this mirror'); return; }
    panel.innerHTML = report(s);
    panel.hidden = false;
  };

  function rows(list) {
    return list.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="num">' + r[1] + '</td></tr>'; }).join('');
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
      h += '<h3 style="color:var(--warn)">Survey was incomplete</h3><table>'
        + rows([['reason', (s.survey.degradedReason || 'seed-only fallback')]]) + '</table>';
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
    h += '<h3>Page hygiene</h3><table>' + rows([
      ['tracking/ad scripts stubbed', num(s.pages.stubbedScripts)],
      ['scripts served locally', num(s.pages.keptScripts)],
      ['external links made safe', num(s.pages.externalLinks)],
      ['dead links marked', num(s.pages.deadLinksFound)],
    ]) + '</table>';
    h += '<h3>By day</h3><table><tr><th>day</th><th class="num">pages</th><th class="num">bytes</th></tr>'
      + s.byDay.map(function (d) {
          return '<tr><td>' + d.day + '</td><td class="num">' + d.pages + '</td><td class="num">' + fmtBytes(d.bytes) + '</td></tr>';
        }).join('') + '</table>';
    if (s.failures && s.failures.length) {
      h += '<h3>Failures</h3><table><tr><th>URL</th><th>reason</th></tr>'
        + s.failures.map(function (f) {
            return '<tr><td style="word-break:break-all">' + f.url + '</td><td>' + f.reason + '</td></tr>';
          }).join('') + '</table>';
    }
    return h;
  }

  function card(label, value, note) {
    return '<div class="card"><small>' + label + '</small><b>' + value + '</b><small>' + note + '</small></div>';
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__cw !== true) return;
    if (d.type === 'cw:dead-request') {
      state.dead++;
      if (state.dead === 1 || state.dead % 10 === 0) toast(state.dead + ' blocked/dead requests silenced');
    } else if (d.type === 'cw:error') {
      state.errors++;
    }
  });

  // In-mirror navigation: keep the day indicator and history in sync.
  $('frame').addEventListener('load', function () {
    try {
      var doc = $('frame').contentDocument;
      if (!doc) return;
      doc.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (href.indexOf('/a/') !== 0) return;
        e.preventDefault();
        var m = /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})\//.exec(href);
        go(m ? m[1] : state.day, href, true);
      }, true);
    } catch (err) { /* same-origin expected; if not, the page's own links still work */ }
  });
})();
</script>
</body>
</html>
`;
