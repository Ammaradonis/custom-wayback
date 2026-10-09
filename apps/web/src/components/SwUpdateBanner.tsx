/**
 * SwUpdateBanner — shows a non-blocking banner when a new service worker is
 * waiting to activate.
 */

import { useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

export function SwUpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      // Store the registration so the visibilitychange handler below can call
      // r.update(). We do NOT add the listener here to avoid creating a new
      // closure on every registration (leaks on hot-reload and strict-mode
      // double-invocation).
      registrationRef.current = r ?? null;
    },
  });

  // Stable ref to the SW registration — never triggers re-renders.
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  // Force SW update check when the user comes back to the tab.
  // Added once; uses the ref so it always sees the current registration.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        void registrationRef.current?.update();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (needRefresh) setDismissed(false);
  }, [needRefresh]);

  if (!needRefresh || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full border border-border bg-background/95 backdrop-blur-sm px-4 py-2.5 shadow-2xl text-sm"
      style={{ bottom: "calc(1rem + var(--sai-bottom))" }}
    >
      <span className="text-foreground">App updated</span>
      <button
        onClick={() => void updateServiceWorker(true)}
        className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground hover:opacity-90 transition-opacity"
      >
        Reload
      </button>
      <button
        data-compact
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground transition-colors w-6 h-6 flex items-center justify-center rounded-full"
      >
        ✕
      </button>
    </div>
  );
}
