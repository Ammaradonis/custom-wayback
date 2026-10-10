/**
 * ShareDialog — mint and manage share links (plan.md §2.1 "Every view is
 * shareable", §13, §15).
 *
 * Used from the dashboard (domain + month) and from the viewer toolbar (one page).
 *
 * Two things about share links are easy to get wrong, and this dialog exists
 * mostly to not get them wrong:
 *
 *  1. **The token is returned once.** Only a SHA-256 of it is stored, so a "copy
 *     link" button for an older row would be a button that cannot work. The token
 *     is therefore shown in the one place it exists — the response to the create
 *     call — with a copy button beside it and a plain sentence saying it cannot be
 *     fetched again. The list below it offers revoke and re-create, not "copy".
 *  2. **A share link is not public.** It is behind the same access control as the
 *     app (§13, Cloudflare Access). Someone who assumes otherwise will paste it
 *     into a public place, so the server's own `accessNote` is rendered directly
 *     under the copy button — not in a tooltip, not in a help page.
 *
 * Mobile-first: a bottom sheet below 640 px (thumb-reachable, safe-area padded),
 * a centred dialog above it, matching `MonthCalendar`.
 */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  shares,
  type CreatedShare,
  type ShareRecord,
  type ShareScopeInput,
} from "@/lib/api.js";
import { fmtMonthLabel, fmtUnixTime } from "@/lib/format.js";
import { FIELD_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/hooks/useSites.js";

/** The scope a link is minted for. `day` and `url` come as a pair. */
export interface ShareTarget {
  domain: string;
  month: string;
  day?: string;
  url?: string;
}

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ShareTarget;
}

const EXPIRY_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: "Never expires", days: null },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

/**
 * Copy text, with the fallback that actually matters on a phone.
 *
 * `navigator.clipboard` needs a secure context; a mirror reached over plain HTTP
 * on a LAN does not have one. The `execCommand` path is deprecated but it is the
 * only thing that works there, and failing to copy a one-time token is expensive.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** What the link covers, in words. */
function describeScope(record: {
  domain: string;
  month: string | null;
  day: string | null;
  url: string | null;
}): string {
  if (record.url && record.day) return `${record.domain} · ${record.day} · ${record.url}`;
  if (record.day) return `${record.domain} · ${record.day}`;
  if (record.month) return `${record.domain} · ${fmtMonthLabel(record.month)}`;
  return record.domain;
}

/** `live` / `revoked` / `expired`, computed from the row's own timestamps. */
function shareState(record: ShareRecord): "revoked" | "expired" | "live" {
  if (record.revoked_at !== null) return "revoked";
  if (record.expires_at !== null && record.expires_at * 1000 < Date.now()) return "expired";
  return "live";
}

export function ShareDialog({ open, onOpenChange, target }: ShareDialogProps) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState<"token" | "url" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["shares"],
    queryFn: shares.list,
    enabled: open,
    staleTime: 1000 * 30,
  });

  const createShare = useMutation({
    mutationFn: (input: ShareScopeInput) => shares.create(input),
    onSuccess: (result) => {
      setCreated(result);
      setCreateError(null);
      setLabel("");
      setCopied(null);
      void qc.invalidateQueries({ queryKey: ["shares"] });
    },
    onError: (err: Error) => {
      // A 429 is a wait, not a fault; the API's own wording says how long.
      setCreateError(
        err instanceof ApiError && err.status === 429
          ? err.message
          : err.message || "Could not create the link.",
      );
    },
  });

  const revokeShare = useMutation({
    mutationFn: (id: string) => shares.revoke(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["shares"] }),
  });

  const rows = listQuery.data?.shares ?? [];
  const absoluteShareUrl = created ? `${window.location.origin}${created.shareUrl}` : "";

  function handleCopy(what: "token" | "url") {
    if (!created) return;
    const text = what === "url" ? absoluteShareUrl : created.token;
    void copyText(text).then((ok) => {
      if (ok) {
        setCopied(what);
        setCopyNote(null);
        window.setTimeout(() => setCopied(null), 2000);
      } else {
        // Say so rather than claiming a copy that did not happen.
        setCopyNote("Copying was blocked by the browser — select the text and copy it manually.");
      }
    });
  }

  function handleCreate() {
    setCreateError(null);
    createShare.mutate({
      domain: target.domain,
      month: target.month,
      ...(target.day ? { day: target.day } : {}),
      ...(target.url ? { url: target.url } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(expiryDays !== null ? { expiresInDays: expiryDays } : {}),
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="cw-overlay overlay-shadow fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-2xl border-b-0 p-5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom duration-200 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85dvh] md:w-[32rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border-b"
          style={{ paddingBottom: "calc(1.25rem + var(--sai-bottom))" }}
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-muted md:hidden" aria-hidden />

          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">Share</Dialog.Title>
              <p className="truncate text-xs text-muted-foreground">
                {describeScope({
                  domain: target.domain,
                  month: target.month,
                  day: target.day ?? null,
                  url: target.url ?? null,
                })}
              </p>
            </div>
            <Dialog.Close
              className="cw-btn cw-btn-ghost cw-btn-icon flex-none"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>

          {/* ── Create ── */}
          <section className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="share-label" className="cw-label">
                  Label (optional)
                </label>
                <input
                  id="share-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Q3 pricing"
                  maxLength={120}
                  className={`${FIELD_CLASS} w-full`}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="share-expiry" className="cw-label">
                  Expires
                </label>
                <select
                  id="share-expiry"
                  value={expiryDays === null ? "never" : String(expiryDays)}
                  onChange={(e) =>
                    setExpiryDays(e.target.value === "never" ? null : Number(e.target.value))
                  }
                  className={`${FIELD_CLASS} w-full`}
                >
                  {EXPIRY_CHOICES.map((choice) => (
                    <option key={choice.label} value={choice.days === null ? "never" : String(choice.days)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreate}
              disabled={createShare.isPending}
              className={`${PRIMARY_BUTTON_CLASS} w-full`}
            >
              {createShare.isPending ? "Creating…" : "Create link"}
            </button>

            {createError && (
              <p className="text-xs text-danger-foreground" role="alert">
                {createError}
              </p>
            )}

            {target.day && !target.url && (
              <p className="text-xs text-warning-foreground">
                This link will open the month, not the page, because no capture URL was
                available for this day.
              </p>
            )}
          </section>

          {/* ── The one-time token ── */}
          {created && (
            <section className="mt-4 space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
              <div>
                <h3 className="text-sm font-semibold">Your link is ready</h3>
                <p className="text-xs text-warning-foreground">
                  Copy it now. The token is shown this once and is stored only as a
                  hash — it cannot be retrieved later. If you lose it, revoke this
                  link and create another.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="share-url" className="cw-label">
                  Link
                </label>
                <div className="flex gap-2">
                  <input
                    id="share-url"
                    readOnly
                    value={absoluteShareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className={`${FIELD_CLASS} min-w-0 flex-1 font-mono text-[11px]`}
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy("url")}
                    className={`${SECONDARY_BUTTON_CLASS} flex-none`}
                  >
                    {copied === "url" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="share-token" className="cw-label">
                  Token (returned once)
                </label>
                <div className="flex gap-2">
                  <input
                    id="share-token"
                    readOnly
                    value={created.token}
                    onFocus={(e) => e.currentTarget.select()}
                    className={`${FIELD_CLASS} min-w-0 flex-1 font-mono text-[11px]`}
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy("token")}
                    className={`${SECONDARY_BUTTON_CLASS} flex-none`}
                  >
                    {copied === "token" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Right next to the copy buttons, where it is needed. */}
              <p className="rounded-md border border-border bg-card/60 p-2 text-xs text-muted-foreground">
                {created.accessNote}
              </p>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>Opens</dt>
                <dd className="truncate text-right font-mono text-[11px]">{created.resolvesTo}</dd>
                <dt>Expires</dt>
                <dd className="text-right">
                  {created.expiresAt === null ? "Never" : fmtUnixTime(created.expiresAt)}
                </dd>
              </dl>

              {copyNote && (
                <p className="text-xs text-warning-foreground" role="status">
                  {copyNote}
                </p>
              )}
            </section>
          )}

          {/* ── Existing links ── */}
          <section className="mt-5 space-y-2">
            <h3 className="text-sm font-semibold">Your links</h3>

            {listQuery.isPending && (
              <div className="space-y-2" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            )}

            {listQuery.isError && (
              <p className="text-xs text-danger-foreground" role="alert">
                {listQuery.error instanceof Error
                  ? listQuery.error.message
                  : "Could not load your links."}
              </p>
            )}

            {listQuery.data && rows.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No links yet. The one you create will appear here with its view count.
              </p>
            )}

            <ul className="space-y-2">
              {rows.map((record) => {
                const state = shareState(record);
                return (
                  <li key={record.id} className="space-y-1 rounded-lg border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 flex-1 truncate text-sm">
                        {record.label ?? describeScope(record)}
                      </p>
                      {state === "live" ? (
                        <button
                          type="button"
                          onClick={() => revokeShare.mutate(record.id)}
                          disabled={revokeShare.isPending}
                          className="cw-btn cw-btn-danger h-8 min-h-8 flex-none px-3 text-xs"
                        >
                          Revoke
                        </button>
                      ) : (
                        <span className="flex-none text-xs text-muted-foreground">{state}</span>
                      )}
                    </div>
                    {record.label && (
                      <p className="truncate text-xs text-muted-foreground">
                        {describeScope(record)}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {record.view_count.toLocaleString()}{" "}
                      {record.view_count === 1 ? "view" : "views"} · created{" "}
                      {fmtUnixTime(record.created_at)}
                      {record.expires_at !== null && <> · expires {fmtUnixTime(record.expires_at)}</>}
                    </p>
                    {record.last_viewed_at !== null && (
                      <p className="text-xs text-muted-foreground">
                        Last opened {fmtUnixTime(record.last_viewed_at)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            {listQuery.data?.note && (
              <p className="text-xs text-muted-foreground">{listQuery.data.note}</p>
            )}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
