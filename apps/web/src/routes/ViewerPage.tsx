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
 *  - Toast notifications for unavailable resources / errors from the iframe
 *  - Nearest-capture badge when the served day differs from requested
 *  - Dead-request counter via postMessage bridge
 *  - Share button (plan §15): mints a link for exactly the page on screen
 *  - Edge warming: the links the page reports, and any link the visitor hovers, are
 *    prepared at the edge before they are clicked (`warmRoutes`)
 *  - Rate-limit fallbacks: only when archive.org throttles a page, the reader's settings
 *    (lib/fallbacks.ts) open a stored copy from a nearby day or archive.org's own replay
 */

import { useLocation, useParams, useNavigate } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Home,
  Info,
  LifeBuoy,
  Package,
  RotateCw,
  Share2,
  X,
} from "lucide-react";
import { manifests, type ManifestPage } from "@/lib/api.js";
import {
  REPLAY_SANDBOX,
  replayUrl,
  routeOnDay,
  throttleDetail,
  useFallbackPrefs,
  type ThrottleDetail,
} from "@/lib/fallbacks.js";
import type { ShareTarget } from "@/components/ShareDialog.js";

/** Lazy: the viewer is the hot path, and sharing is a deliberate action. */
const ShareDialog = lazy(() =>
  import("@/components/ShareDialog.js").then((mod) => ({ default: mod.ShareDialog })),
);

/** Lazy for the same reason: opened on purpose, or from a rate-limit notice. */
const FallbackPanel = lazy(() =>
  import("@/components/FallbackPanel.js").then((mod) => ({ default: mod.FallbackPanel })),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface CwMessage {
  __cw: true;
  type:
    | "cw:dead-request"
    | "cw:error"
    | "cw:navigate"
    | "cw:links"
    | "cw:intent"
    | "cw:metadata"
    | "cw:ready"
    | "cw:failure"
    | "cw:throttled";
  detail?: unknown;
}

/**
 * Why what is on screen is not the viewer's own rendering of what was asked for, shown in
 * a bar above the page with what can be done about it. Every case starts with archive.org
 * refusing the Worker's request (HTTP 429).
 */
type FallbackNotice =
  /** The requested day was throttled, so the nearest stored copy is on screen instead. */
  | { kind: "stored"; requestedRoute: string; requestedDay: string; shownDay: string; detail: ThrottleDetail }
  /** archive.org's own replay of the requested page is on screen. */
  | { kind: "replay"; detail: ThrottleDetail }
  /** The page was throttled and both fallbacks are off: the reader picks. */
  | { kind: "throttled"; detail: ThrottleDetail }
  /** The page loaded, but archive.org throttled some of the files it uses. */
  | { kind: "files"; count: number; styles: number };

/** The `YYYY-MM-DD` of a viewer route. */
function dayOfRoute(route: string): string | null {
  return /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})/.exec(route)?.[1] ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Where archived pages are served from, when that is not this origin.
 *
 * With a separate frame origin (`apps/api/wrangler.frame.toml`) the iframe keeps
 * `allow-same-origin`: the archived page gets a real origin — its cookies, storage,
 * self-made frames and the browser cache all work as they did — and it is still walled
 * off from this app, because that origin is not this one. Without it, archived code runs
 * in an opaque origin here, which is the only safe way to run it on the app's own origin.
 */
const FRAME_ORIGIN = (() => {
  try {
    const configured = import.meta.env.VITE_FRAME_ORIGIN;
    if (!configured) return null;
    const origin = new URL(configured).origin;
    return origin !== window.location.origin ? origin : null;
  } catch {
    return null;
  }
})();

/**
 * The iframe's sandbox. On this origin, deliberately no `allow-same-origin` (plan.md §10):
 * archived code runs in an opaque origin, away from this app's session. It is granted only
 * when the frame is a different origin, which is the one case it is safe.
 * `allow-popups-to-escape-sandbox` lets an external link open the live site as an
 * ordinary tab rather than a sandboxed one with no storage. The Worker sends the same
 * flags as a CSP `sandbox` directive.
 */
const FRAME_SANDBOX = FRAME_ORIGIN
  ? "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  : "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** The URL the iframe loads for a viewer route. */
function frameUrl(route: string): string {
  return FRAME_ORIGIN ? `${FRAME_ORIGIN}${route}` : route;
}

/** The origin messages from the archived page arrive from: its own, or "null" when opaque. */
const FRAME_MESSAGE_ORIGIN = FRAME_ORIGIN ?? "null";

/** Hover-driven warms per page view: enough for real intent, not a sweep of the page. */
const MAX_INTENT_WARMS = 10;

/** Pages per warm request (the Worker's `WARM_LIMIT`), and the pause between batches. */
const WARM_BATCH = 2;
const WARM_BATCH_GAP_MS = 1500;

/**
 * Ask the edge to prepare pages before they are opened.
 *
 * The service worker cannot do this: a sandboxed iframe's navigations are not controlled
 * by it and its opaque origin has no HTTP cache, so a page prefetched into the browser
 * was never used. The edge cache is the one the iframe does read, so a warmed page opens
 * as an edge hit instead of an archive.org round trip. Fire-and-forget by design.
 */
function warmRoutes(routes: string[]): void {
  if (routes.length === 0) return;
  // To the origin that serves the frame, since that is whose edge cache it reads. A
  // plain-text body keeps the cross-origin form a simple request: no preflight, and no
  // response is needed.
  void fetch(frameUrl("/_cw/warm"), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ routes }),
    keepalive: true,
    ...(FRAME_ORIGIN ? { mode: "no-cors" as const } : {}),
  }).catch(() => undefined);
}

/** `/a/<domain>/<day>/<path>` → the original URL, for the address bar and the archive link. */
function originalUrlForRoute(route: string, domain: string): string {
  const match = /^\/a\/[^/]+\/\d{4}-\d{2}-\d{2}(\/[^#]*)?/.exec(route);
  let path = match?.[1] || "/";
  const queryAt = path.toLowerCase().indexOf("%3f");
  if (queryAt >= 0) {
    let query = path.slice(queryAt + 3);
    try {
      query = decodeURIComponent(query);
    } catch {
      // Shown as-is.
    }
    path = `${path.slice(0, queryAt) || "/"}?${query}`;
  }
  return `https://${domain}${path}`;
}

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
  // The route as navigated, still percent-encoded. Rebuilding it from the decoded params
  // turned a captured query (`/page%3Fid=7`) into a real `?id=7`, which the Worker
  // ignores, so the frame showed the page without its query.
  const routePath = useLocation().pathname;
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dayStripRef = useRef<HTMLDivElement>(null);
  const loadingFallbackRef = useRef<number | null>(null);
  const runtimeReadyRef = useRef(false);
  /** Routes already sent to the edge this session, so no page is warmed twice. */
  const warmedRef = useRef<Set<string>>(new Set());
  const intentWarmsRef = useRef(0);

  /** The page on screen: the address bar, Back, Share. */
  const [currentRoute, setCurrentRoute] = useState(routePath);
  /**
   * What the iframe was told to load. It differs from `currentRoute` after the frame
   * followed a redirect (samsung.com's `/` → `/us/`): the address catches up with the
   * page, and the frame is not reloaded to get there.
   */
  const [frameRoute, setFrameRoute] = useState(routePath);
  const currentRouteRef = useRef(routePath);
  /** Set when the route changed only to describe where the frame already is. */
  const syncedRouteRef = useRef<string | null>(null);
  const [navStack, setNavStack] = useState<string[]>([routePath]);
  const [deadCount, setDeadCount] = useState(0);
  const [lastBlockedRequest, setLastBlockedRequest] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [resolvedDay, setResolvedDay] = useState<string | null>(null);
  const [deltaDays, setDeltaDays] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadStage, setLoadStage] = useState("Finding archived page");
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);

  // ── Rate-limit fallbacks (lib/fallbacks.ts) ──
  const [fallbacks, setFallbacks] = useFallbackPrefs();
  /** Read by the message handler, which is not re-subscribed when the settings change. */
  const fallbacksRef = useRef(fallbacks);
  fallbacksRef.current = fallbacks;
  const [fallbacksOpen, setFallbacksOpen] = useState(false);
  /** archive.org's replay URL while it is on screen in place of the viewer's frame. */
  const [replay, setReplay] = useState<string | null>(null);
  const [notice, setNotice] = useState<FallbackNotice | null>(null);
  /**
   * Set just before the viewer moves itself to another route as a fallback, so the move
   * keeps the notice that explains it (and, for a replay, never loads the viewer's frame).
   */
  const fallbackMoveRef = useRef<{ route: string; notice: FallbackNotice; replay: string | null } | null>(null);
  /** At most one automatic move per navigation: a stored copy that fails cannot chain. */
  const autoMovedRef = useRef(false);
  /** `moveFrameTo`, for the message handler. */
  const moveFrameRef = useRef<((route: string, notice: FallbackNotice) => void) | null>(null);
  /**
   * Set while the frame shows a page it was moved to in place, so its `src` still names
   * the route before. The next navigation remounts the frame (`frameKey`): setting the
   * same `frameRoute` again would not load anything.
   */
  const frameMovedRef = useRef(false);
  const [frameKey, setFrameKey] = useState(0);
  /**
   * Failure pages already acted on, by their `id`. A failure page reports itself twice —
   * when it runs, and when asked on load — and the second report can come from a page the
   * frame has already left (same window, so `e.source` cannot tell them apart).
   */
  const handledFailuresRef = useRef<Set<string>>(new Set());

  // Keep currentRoute in sync when the route changes (e.g. day-strip click triggers a
  // navigate() which remounts with new params).
  useEffect(() => {
    const route = routePath;
    currentRouteRef.current = route;
    setCurrentRoute(route);
    if (syncedRouteRef.current === route) {
      // The frame is already showing this page; only the address had to catch up.
      syncedRouteRef.current = null;
      setNavStack((s) => (s.length > 0 ? [...s.slice(0, -1), route] : [route]));
      warmedRef.current.add(route);
      // …or is on its way there, moved in place as a fallback (`moveFrameTo`).
      const move = fallbackMoveRef.current;
      if (move && move.route === route) {
        fallbackMoveRef.current = null;
        setNotice(move.notice);
      }
      return;
    }
    setFrameRoute(route);
    if (frameMovedRef.current) {
      frameMovedRef.current = false;
      setFrameKey((key) => key + 1);
    }
    setNavStack((s) => {
      // Avoid duplicating the same route at the top of the stack.
      if (s[s.length - 1] === route) return s;
      return [...s, route];
    });
    setLoading(true);
    setLoadStage("Finding archived page");
    setDeadCount(0);
    setLastBlockedRequest(null);
    setResolvedDay(null);
    setDeltaDays(null);
    setSource(null);
    runtimeReadyRef.current = false;
    intentWarmsRef.current = 0;
    warmedRef.current.add(route);
    if (loadingFallbackRef.current !== null) {
      window.clearTimeout(loadingFallbackRef.current);
      loadingFallbackRef.current = null;
    }
    setViewerError(null);
    // A move the viewer made itself, as a fallback, keeps the notice that explains it.
    const move = fallbackMoveRef.current;
    fallbackMoveRef.current = null;
    if (move && move.route === route) {
      setNotice(move.notice);
      setReplay(move.replay);
      if (move.replay) setLoadStage("Loading archive.org's replay");
    } else {
      autoMovedRef.current = false;
      setNotice(null);
      setReplay(null);
    }
    return () => {
      if (loadingFallbackRef.current !== null) {
        window.clearTimeout(loadingFallbackRef.current);
        loadingFallbackRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePath]);

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
    /**
     * archive.org refused the Worker this page. Apply the reader's fallbacks in order:
     * the nearest stored copy, then archive.org's own replay, then just say so.
     */
    function handleThrottle(detail: ThrottleDetail) {
      const route = currentRouteRef.current;
      setLoading(false);
      const prefs = fallbacksRef.current;
      if (prefs.storedCopy && detail.nearestStoredDay && !autoMovedRef.current) {
        autoMovedRef.current = true;
        moveFrameRef.current?.(routeOnDay(route, detail.nearestStoredDay), {
          kind: "stored",
          requestedRoute: route,
          requestedDay: dayOfRoute(route) ?? day,
          shownDay: detail.nearestStoredDay,
          detail,
        });
        return;
      }
      if (prefs.replay) {
        setLoading(true);
        setLoadStage("Loading archive.org's replay");
        setReplay(replayUrl(detail.ts, detail.url));
        setNotice({ kind: "replay", detail });
        return;
      }
      setNotice({ kind: "throttled", detail });
    }

    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.origin !== FRAME_MESSAGE_ORIGIN) return;
      if (!e.data || (e.data as CwMessage).__cw !== true) return;
      const msg = e.data as CwMessage;
      if (msg.type === "cw:dead-request") {
        const detail = msg.detail as { why?: string } | null;
        if (detail?.why) setLastBlockedRequest(detail.why);
        setDeadCount((n) => {
          const next = n + 1;
          if (next === 1 || next % 10 === 0) showToast(`${next} archived resource${next === 1 ? "" : "s"} unavailable`);
          return next;
        });
      } else if (msg.type === "cw:metadata") {
        const detail = msg.detail as { source?: string | null; resolvedDay?: string | null; deltaDays?: number | null } | null;
        setSource(detail?.source ?? null);
        setResolvedDay(detail?.resolvedDay ?? null);
        setDeltaDays(typeof detail?.deltaDays === "number" ? detail.deltaDays : null);
        setLoadStage("Rendering archived page");
      } else if (msg.type === "cw:failure") {
        const failureId = (msg.detail as { id?: unknown } | null)?.id;
        if (typeof failureId === "string") {
          if (handledFailuresRef.current.has(failureId)) return;
          handledFailuresRef.current.add(failureId);
        }
        runtimeReadyRef.current = true;
        if (loadingFallbackRef.current !== null) {
          window.clearTimeout(loadingFallbackRef.current);
          loadingFallbackRef.current = null;
        }
        const throttle = throttleDetail(msg.detail);
        if (throttle) {
          handleThrottle(throttle);
          return;
        }
        const detail = msg.detail as { message?: string } | null;
        setViewerError(detail?.message ?? "The archived page could not be loaded. Try reloading.");
        setLoading(false);
      } else if (msg.type === "cw:throttled") {
        // The page loaded, but archive.org refused some of its files.
        const detail = msg.detail as { count?: unknown; styles?: unknown } | null;
        const count = typeof detail?.count === "number" ? detail.count : 0;
        const styles = typeof detail?.styles === "number" ? detail.styles : 0;
        if (count > 0) setNotice((current) => (current && current.kind !== "files" ? current : { kind: "files", count, styles }));
      } else if (msg.type === "cw:ready") {
        // A redirect inside the frame (a site's `/` → `/us/`, a missing page → the
        // nearest day) leaves the frame on another route: show that one, as a browser's
        // address bar would, without reloading the frame.
        const shown = (msg.detail as { path?: unknown } | null)?.path;
        if (typeof shown === "string" && shown.startsWith("/a/") && shown !== currentRouteRef.current) {
          syncedRouteRef.current = shown;
          navigate(shown, { replace: true });
        }
        runtimeReadyRef.current = true;
        if (loadingFallbackRef.current !== null) {
          window.clearTimeout(loadingFallbackRef.current);
          loadingFallbackRef.current = null;
        }
        setLoadStage("Page ready");
        setLoading(false);
      } else if (msg.type === "cw:navigate") {
        const detail = msg.detail as { url?: string; replace?: boolean };
        const url = detail?.url;
        if (url && url.startsWith(`/a/${domain}/`)) {
          // navigate() keeps React Router in sync; goRoute updates our local
          // state (nav stack, loading flag).
          const m = /^\/a\/[^/]+\/(\d{4}-\d{2}-\d{2})/.exec(url);
          goRoute(m?.[1] ?? day, url, detail.replace !== true);
        }
      } else if (msg.type === "cw:links") {
        // The page's top in-site links: its own navigation, usually the next click.
        const links = (msg.detail as { urls?: unknown })?.urls;
        if (Array.isArray(links)) {
          const fresh = links
            .filter((url): url is string => typeof url === "string" && url.startsWith("/a/"))
            .filter((url) => !warmedRef.current.has(url))
            .slice(0, 6);
          for (const url of fresh) warmedRef.current.add(url);
          // Small batches a moment apart rather than one burst: each warm request
          // prepares a couple of pages and what they need to paint (see `scheduleWarm`).
          for (let start = 0; start < fresh.length; start += WARM_BATCH) {
            const batch = fresh.slice(start, start + WARM_BATCH);
            const delay = (start / WARM_BATCH) * WARM_BATCH_GAP_MS;
            if (delay === 0) warmRoutes(batch);
            else window.setTimeout(() => warmRoutes(batch), delay);
          }
        }
      } else if (msg.type === "cw:intent") {
        // The visitor is hovering or touching a link: warm it while they decide.
        const url = (msg.detail as { url?: unknown })?.url;
        if (
          typeof url === "string" &&
          url.startsWith("/a/") &&
          !warmedRef.current.has(url) &&
          intentWarmsRef.current < MAX_INTENT_WARMS
        ) {
          intentWarmsRef.current += 1;
          warmedRef.current.add(url);
          warmRoutes([url]);
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  // The route params are explicit dependencies so this guard always uses the
  // current viewer domain and date. State setters and navigate are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, showToast, day, domain]);

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
    else setNavStack((s) => (s.length > 0 ? [...s.slice(0, -1), route] : [route]));
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

  function handleReload() {
    setViewerError(null);
    setLoading(true);
    runtimeReadyRef.current = false;
    if (loadingFallbackRef.current !== null) {
      window.clearTimeout(loadingFallbackRef.current);
      loadingFallbackRef.current = null;
    }
    // A stored copy is still a stored copy after a reload; anything else is retried.
    setNotice((current) => (current?.kind === "stored" ? current : null));
    if (replay) {
      // Back to the viewer: its frame mounts again and loads the page itself.
      setReplay(null);
      setLoadStage("Finding archived page");
      return;
    }
    // One navigation either way: a changed `src` prop reloads the frame by itself.
    if (frameMovedRef.current) {
      frameMovedRef.current = false;
      setFrameRoute(currentRoute);
      setFrameKey((key) => key + 1);
    } else if (frameRoute !== currentRoute) setFrameRoute(currentRoute);
    else if (iframeRef.current) iframeRef.current.src = frameUrl(currentRoute);
  }

  /**
   * Show a stored copy instead of the page that could not be shown, as a replacement in
   * every history: `location.replace` moves the frame without the entry a new `src` would
   * add (Back would land on the failure), and the address is replaced to match.
   */
  function moveFrameTo(route: string, notice: FallbackNotice) {
    fallbackMoveRef.current = { route, replay: null, notice };
    syncedRouteRef.current = route;
    setLoading(true);
    setLoadStage("Opening the stored copy");
    runtimeReadyRef.current = false;
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow) {
      frameWindow.location.replace(frameUrl(route));
      frameMovedRef.current = true;
    } else {
      // No frame to move: the route change below loads it.
      syncedRouteRef.current = null;
    }
    navigate(route, { replace: true });
  }
  moveFrameRef.current = moveFrameTo;

  /** Fallback 2 on request: archive.org's replay of this page, in place of the frame. */
  function showReplay(detail: ThrottleDetail) {
    setLoading(true);
    setLoadStage("Loading archive.org's replay");
    setReplay(replayUrl(detail.ts, detail.url));
    setNotice({ kind: "replay", detail });
  }

  /** Fallback 1 on request: the nearest stored copy of this page. */
  function openStoredCopy(detail: ThrottleDetail) {
    if (!detail.nearestStoredDay) return;
    moveFrameTo(routeOnDay(currentRoute, detail.nearestStoredDay), {
      kind: "stored",
      requestedRoute: currentRoute,
      requestedDay: day,
      shownDay: detail.nearestStoredDay,
      detail,
    });
  }

  /** From a stored copy, archive.org's replay of the day that was actually asked for. */
  function replayRequestedDay(stored: Extract<FallbackNotice, { kind: "stored" }>) {
    fallbackMoveRef.current = {
      route: stored.requestedRoute,
      replay: replayUrl(stored.detail.ts, stored.detail.url),
      notice: { kind: "replay", detail: stored.detail },
    };
    navigate(stored.requestedRoute);
  }

  /** The page on screen as a replay request, for a page whose files were throttled. */
  function currentPageCapture(): ThrottleDetail {
    const page = manifest?.pages.find((p) => p.route === currentRoute);
    return {
      url: page?.url ?? originalUrlForRoute(currentRoute, domain),
      ts: page?.ts ?? `${(resolvedDay ?? day).replace(/-/g, "")}120000`,
      nearestStoredDay: null,
      nearestStoredPrecrawled: false,
    };
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
    // Pages opened on demand are not in the crawl manifest; the archive resolves the
    // day itself, so the route is enough.
    const page = manifest?.pages.find((p) => p.route === currentRoute);
    const stamp = page?.ts ?? `${(resolvedDay ?? day).replace(/-/g, "")}120000`;
    const url = page?.url ?? originalUrlForRoute(currentRoute, domain);
    window.open(`https://web.archive.org/web/${stamp}/${url}`, "_blank", "noopener");
  }

  /** What a browser's address bar would show: the original URL, not our route. */
  const urlLabel = (() => {
    try {
      const page = manifest?.pages.find((p) => p.route === currentRoute);
      return page ? `https://${domain}${new URL(page.url).pathname}` : originalUrlForRoute(currentRoute, domain);
    } catch {
      return currentRoute;
    }
  })();

  const days = manifest?.days ?? [];
  const pageCountByDay = manifest?.pages.reduce<Record<string, number>>((acc, p) => {
    acc[p.day] = (acc[p.day] ?? 0) + 1;
    return acc;
  }, {}) ?? {};

  /**
   * The month has a manifest but no pages in it.
   *
   * This is the state the app was actually in for months, and it rendered as an empty
   * iframe: the viewer asked the server for a page that was never captured, got a 404
   * body, and showed it inside a frame with no explanation. A blank screen reads as
   * "the app is broken"; the truth is "this month has not been crawled, or its crawl
   * stored nothing", and those are different sentences.
   *
   * So an empty month gets a designed state with the two things that resolve it: the
   * month that *does* have pages (if any), and a way back.
   */
  const monthIsEmpty = manifest !== undefined && manifest.pages.length === 0;
  const otherMonthWithPages = manifest?.days?.[0] ?? null;

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
          <span className="text-[10px] text-muted-foreground animate-pulse" role="status" title={loadStage}>
            <span aria-hidden>…</span>
            <span className="ml-1 hidden max-w-[7rem] truncate sm:inline">{loadStage}</span>
            <span className="sr-only">{loadStage}</span>
          </span>
        )}
        {deadCount > 0 && (
          <span
            className="text-[10px] tabular-nums text-warning-foreground"
            title={lastBlockedRequest ? `Last unavailable resource: ${lastBlockedRequest}` : "An archived resource failed to load"}
            aria-label={`${deadCount} archived resources failed to load`}
          >
            {deadCount} unavailable
          </span>
        )}

        <button
          type="button"
          onClick={handleReload}
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
          onClick={() => {
            setStatsOpen(false);
            setFallbacksOpen((open) => !open);
          }}
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label="When archive.org is rate-limiting"
          aria-expanded={fallbacksOpen}
          title="When archive.org is rate-limiting"
        >
          <LifeBuoy className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            setFallbacksOpen(false);
            setStatsOpen((s) => !s);
          }}
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

      {/* ── Rate-limit notice: what is on screen instead, and what to do about it ── */}
      {notice && !monthIsEmpty && (
        <div
          role="status"
          className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs"
        >
          <p className="min-w-0 flex-1 basis-64">
            {notice.kind === "stored" &&
              `archive.org is rate-limiting the viewer, so this is the ${notice.detail.nearestStoredPrecrawled ? "pre-crawled" : "stored"} copy from ${notice.shownDay} instead of ${notice.requestedDay}.`}
            {notice.kind === "replay" &&
              "archive.org is rate-limiting the viewer, so this page is archive.org's own replay. archive.org sees your IP address, and the viewer's links, prefetching and caching are off on it."}
            {notice.kind === "throttled" &&
              "archive.org is rate-limiting the viewer and refused this page. You can show it another way, or wait a minute and try again."}
            {notice.kind === "files" &&
              `archive.org rate-limited ${notice.count} of this page's files${notice.styles > 0 ? ", including its styles" : ""}, so parts of it may be missing.`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {notice.kind === "stored" && (
              <>
                <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={() => navigate(notice.requestedRoute)}>
                  Try {notice.requestedDay} again
                </button>
                {fallbacks.replay && (
                  <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={() => replayRequestedDay(notice)}>
                    Replay {notice.requestedDay} from archive.org
                  </button>
                )}
              </>
            )}
            {notice.kind === "replay" && (
              <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={handleReload}>
                Try the viewer again
              </button>
            )}
            {notice.kind === "throttled" && (
              <>
                {notice.detail.nearestStoredDay && (
                  <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={() => openStoredCopy(notice.detail)}>
                    Open the copy from {notice.detail.nearestStoredDay}
                  </button>
                )}
                <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={() => showReplay(notice.detail)}>
                  Show archive.org's replay
                </button>
                <button type="button" className="cw-btn cw-btn-ghost px-3 text-xs" onClick={handleReload}>
                  Try again
                </button>
              </>
            )}
            {notice.kind === "files" && (
              <>
                <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={handleReload}>
                  Reload
                </button>
                <button type="button" className="cw-btn cw-btn-secondary px-3 text-xs" onClick={() => showReplay(currentPageCapture())}>
                  Show archive.org's replay
                </button>
              </>
            )}
            <button
              type="button"
              className="cw-btn cw-btn-ghost px-3 text-xs"
              onClick={() => {
                setStatsOpen(false);
                setFallbacksOpen(true);
              }}
            >
              Settings
            </button>
          </div>
        </div>
      )}

      {/* ── iframe, or a designed empty state ── */}
      <div className="flex-1 relative min-h-0">
        {monthIsEmpty ? (
          <div className="absolute inset-0 flex items-center justify-center overflow-auto p-6">
            <div className="cw-panel max-w-md space-y-3 p-6 text-sm">
              <h2 className="text-base font-semibold">
                {domain} has nothing stored for {month || day}
              </h2>
              <p className="text-muted-foreground">
                The month exists in the ledger, but no page was captured for it. That
                usually means the crawl could not get HTML for this month — the Internet
                Archive has no capture in it, or its wide index query was refused.
              </p>
              {manifest?.note && (
                <p className="text-warning-foreground">{manifest.note}</p>
              )}
              <p className="text-muted-foreground">
                Start the crawl for this month from the dashboard, or pick a month whose
                calendar shows captures.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="cw-btn cw-btn-primary"
                >
                  Back to dashboard
                </button>
                {otherMonthWithPages && otherMonthWithPages !== day && (
                  <button
                    type="button"
                    onClick={() => navigate(`/a/${domain}/${otherMonthWithPages}/`)}
                    className="cw-btn cw-btn-secondary"
                  >
                    Try {otherMonthWithPages}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {loading && (
              <div
                className="cw-progress-track absolute inset-x-0 top-0 z-10 h-1 rounded-none"
                role="progressbar"
                aria-label="Archived page loading progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={loadStage}
              >
                <div className="cw-progress-fill cw-progress-fill-indeterminate" />
              </div>
            )}
            {viewerError && (
              <div
                className="cw-overlay overlay-shadow absolute inset-x-4 top-4 z-20 mx-auto max-w-md rounded-xl p-4 text-sm"
                role="alert"
              >
                <p>{viewerError}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="cw-btn cw-btn-secondary"
                    onClick={handleReload}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="cw-btn cw-btn-ghost"
                    onClick={() => navigate("/")}
                  >
                    Dashboard
                  </button>
                </div>
              </div>
            )}
            {replay ? (
              // Fallback 2: archive.org's own replay. A separate element (`key`), so the
              // sandbox it starts with is its own; no referrer, so archive.org is not
              // told which page of this app sent the reader.
              <iframe
                key="replay"
                src={replay}
                title={`archive.org replay: ${domain} on ${day}`}
                sandbox={REPLAY_SANDBOX}
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full border-0 bg-white"
                onLoad={() => {
                  setLoadStage("Page ready");
                  setLoading(false);
                }}
              />
            ) : (
              <iframe
                key={`viewer-${frameKey}`}
                ref={iframeRef}
                src={frameUrl(frameRoute)}
                title={`Archived: ${domain} on ${day}`}
                sandbox={FRAME_SANDBOX}
                className="absolute inset-0 w-full h-full border-0 bg-white"
                onLoad={() => {
                  if (!runtimeReadyRef.current) {
                    if (loadingFallbackRef.current !== null) window.clearTimeout(loadingFallbackRef.current);
                    loadingFallbackRef.current = window.setTimeout(() => {
                      loadingFallbackRef.current = null;
                      setLoading(false);
                    }, 1200);
                  }
                  // Re-request these messages in case a very fast cached page posted
                  // before React attached its message listener.
                  const frameWindow = iframeRef.current?.contentWindow;
                  if (frameWindow) {
                    frameWindow.postMessage({ __cw: true, type: "cw:request-metadata" }, "*");
                    frameWindow.postMessage({ __cw: true, type: "cw:request-failure" }, "*");
                    // The iframe is sandboxed without allow-same-origin, so
                    // contentDocument is always null. The runtime reports its top
                    // in-site links when the page is interactive; ask again in case
                    // that message arrived before this listener did.
                    frameWindow.postMessage({ __cw: true, type: "cw:request-links" }, "*");
                    frameWindow.postMessage({ __cw: true, type: "cw:request-throttled" }, "*");
                  }
                }}
              />
            )}
          </>
        )}
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
                Pages a cloud crawl stored are deleted from R2 storage after they are
                served (storage-cost strategy); pre-crawled pages are kept. The ledger
                row is kept so navigation still works.
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

      {/* ── Rate-limit fallbacks ── */}
      {fallbacksOpen && (
        <Suspense fallback={null}>
          <FallbackPanel
            domain={domain}
            month={month}
            prefs={fallbacks}
            onChange={setFallbacks}
            onClose={() => setFallbacksOpen(false)}
          />
        </Suspense>
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
