/**
 * Archive viewer page.
 *
 * URL: /a/:domain/:day/*
 *
 * Design matches the local viewer shell (viewer-html.ts) but rendered in React:
 *  - Sticky header: ← back, domain+day label, URL bar, open-in-wayback
 *  - Horizontal day-strip (scroll): one button per captured day, current highlighted
 *  - Full-height sandboxed iframe for the archived page
 *  - Stats slide-up panel (on "⋯" tap)
 *  - Toast notifications for blocked requests / errors from the iframe
 *  - Nearest-capture badge when the served day differs from requested
 *  - Dead-request counter via postMessage bridge
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { manifests, type ManifestPage } from "@/lib/api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CwMessage {
  __cw: true;
  type: "cw:dead-request" | "cw:error" | "cw:navigate";
  detail?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function shortestForDay(pages: ManifestPage[], day: string): ManifestPage | undefined {
  return pages
    .filter((p) => p.day === day)
    .sort((a, b) => a.url.length - b.url.length)[0];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ViewerPage() {
  const { domain = "", day = "" } = useParams<{ domain: string; day: string }>();
  const wildcard = useParams()["*"] ?? "";
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dayStripRef = useRef<HTMLDivElement>(null);

  const [currentRoute, setCurrentRoute] = useState(`/a/${domain}/${day}/${wildcard}`);
  const [navStack, setNavStack] = useState<string[]>([]);
  const [deadCount, setDeadCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [resolvedDay, setResolvedDay] = useState<string | null>(null);
  const [deltaDays, setDeltaDays] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Derive month from day.
  const month = day.slice(0, 7);

  const { data: manifest } = useQuery({
    queryKey: ["manifest", domain, month],
    queryFn: () => manifests.manifest(domain, month),
    enabled: Boolean(domain && month),
    staleTime: 1000 * 60 * 5,
  });

  // Toast helper.
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  // postMessage bridge from iframe.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || (e.data as CwMessage).__cw !== true) return;
      const msg = e.data as CwMessage;
      if (msg.type === "cw:dead-request") {
        setDeadCount((n) => {
          const next = n + 1;
          if (next === 1 || next % 10 === 0) showToast(`${next} blocked/dead requests silenced`);
          return next;
        });
      } else if (msg.type === "cw:navigate") {
        const url = (msg.detail as { url?: string })?.url;
        if (url) navigate(url);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate, showToast]);

  // Scroll active day into view in the day strip.
  useEffect(() => {
    const strip = dayStripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLButtonElement>('[aria-current="true"]');
    active?.scrollIntoView({ inline: "nearest", behavior: "smooth" });
  }, [day, manifest]);

  function goRoute(targetDay: string, route: string, push = true) {
    setLoading(true);
    setCurrentRoute(route);
    if (push) setNavStack((s) => [...s, route]);
    // Update the URL bar without a full React navigation (keeps the iframe mount).
    const newPath = route;
    window.history.replaceState(null, "", newPath);
    if (iframeRef.current) iframeRef.current.src = route;
    // Peek headers for source/resolved-day info.
    void fetch(route, { method: "HEAD" }).then((r) => {
      setResolvedDay(r.headers.get("X-Wayback-Resolved-Day"));
      const dd = r.headers.get("X-Wayback-Delta-Days");
      setDeltaDays(dd ? parseInt(dd, 10) : null);
      setSource(r.headers.get("X-Custom-Wayback-Source"));
    }).catch(() => void 0);
  }

  function handleDayClick(targetDay: string) {
    const page = shortestForDay(manifest?.pages ?? [], targetDay);
    if (page) {
      navigate(`${page.route}`);
    } else {
      showToast(`No pages stored for ${targetDay}`);
    }
  }

  function handleBack() {
    if (navStack.length > 1) {
      const newStack = navStack.slice(0, -1);
      setNavStack(newStack);
      const prev = newStack[newStack.length - 1]!;
      goRoute(day, prev, false);
    } else {
      showToast("Nothing to go back to in this mirror");
    }
  }

  function handleOpenWayback() {
    const page = manifest?.pages.find((p) => p.route === currentRoute);
    if (!page) return;
    window.open(`https://web.archive.org/web/${page.ts}/${page.url}`, "_blank", "noopener");
  }

  const urlLabel = (() => {
    try {
      const page = manifest?.pages.find((p) => p.route === currentRoute);
      return page ? `https://${domain}${new URL(page.url).pathname}` : currentRoute;
    } catch {
      return currentRoute;
    }
  })();

  const days = manifest?.days ?? [];
  const pageCountByDay = manifest?.pages.reduce<Record<string, number>>((acc, p) => {
    acc[p.day] = (acc[p.day] ?? 0) + 1;
    return acc;
  }, {}) ?? {};

  return (
    <div className="flex flex-col min-h-dvh bg-[#0b0d10] text-[#e7eaee] overflow-hidden">
      {/* ── Header ── */}
      <header
        className="flex items-center gap-2 flex-wrap flex-none z-10 px-3 py-2 border-b border-[#262c34] bg-[#14181d]/90 backdrop-blur-sm"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <button
          onClick={() => navigate("/")}
          className="h-9 min-w-9 rounded px-2 text-sm text-[#939cab] hover:text-[#e7eaee]"
          aria-label="Back to dashboard"
        >
          ‹
        </button>
        <button
          onClick={handleBack}
          disabled={navStack.length <= 1}
          className="h-9 min-w-9 rounded px-2 text-[15px] text-[#939cab] hover:text-[#e7eaee] disabled:opacity-30"
          aria-label="Back"
        >
          ←
        </button>

        <span className="text-sm font-semibold truncate max-w-[8rem]">{domain}</span>
        <span className="text-[#939cab] text-sm">{day}</span>

        {resolvedDay && resolvedDay !== day && (
          <span className="rounded bg-yellow-900/40 px-2 py-0.5 text-xs text-yellow-300">
            → {resolvedDay}
            {deltaDays !== null && deltaDays !== 0 && (
              <span className="text-yellow-500 ml-1">
                ({deltaDays > 0 ? `+${deltaDays}` : deltaDays}d)
              </span>
            )}
          </span>
        )}

        <div
          className="flex-1 min-w-0 rounded-lg border border-[#262c34] bg-[#0e1216] px-2 py-1.5 font-mono text-[11px] text-[#939cab] overflow-hidden text-ellipsis whitespace-nowrap"
          title={urlLabel}
        >
          {urlLabel}
        </div>

        {source === "r2" && !loading && (
          <span className="text-[10px] text-[#939cab]">📦</span>
        )}
        {source === "on-demand" && !loading && (
          <span className="text-[10px] text-[#939cab]">🌐</span>
        )}
        {loading && (
          <span className="text-[10px] text-[#939cab] animate-pulse">…</span>
        )}
        {deadCount > 0 && (
          <span className="text-[10px] text-yellow-500">{deadCount} blocked</span>
        )}

        <button
          onClick={() => { if (iframeRef.current) iframeRef.current.src = currentRoute; }}
          className="h-9 min-w-9 rounded px-2 text-base text-[#939cab] hover:text-[#e7eaee]"
          aria-label="Reload"
        >
          ↺
        </button>
        <button
          onClick={handleOpenWayback}
          className="h-9 min-w-9 rounded px-2 text-base text-[#939cab] hover:text-[#e7eaee]"
          aria-label="Open original on web.archive.org"
          title="Open original on web.archive.org"
        >
          ↗
        </button>
        <button
          onClick={() => setStatsOpen((s) => !s)}
          className="h-9 min-w-9 rounded px-2 text-base text-[#939cab] hover:text-[#e7eaee]"
          aria-label="Stats"
        >
          ⋯
        </button>
      </header>

      {/* ── Day strip ── */}
      {days.length > 0 && (
        <div
          ref={dayStripRef}
          className="flex gap-1.5 flex-none overflow-x-auto px-3 py-2 bg-[#14181d] border-b border-[#262c34] scrollbar-none"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {days.map((d) => (
            <button
              key={d}
              onClick={() => handleDayClick(d)}
              aria-current={d === day ? "true" : "false"}
              className={[
                "flex-none min-w-[60px] rounded-xl border px-2 py-1.5 text-center leading-tight transition-colors",
                d === day
                  ? "border-[#4c9aff] bg-[#4c9aff]/20 text-[#e7eaee]"
                  : "border-[#262c34] bg-[#1b2027] text-[#939cab] hover:text-[#e7eaee]",
              ].join(" ")}
            >
              <b className="block text-[13px] font-semibold">{d.slice(8)}</b>
              <small className="text-[10px]">
                {d.slice(5, 7)} · {pageCountByDay[d] ?? 0}p
              </small>
            </button>
          ))}
        </div>
      )}

      {/* ── iframe ── */}
      <div className="flex-1 relative min-h-0">
        <iframe
          ref={iframeRef}
          src={currentRoute}
          title={`Archived: ${domain} on ${day}`}
          sandbox="allow-scripts allow-forms allow-popups"
          className="absolute inset-0 w-full h-full border-0 bg-white"
          onLoad={() => {
            setLoading(false);
            // Wire in-iframe link clicks so day-strip stays in sync,
            // then prefetch the top 8 same-mirror links via the service worker.
            try {
              const doc = iframeRef.current?.contentDocument;
              if (!doc) return;

              // Click intercept for /a/ links.
              doc.addEventListener("click", (e: MouseEvent) => {
                const a = (e.target as Element)?.closest?.("a[href]");
                if (!a) return;
                const href = a.getAttribute("href") ?? "";
                if (!href.startsWith("/a/")) return;
                e.preventDefault();
                const m = /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})/.exec(href);
                const targetDay = m ? m[1]! : day;
                navigate(href);
                goRoute(targetDay, href, true);
              }, true);

              // SW prefetch: collect unique /a/ hrefs from the page, take top 8.
              const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href^='/a/']"))
                .map((a) => a.href)
                .filter((href, i, arr) => arr.indexOf(href) === i)
                .slice(0, 8);

              if (
                links.length > 0 &&
                "serviceWorker" in navigator &&
                navigator.serviceWorker.controller
              ) {
                navigator.serviceWorker.controller.postMessage({
                  type: "PREFETCH",
                  urls: links,
                });
              }
            } catch {
              // Cross-origin iframe: click intercept silently fails;
              // links work natively. Prefetch not possible cross-origin.
            }
          }}
        />
      </div>

      {/* ── Stats panel ── */}
      {statsOpen && (
        <aside
          className="fixed inset-x-0 bottom-0 z-20 max-h-[80vh] overflow-auto rounded-t-2xl border-t border-[#262c34] bg-[#14181d] p-4 shadow-2xl md:inset-y-0 md:right-0 md:left-auto md:w-[440px] md:max-h-none md:rounded-none md:border-t-0 md:border-l"
          style={{ paddingBottom: "calc(1.25rem + var(--sai-bottom))" }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm">Mirror stats</h2>
            <button
              onClick={() => setStatsOpen(false)}
              className="h-9 w-9 rounded text-[#939cab] hover:text-[#e7eaee]"
              aria-label="Close stats"
            >
              ✕
            </button>
          </div>
          {manifest ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                {[
                  ["Domain", manifest.domain],
                  ["Month", manifest.month],
                  ["Days with captures", String(manifest.days.length)],
                  ["Pages stored", String(manifest.pages.length)],
                  ["Pages served+purged", String(manifest.pages.filter((p) => p.purged).length)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-[#262c34] bg-[#1b2027] p-3">
                    <small className="text-[#939cab] text-[10px] uppercase tracking-wide">{k}</small>
                    <b className="block text-lg tabular-nums">{v}</b>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[#939cab]">
                Pages are deleted from R2 storage after they are served (storage-cost
                strategy). The ledger row is kept so navigation still works.
              </p>
              {manifest.note && (
                <p className="text-xs text-yellow-400">{manifest.note}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-[#939cab]">Loading manifest…</p>
          )}
        </aside>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 rounded-full border border-[#262c34] bg-[#1b2027] px-4 py-2 text-xs shadow-xl pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  );
}
