import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { domains, ingest, auth, clearToken, type DomainEntry } from "@/lib/api.js";

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [crawlMonth, setCrawlMonth] = useState(
    () => new Date().toISOString().slice(0, 7),
  );
  const [crawlDomainId, setCrawlDomainId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<Record<string, unknown> | null>(null);

  const { data: domainList = [], isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: domains.list,
  });

  const addDomain = useMutation({
    mutationFn: (rawInput: string) => domains.add(rawInput),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["domains"] });
      setAddInput("");
      setAddError(null);
    },
    onError: (err: Error) => setAddError(err.message),
  });

  const removeDomain = useMutation({
    mutationFn: (id: string) => domains.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  const startCrawl = useMutation({
    mutationFn: ({ domainId, month }: { domainId: string; month: string }) =>
      ingest.start(domainId, month),
    onSuccess: (data) => {
      setActiveJobId(data.id);
      setJobProgress(null);
      // Poll SSE for progress.
      const es = new EventSource(`/v1/jobs/${data.id}/events`);
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as Record<string, unknown>;
        setJobProgress(ev);
        if (ev["type"] === "done") {
          es.close();
          setActiveJobId(null);
          void qc.invalidateQueries({ queryKey: ["domains"] });
        }
      };
      es.onerror = () => { es.close(); setActiveJobId(null); };
    },
  });

  async function handleLogout() {
    try { await auth.logout(); } catch { /* ignore */ }
    clearToken();
    navigate("/login");
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-4 py-3 backdrop-blur-sm"
        style={{ paddingTop: "calc(0.75rem + var(--sai-top))" }}>
        <span className="font-semibold text-base">Custom Wayback</span>
        <button
          onClick={handleLogout}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-8 space-y-8">
        {/* Add domain */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Track a domain</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addDomain.mutate(addInput);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              placeholder="samsung.com or https://www.apple.com/iphone"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              className="flex-1 h-11 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="submit"
              disabled={addDomain.isPending}
              className="h-11 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground disabled:opacity-50"
            >
              Add
            </button>
          </form>
          {addError && <p className="text-sm text-red-400" role="alert">{addError}</p>}
        </section>

        {/* Domain list */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Tracked domains</h2>
          {isLoading && (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          )}
          {!isLoading && domainList.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No domains tracked yet. Add one above.
            </p>
          )}
          <ul className="space-y-2">
            {domainList.map((d: DomainEntry) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-lg border border-border p-3 gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{d.domain}</p>
                  {d.lastCrawledAt && (
                    <p className="text-xs text-muted-foreground">
                      Last crawled {new Date(d.lastCrawledAt * 1000).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="month"
                    value={crawlDomainId === d.id ? crawlMonth : crawlMonth}
                    onChange={(e) => {
                      setCrawlDomainId(d.id);
                      setCrawlMonth(e.target.value);
                    }}
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <button
                    onClick={() => startCrawl.mutate({ domainId: d.id, month: crawlMonth })}
                    disabled={startCrawl.isPending || activeJobId !== null}
                    className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
                  >
                    Crawl
                  </button>
                  <button
                    onClick={() => removeDomain.mutate(d.id)}
                    className="h-9 rounded-md px-3 text-sm text-muted-foreground hover:text-red-400"
                    aria-label={`Remove ${d.domain}`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Active job progress */}
        {activeJobId && (
          <section className="rounded-lg border border-border p-4 space-y-3">
            <h2 className="font-semibold text-sm">Crawl in progress…</h2>
            {jobProgress && (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>Status: <span className="text-foreground font-medium">{String(jobProgress["status"] ?? "—")}</span></p>
                <p>Pages: {String(jobProgress["pagesDone"] ?? 0)} / {String(jobProgress["pagesTotal"] ?? 0)}</p>
                <p>Assets: {String(jobProgress["assetsDone"] ?? 0)} / {String(jobProgress["assetsTotal"] ?? 0)}</p>
                <p>Stored: {fmt(Number(jobProgress["bytesStored"] ?? 0))}</p>
                {Number(jobProgress["ia429Count"] ?? 0) > 0 && (
                  <p className="text-yellow-400">
                    ⚠ archive.org throttling detected ({String(jobProgress["ia429Count"])} 429s). Backing off…
                  </p>
                )}
              </div>
            )}
            {/* Simple progress bar */}
            {jobProgress && Number(jobProgress["pagesTotal"]) > 0 && (
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{
                    width: `${Math.round((Number(jobProgress["pagesDone"]) / Number(jobProgress["pagesTotal"])) * 100)}%`,
                  }}
                />
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
