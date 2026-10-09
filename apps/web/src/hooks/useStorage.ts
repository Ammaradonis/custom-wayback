/**
 * useStorage — reads navigator.storage.estimate() and the SW's archive-cache size.
 *
 * Returns:
 *   quota        — total storage quota granted by the browser (bytes)
 *   usage        — total storage used by this origin (bytes)
 *   archiveBytes — bytes used by the archive LRU cache specifically
 *   archiveEntries — number of entries in the archive cache
 *   isPersistent — whether the origin has persistent storage (won't be evicted)
 *   requestPersist — call this to request persistent storage (Android only)
 *   refresh      — re-read all numbers
 */

import { useState, useEffect, useCallback } from "react";

interface StorageInfo {
  quota: number | null;
  usage: number | null;
  archiveBytes: number;
  archiveEntries: number;
  isPersistent: boolean;
  requestPersist: () => Promise<void>;
  refresh: () => void;
}

export function useStorage(): StorageInfo {
  const [quota, setQuota] = useState<number | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const [archiveBytes, setArchiveBytes] = useState(0);
  const [archiveEntries, setArchiveEntries] = useState(0);
  const [isPersistent, setIsPersistent] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    // Read Storage API estimate.
    if ("storage" in navigator) {
      void navigator.storage.estimate().then((est) => {
        setQuota(est.quota ?? null);
        setUsage(est.usage ?? null);
      });
      void navigator.storage.persisted().then(setIsPersistent);
    }

    // Ask SW for archive cache size via postMessage.
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      const handler = (ev: MessageEvent) => {
        const data = ev.data as { type?: string; bytes?: number; entries?: number };
        if (data.type === "CACHE_ESTIMATE_RESULT") {
          setArchiveBytes(data.bytes ?? 0);
          setArchiveEntries(data.entries ?? 0);
        }
      };
      navigator.serviceWorker.addEventListener("message", handler);
      navigator.serviceWorker.controller.postMessage({ type: "CACHE_ESTIMATE" });
      return () => navigator.serviceWorker.removeEventListener("message", handler);
    }
  }, [tick]);

  const requestPersist = useCallback(async () => {
    if ("storage" in navigator && navigator.storage.persist) {
      const granted = await navigator.storage.persist();
      setIsPersistent(granted);
    }
  }, []);

  return { quota, usage, archiveBytes, archiveEntries, isPersistent, requestPersist, refresh };
}
