/**
 * Archive viewer page.
 *
 * URL: /a/:domain/:day/*
 *
 * Shows the archived page in a sandboxed iframe. A floating toolbar gives:
 *  - Day scrubber (◀ prev day / next day ▶)
 *  - "Open in Wayback" link
 *  - Nearest-capture badge ("→ Mar 27") when the served day differs from requested
 *  - Per-page load indicator
 *
 * The iframe src points to the Worker viewer route which handles caching + rewriting.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";

export default function ViewerPage() {
  const { domain, day } = useParams<{ domain: string; day: string }>();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [resolvedDay, setResolvedDay] = useState<string | null>(null);
  const [deltaDays, setDeltaDays] = useState<number | null>(null);
  const [source, setSource] = useState<string>("—");

  const path = window.location.pathname.replace(`/a/${domain ?? ""}/${day ?? ""}`, "") || "/";
  const viewerSrc = `/a/${domain ?? ""}/${day ?? ""}${path}`;

  // Listen for toolbar messages from the iframe (postMessage bridge).
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as Record<string, unknown>;
      if (data["type"] === "cw:navigate") {
        const url = String(data["url"] ?? "");
        if (url) navigate(url);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [navigate]);

  function stepDay(delta: number) {
    const base = new Date(day ?? "");
    base.setDate(base.getDate() + delta);
    const next = base.toISOString().slice(0, 10);
    navigate(`/a/${domain ?? ""}/${next}${path}`);
  }

  const waybackUrl = `https://web.archive.org/web/*/${domain ?? ""}${path}`;

  return (
    <div className="flex flex-col min-h-dvh bg-background">
      {/* Toolbar */}
      <header
        className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/90 px-3 py-2 backdrop-blur-sm flex-wrap"
        style={{ paddingTop: "calc(0.5rem + var(--sai-top))" }}
      >
        <button
          onClick={() => navigate("/")}
          className="h-9 rounded px-2 text-sm text-muted-foreground hover:text-foreground"
          aria-label="Back to dashboard"
        >
          ← Dashboard
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => stepDay(-1)}
            className="h-9 w-9 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Previous day"
          >
            ◀
          </button>
          <span className="text-sm font-medium tabular-nums min-w-[7rem] text-center">
            {day ?? "—"}
          </span>
          <button
            onClick={() => stepDay(1)}
            className="h-9 w-9 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Next day"
          >
            ▶
          </button>
        </div>

        <span className="text-sm font-medium text-muted-foreground truncate max-w-[10rem]">
          {domain}
        </span>

        {resolvedDay && resolvedDay !== day && (
          <span className="rounded bg-yellow-900/40 px-2 py-0.5 text-xs text-yellow-300">
            → {resolvedDay}
            {deltaDays !== null && deltaDays !== 0 && (
              <span className="ml-1 text-yellow-500">({deltaDays > 0 ? `+${deltaDays}` : deltaDays} d)</span>
            )}
          </span>
        )}

        {loading && (
          <span className="ml-auto text-xs text-muted-foreground animate-pulse">Loading…</span>
        )}

        {source !== "—" && !loading && (
          <span className="ml-auto text-xs text-muted-foreground">
            {source === "r2" ? "📦 cached" : source === "on-demand" ? "🌐 live fetch" : ""}
          </span>
        )}

        <a
          href={waybackUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto h-9 rounded px-3 text-xs text-muted-foreground hover:text-foreground border border-border flex items-center"
        >
          Open in Wayback ↗
        </a>
      </header>

      {/* Archive iframe */}
      <div className="flex-1 relative">
        <iframe
          ref={iframeRef}
          src={viewerSrc}
          title={`Archived: ${domain} on ${day ?? ""}`}
          sandbox="allow-scripts allow-forms allow-popups"
          className="absolute inset-0 w-full h-full border-0"
          onLoad={(e) => {
            setLoading(false);
            // Try to read custom headers from the response via a HEAD fetch.
            void fetch(viewerSrc, { method: "HEAD" }).then((r) => {
              const rd = r.headers.get("X-Wayback-Resolved-Day");
              const dd = r.headers.get("X-Wayback-Delta-Days");
              const src = r.headers.get("X-Custom-Wayback-Source");
              if (rd) setResolvedDay(rd);
              if (dd) setDeltaDays(parseInt(dd, 10));
              if (src) setSource(src);
            }).catch(() => void 0);
          }}
          onError={() => setLoading(false)}
        />
      </div>
    </div>
  );
}
