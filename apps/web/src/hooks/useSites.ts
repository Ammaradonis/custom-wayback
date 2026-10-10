/**
 * Shared hooks and small helpers for the Phase 5 surfaces (plan.md §15).
 *
 * Search, compare, shares and export all need the same two things: the list of
 * domains, and the list of months that actually have captures. Both come from
 * endpoints that already exist (`/v1/domains`, `/v1/sites`) — there is no
 * "crawled months" endpoint, and inventing one would mean a new API route for
 * something a derived list answers exactly.
 *
 * A month inferred from a crawl row is a *coverage* fact, not a guess: `/v1/sites`
 * lists one row per (domain, month) the ledger has snapshots for.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { domains as domainsApi, manifests, type DomainEntry, type SiteEntry } from "@/lib/api.js";

/**
 * Shared class lists for controls.
 *
 * These are names of real component classes defined in `src/index.css`, not
 * inline utility strings. The difference is not cosmetic: as utility strings they
 * were 4–5 Tailwind classes each, repeated at every call site, and every one of
 * the colour classes among them (`border-input`, `bg-background`,
 * `text-foreground`, `border-border`, `text-muted-foreground`, `bg-accent`,
 * `text-accent-foreground`, `ring-accent`) resolved to **no CSS rule at all**,
 * because the design tokens were not registered in a Tailwind `@theme` block.
 * Two separate definitions of "a text field" is also two places for them to drift.
 *
 * Now there is one `.cw-field` and one `.cw-btn` family, defined in CSS, with the
 * focus ring, touch target and contrast handled once.
 */
export const FIELD_CLASS = "cw-field";

/** Shared class list for secondary ("Load more", "Copy", …) buttons. */
export const SECONDARY_BUTTON_CLASS = "cw-btn cw-btn-secondary";

/** Shared class list for primary buttons. */
export const PRIMARY_BUTTON_CLASS = "cw-btn cw-btn-primary";

/** Shared class list for icon-only toolbar buttons. */
export const ICON_BUTTON_CLASS = "cw-btn cw-btn-ghost cw-btn-icon";

// `monthInputValue` and `dateInputValue` used to live here, converting a
// `YYYY-MM` key into the string shape a native `<input type="month">` or
// `<input type="date">` wants. Every one of those inputs has been replaced by a
// `<select>` over the months that were actually crawled — a native month picker
// could not be themed by the app (so it rendered invisible against a dark canvas
// on a light-mode OS) and it happily offered months with no captures, producing
// an action that did nothing. The converters went with them rather than lingering
// as dead exports.

/** Distinct months with captures, newest first. */
export function crawledMonths(sites: SiteEntry[], domain?: string): string[] {
  const months = new Set<string>();
  for (const site of sites) {
    if (domain !== undefined && site.domain !== domain) continue;
    months.add(site.month);
  }
  return [...months].sort((a, b) => b.localeCompare(a));
}

/**
 * Tracked domains and their crawled months.
 *
 * `staleTime` is long on purpose: what has been crawled changes only when someone
 * starts a crawl, and a picker that repaints mid-tap is worse than one that is a
 * minute behind.
 */
export function useSites(): {
  domainList: DomainEntry[];
  sites: SiteEntry[];
  isLoading: boolean;
} {
  const domainQuery = useQuery({
    queryKey: ["domains"],
    queryFn: domainsApi.list,
    staleTime: 1000 * 60,
  });

  const siteQuery = useQuery({
    queryKey: ["sites"],
    queryFn: manifests.sites,
    staleTime: 1000 * 60,
  });

  const domainList = useMemo(() => domainQuery.data ?? [], [domainQuery.data]);
  const sites = useMemo(() => siteQuery.data?.sites ?? [], [siteQuery.data]);

  return {
    domainList,
    sites,
    isLoading: domainQuery.isPending || siteQuery.isPending,
  };
}

/**
 * Run a callback immediately, then keep running it every `intervalMs` while
 * `active`. Used for the export build poll and the reindex loop: both are
 * long-ish operations whose only progress signal is a repeated request, and both
 * must stop the moment the component goes away.
 */
export function usePollWhile(active: boolean, intervalMs: number, tick: () => void): void {
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (!active) return;
    latest.current();
    const id = setInterval(() => latest.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}
