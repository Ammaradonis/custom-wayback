/**
 * The viewer's "when archive.org is rate-limiting" panel: the reader's two fallbacks
 * (apps/web/src/lib/fallbacks.ts), and how to pre-crawl the month on screen so it
 * never needs them.
 */

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import { precrawl } from "@/lib/api.js";
import type { FallbackPrefs } from "@/lib/fallbacks.js";

interface FallbackPanelProps {
  domain: string;
  month: string;
  prefs: FallbackPrefs;
  onChange: (next: FallbackPrefs) => void;
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** One setting: the whole row is the switch, so the touch target is the row. */
function SettingSwitch({
  checked,
  onToggle,
  title,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3 text-left transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{children}</span>
      </span>
      <span className="cw-switch mt-0.5" aria-hidden />
    </button>
  );
}

/** A command to paste into a terminal, with a copy button. */
function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-stretch gap-1.5">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11px]">
          {command}
        </code>
        <button
          type="button"
          className="cw-btn cw-btn-ghost cw-btn-icon"
          aria-label={copied ? "Copied" : `Copy: ${label}`}
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(command)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

export function FallbackPanel({ domain, month, prefs, onChange, onClose }: FallbackPanelProps) {
  const { data: status, isError } = useQuery({
    queryKey: ["precrawl", domain, month],
    queryFn: () => precrawl.status(domain, month),
    enabled: Boolean(domain && month),
    staleTime: 1000 * 30,
  });
  const api = window.location.origin;

  return (
    <aside
      className="cw-overlay overlay-shadow fixed inset-x-0 bottom-0 z-20 max-h-[80vh] overflow-auto rounded-t-2xl border-b-0 p-4 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[27rem] md:rounded-none md:border-b md:border-l"
      style={{ paddingBottom: "calc(1.25rem + var(--sai-bottom))" }}
      aria-labelledby="cw-fallbacks-title"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="cw-fallbacks-title" className="text-sm font-semibold">
          When archive.org is rate-limiting
        </h2>
        <button type="button" onClick={onClose} className="cw-btn cw-btn-ghost cw-btn-icon" aria-label="Close">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        archive.org sometimes refuses the viewer's requests (HTTP 429). These are used only for
        a page it refused; every other page loads in the viewer as usual.
      </p>

      <div className="space-y-2">
        <SettingSwitch
          checked={prefs.storedCopy}
          onToggle={() => onChange({ ...prefs, storedCopy: !prefs.storedCopy })}
          title="Open a stored copy from a nearby day"
        >
          A page you pre-crawled, or that a crawl kept, opens in the viewer with all its
          features. A bar above the page says which day the copy is from.
        </SettingSwitch>
        <SettingSwitch
          checked={prefs.replay}
          onToggle={() => onChange({ ...prefs, replay: !prefs.replay })}
          title="Show archive.org's own replay"
        >
          Loads the page from web.archive.org in your browser. archive.org sees your IP
          address, and the viewer's links, prefetching and edge caching don't work on that
          page.
        </SettingSwitch>
        <p className="text-xs text-muted-foreground">
          With both on, a stored copy is tried first. With both off, you see the error and
          can pick either one for that page.
        </p>
      </div>

      <section className="mt-6 space-y-3" aria-labelledby="cw-precrawl-title">
        <h3 id="cw-precrawl-title" className="cw-label">
          Pre-crawled pages · {domain} · {month}
        </h3>
        <p className="text-sm">
          {isError
            ? "Could not check what is pre-crawled."
            : !status
              ? "Checking…"
              : status.pages === 0
                ? "Nothing is pre-crawled for this month yet."
                : `${status.pages} page${status.pages === 1 ? "" : "s"} on ${status.days} day${status.days === 1 ? "" : "s"} (${fmtBytes(status.bytes)}), served without archive.org.`}
        </p>
        <p className="text-xs text-muted-foreground">
          The local crawler fetches pages through your own connection, which archive.org
          rarely throttles, and stores them in this deployment's R2. The viewer then serves
          them without asking archive.org, and never deletes them after viewing. It only
          helps with what you crawl.
        </p>
        <Command label="In apps/crawler-local of this repository, sign in once:" command={`npm run login -- --api=${api}`} />
        <Command
          label="Then crawl this month and publish it:"
          command={`npm run crawl -- --domain=${domain} --month=${month} --publish`}
        />
        <p className="text-xs text-muted-foreground">
          Needs Node 22.6 or later. The crawl is polite by design, about one request a
          second, so a month of a large site takes a while.
        </p>
      </section>
    </aside>
  );
}
