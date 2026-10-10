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
 *  - Share button (plan §15): mints a link for exactly the page on screen
 */

import { useParams, useNavigate } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Home,
  Info,
  Package,
  RotateCw,
  Share2,
  X,
} from "lucide-react";
import { manifests, type ManifestPage } from "@/lib/api.js";
import type { ShareTarget } from "@/components/ShareDialog.js";

/** Lazy: the viewer is the hot path, and sharing is a deliberate action. */
const ShareDialog = lazy(() =>
  import("@/components/ShareDialog.js").then((mod) => ({ default: mod.ShareDialog })),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface CwMessage {
  __cw: true;
  type: "cw:dead-request" | "cw:error" | "cw:navigate" | "cw:links";
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

/**
 * The URL of the page currently on screen, for a share link.
 *
 * The manifest is the authority — it is the same list the viewer navigates by — so
 * a match by route gives the exact captured URL. The fallback (domain + path) is
 * used while the manifest is still loading; worst case the link scopes to the day
 * rather than a single page, which the dialog says out loud.
 */
function pageUrlForRoute(
  pages: ManifestPage[],
  route: string,
  domain: string,
): string | null {
  const match = pages.find((p) => p.route === route);
  if (match) return match.url;

  try {
    const parsed = new URL(route, `https://${domain}`);
    return `https://${domain}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ViewerPage() {
  const { domain = "", day = "" } = useParams<{ domain: string; day: string }>();
  const wildcard = useParams()["*"] ?? "";
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dayStripRef = useRef<HTMLDivElement>(null);

  const [currentRoute, setCurrentRoute] = useState(`/a/${domain}/${day}/${wildcard}`);
  const [navStack, setNavStack] = useState<string[]>([`/a/${domain}/${day}/${wildcard}`]);
  const [deadCount, setDeadCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [resolvedDay, setResolvedDay] = useState<string | null>(null);
  const [deltaDays, setDeltaDays] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);

  // Keep currentRoute in sync when React Router params change (e.g. day-strip click
  // triggers a navigate() which remounts with new params).
  useEffect(() => {
    const route = `/a/${domain}/${day}/${wildcard}`;
    setCurrentRoute(route);
    setNavStack((s) => {
      // Avoid duplicating the same route at the top of the stack.
      if (s[s.length - 1] === route) return s;
      return [...s, route];
    });
    setLoading(true);
    // Fetch toolbar headers for the new route so the resolved-day badge and
    // source indicator update correctly. This is a HEAD request — no body, cheap.
    void fetch(route, { method: "HEAD" }).then((r) => {
      setResolvedDay(r.headers.get("X-Wayback-Resolved-Day"));
      const dd = r.headers.get("X-Wayback-Delta-Days");
      setDeltaDays(dd ? parseInt(dd, 10) : null);
      setSource(r.headers.get("X-Custom-Wayback-Source"));
    }).catch(() => void 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, day, wildcard]);

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
        if (url && url.startsWith("/a/")) {
          // navigate() keeps React Router in sync; goRoute updates our local
          // state (nav stack, loading flag).
          const m = /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})/.exec(url);
          goRoute(m?.[1] ?? day, url, true);
        }
      } else if (msg.type === "cw:links") {
        // Runtime sent back its top in-site links for SW prefetch.
        const links = (msg.detail as { urls?: string[] })?.urls;
        if (
          Array.isArray(links) &&
          links.length > 0 &&
          "serviceWorker" in navigator &&
          navigator.serviceWorker.controller
        ) {
          navigator.serviceWorker.controller.postMessage({
            type: "PREFETCH",
            urls: links.slice(0, 8),
          });
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  // goRoute is defined in the same render scope; including it would cause
  // the listener to be re-registered on every render. It reads only stable
  // refs (navigate, setNavStack) so the stale-closure risk is negligible.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, showToast, day]);

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
    // Navigate via React Router so the address bar, history stack and component
    // URL state stay in sync. Do NOT also call window.history.replaceState — that
    // desynchronises React Router's internal history and breaks the back button.
    navigate(route, { replace: !push });
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
    <div className="flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* ── Header ──
        * Rendered on tokens rather than the hardcoded `#0b0d10`/`#e7eaee` pair it
        * used to carry, so the viewer participates in the light theme instead of
        * staying a dark island inside a white app. */}
      <header
        className="z-10 flex flex-none flex-wrap items-center gap-1.5 border-b border-border bg-card px-3 py-2"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <button
          type="button"
          onClick={() => navigate("/")}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Back to dashboard"
          title="Back to dashboard"
        >
          <Home className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={handleBack}
          disabled={navStack.length <= 1}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Back"
          title="Back within this mirror"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>

        <span className="max-w-[9rem] truncate text-sm font-semibold">{domain}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{day}</span>

        {resolvedDay && resolvedDay !== day && (
          <span className="rounded border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs text-warning-foreground">
            → {resolvedDay}
            {deltaDays !== null && deltaDays !== 0 && (
              <span className="ml-1">
                ({deltaDays > 0 ? `+${deltaDays}` : deltaDays}d)
              </span>
            )}
          </span>
        )}

        <div
          className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-ellipsis whitespace-nowrap text-muted-foreground"
          title={urlLabel}
        >
          {urlLabel}
        </div>

        {source === "r2" && !loading && (
          <span className="text-[10px] text-muted-foreground" title="Served from R2 storage">
            <Package className="inline h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Served from R2 storage</span>
          </span>
        )}
        {source === "on-demand" && !loading && (
          <span className="text-[10px] text-muted-foreground" title="Fetched on demand">
            <Globe className="inline h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Fetched on demand</span>
          </span>
        )}
        {loading && (
          <span className="text-[10px] text-muted-foreground animate-pulse" role="status">
            <span aria-hidden>…</span>
            <span className="sr-only">Loading</span>
          </span>
        )}
        {deadCount > 0 && (
          <span className="text-[10px] tabular-nums text-warning-foreground">
            {deadCount} blocked
          </span>
        )}

        <button
          type="button"
          onClick={() => { if (iframeRef.current) iframeRef.current.src = currentRoute; }}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Reload"
          title="Reload"
        >
          <RotateCw className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={handleOpenWayback}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Open original on web.archive.org"
          title="Open original on web.archive.org"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
        </button>
        {/* Share exactly this page (plan §15). */}
        <button
          type="button"
          onClick={() => {
            const url = pageUrlForRoute(manifest?.pages ?? [], currentRoute, domain);
            setShareTarget({
              domain,
              month,
              day,
              ...(url ? { url } : {}),
            });
          }}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Share this page"
          title="Share this page"
        >
          <Share2 className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setStatsOpen((s) => !s)}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="Mirror stats"
          aria-expanded={statsOpen}
          title="Mirror stats"
        >
          <Info className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {/* ── Day strip ── */}
      {days.length > 0 && (
        <div
          ref={dayStripRef}
          className="scrollbar-none flex flex-none gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-2"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {days.map((d) => {
            const isActive = d === day;
            return (
              <button
                key={d}
                type="button"
                data-compact
                onClick={() => handleDayClick(d)}
                aria-current={isActive ? "true" : "false"}
                aria-label={`${d}, ${pageCountByDay[d] ?? 0} pages`}
                className={[
                  "min-w-[3.75rem] flex-none rounded-xl border px-2 py-1.5 text-center leading-tight transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                  isActive
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-ring hover:text-foreground",
                ].join(" ")}
              >
                <b className="block text-[13px] font-semibold tabular-nums">{d.slice(8)}</b>
                <small className="text-[10px] tabular-nums">
                  {d.slice(5, 7)} · {pageCountByDay[d] ?? 0}p
                </small>
              </button>
            );
          })}
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
            // The iframe is sandboxed without allow-same-origin, so
            // contentDocument is always null. Link interception and prefetch are
            // handled by the runtime script injected at ingest/on-demand time,
            // which uses postMessage to communicate back (cw:navigate, cw:dead-request).
            // Ask the runtime to send back the top in-site links for SW prefetch.
            if (
              "serviceWorker" in navigator &&
              navigator.serviceWorker.controller &&
              iframeRef.current?.contentWindow
            ) {
              iframeRef.current.contentWindow.postMessage(
                { __cw: true, type: "cw:request-links" },
                "*",
              );
            }
          }}
        />
      </div>

      {/* ── Stats panel ── */}
      {statsOpen && (
        <aside
          className="cw-overlay overlay-shadow fixed inset-x-0 bottom-0 z-20 max-h-[80vh] overflow-auto rounded-t-2xl border-b-0 p-4 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[27rem] md:rounded-none md:border-b md:border-l"
          style={{ paddingBottom: "calc(1.25rem + var(--sai-bottom))" }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Mirror stats</h2>
            <button
              type="button"
              onClick={() => setStatsOpen(false)}
              className="cw-btn cw-btn-ghost cw-btn-icon"
              aria-label="Close stats"
            >
              <X className="h-4 w-4" aria-hidden />
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
                  <div key={k} className="rounded-xl border border-border bg-background p-3">
                    <small className="cw-label">{k}</small>
                    <b className="block text-lg tabular-nums">{v}</b>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Pages are deleted from R2 storage after they are served (storage-cost
                strategy). The ledger row is kept so navigation still works.
              </p>
              {manifest.note && (
                <p className="text-xs text-warning-foreground">{manifest.note}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading manifest…</p>
          )}
        </aside>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="cw-overlay overlay-shadow pointer-events-none fixed bottom-5 left-1/2 z-40 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full px-4 py-2 text-xs"
        >
          {toast}
        </div>
      )}

      {/* ── Share links (plan §15) ── */}
      {shareTarget && (
        <Suspense fallback={null}>
          <ShareDialog
            open
            onOpenChange={(next) => {
              if (!next) setShareTarget(null);
            }}
            target={shareTarget}
          />
        </Suspense>
      )}
    </div>
  );
}
