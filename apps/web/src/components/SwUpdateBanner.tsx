/**
 * SwUpdateBanner — shows a non-blocking banner when a new service worker is
 * waiting to activate.
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
      className="cw-overlay overlay-shadow fixed left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-full py-2 pr-2 pl-4 text-sm"
      style={{ bottom: "calc(1rem + var(--sai-bottom))" }}
    >
      <span className="min-w-0 flex-1 truncate">App updated</span>
      <button
        type="button"
        data-compact
        onClick={() => void updateServiceWorker(true)}
        className="cw-btn cw-btn-primary h-8 min-h-8 flex-none rounded-full px-3 text-xs"
      >
        Reload
      </button>
      <button
        type="button"
        data-compact
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        className="cw-btn cw-btn-ghost cw-btn-icon h-8 min-h-8 w-8 min-w-8 flex-none rounded-full"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
