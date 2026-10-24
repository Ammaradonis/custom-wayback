/**
 * The head contract — one declarative description of what every mirrored page's
 * `<head>` must contain, and of what must never survive into it.
 *
 * ## Why this file exists
 *
 * There are two places that turn archived bytes into something we can serve:
 *
 *   1. the ingest rewriter, which parses with linkedom and stores the result
 *      (`apps/api/src/queue/rewrite.ts`, `apps/crawler-local/src/rewrite.ts`), and
 *   2. the viewer's on-demand path, which streams through `HTMLRewriter` when the
 *      stored blob has been purged (`apps/api/src/routes/viewer.ts`).
 *
 * plan.md §3.1 promises that "nothing is rewritten at read time" and that reads are
 * byte serving. The on-demand path is the one exception the plan itself allows
 * (§5: "the first time you click an un-crawled page, the viewer worker fetches that
 * one page via `id_`, rewrites and caches it"), so it has to produce output that is
 * *contract-equivalent* to the ingest path: same runtime shim, same ids, same CSP,
 * same script triage, same neutralisations. Otherwise the same URL behaves
 * differently depending on whether it has been visited before, which is invisible in
 * a fresh test and only shows up in the §9.3 device checklist.
 *
 * The two paths differ in *how* they parse — a DOM versus a streaming rewriter — and
 * they cannot share a parser. They can and do share this: the exact strings, the ids,
 * the policy, and the decisions, as data plus pure functions. A change here moves
 * both paths at once; a change to one path that ignores what is here is what the
 * `contract equivalence` test in `apps/api/test/viewer.test.ts` fails on.
 *
 * ## Purity
 *
 * Nothing in this file touches the DOM, the network, the filesystem or a Node
 * builtin. `env.d.ts` allows only the globals that exist in Node 22+ *and* in
 * Cloudflare Workers, so this module compiles in both runtimes. That constraint is
 * load-bearing rather than decorative: the local crawler and the Worker both import
 * it, and a Node builtin import here would break the Worker bundle at deploy time.
 */

import { RUNTIME_CSS, RUNTIME_SCRIPT, RUNTIME_SCRIPT_ID, RUNTIME_STYLE_ID } from './runtime.js';
import { shouldStubScript } from './urlutil.js';

// ── The policy ───────────────────────────────────────────────────────────────

/**
 * plan.md §10, verbatim: "**CSP** on the served snapshot: `default-src 'self'
 * 'unsafe-inline' data: blob:`; no `frame-ancestors` escape; `form-action`
 * restricted; `base-uri 'self'`."
 *
 * The first clause is quoted from the plan; the remaining directives are that
 * sentence spelled out, so the policy is one value instead of a paragraph somebody
 * has to re-interpret at each call site.
 *
 * Two deliberate omissions, both worth stating because they look like oversights:
 *
 *  - **`frame-ancestors`** is left out. A policy delivered in a `<meta>` element has
 *    its `frame-ancestors` directive ignored by every browser (they log a warning and
 *    drop it), and framing is already refused by the `X-Frame-Options: SAMEORIGIN`
 *    header the Worker sets on every response. Putting it here would buy nothing and
 *    add a console warning to every on-demand page.
 *  - **no allow-list for the archived site's own origin.** An absolute asset URL we
 *    did not rewrite is exactly the "request the archived page makes that we did not
 *    rewrite" that §10 requires to be blocked, so a 2014 beacon cannot leak the
 *    visitor's IP to whatever that host resolves to today. The viewer rewrites common resources through a same-origin proxy; unsupported and over-budget URLs remain blocked.
 */
export const SNAPSHOT_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-src 'self'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * The §10 policy, optionally with extra directives appended.
 *
 * The intended use of `extra` is to *add* a directive the base policy does not have
 * (`report-uri`, `worker-src`, …). It cannot loosen the base policy: CSP ignores a
 * repeated directive after the first occurrence, so an appended `img-src …` loses to
 * the `img-src` above. To replace the policy outright, pass `csp` to
 * `HeadContractOptions` instead — that path is for a deployment that has decided the
 * §10 policy is wrong for it, and it is visible in the diff of the caller.
 */
export function snapshotCsp(extra?: string): string {
  const addition = extra?.trim();
  return addition ? `${SNAPSHOT_CSP}; ${addition}` : SNAPSHOT_CSP;
}

// ── The contract, as data ────────────────────────────────────────────────────

/**
 * The neutralisation applied to every `<form>`: the archived form must not be able
 * to post into the live internet (§10), so its action is moved to a data attribute
 * the shell can display, and submission is refused in the one place a page cannot
 * get around.
 */
export interface FormNeutralisationContract {
  element: string;
  /** The attribute that is moved. */
  actionAttribute: string;
  /** Where the original action is preserved for the toolbar to show. */
  originalActionAttribute: string;
  onsubmitAttribute: string;
  /** Inline handler: honest, and it works even if the page's own JS is dead. */
  onsubmit: string;
  disabledAttribute: string;
  disabledValue: string;
}

/** How a stubbed script is represented in the served document. */
export interface ScriptStubContract {
  element: string;
  /** `text/plain` so the browser fetches nothing and executes nothing. */
  type: string;
  className: string;
  /** Carries the URL we refused to fetch, so the console and the toolbar can say so. */
  dataAttribute: string;
  /** Same marker, different reason: the script was live but we have no bytes for it. */
  missingAttribute: string;
}

export interface HeadContract {
  /** Ids of the injected chrome, so a re-rewrite can find and replace its own output. */
  runtimeScriptId: string;
  runtimeStyleId: string;
  /** The injected strings themselves, so a reader sees exactly what goes in. */
  runtimeScript: string;
  runtimeCss: string;
  /** The §10 policy. `snapshotCsp()` is the function form of this value. */
  csp: string;
  /** The noindex intent, as the ingest path writes it into `<meta name="robots">`. */
  robotsContent: string;
  /** `<meta http-equiv="…">` values stripped from every archived document. */
  strippedMetaHttpEquiv: readonly string[];
  /** `<meta name="…">` values stripped from every archived document. */
  strippedMetaNames: readonly string[];
  /** Every upstream `<base>` goes; exactly one injected base is allowed (§6.4). */
  base: { element: string; hrefAttribute: string };
  stubScript: ScriptStubContract;
  form: FormNeutralisationContract;
}

/**
 * The whole contract in one object.
 *
 * This is data on purpose. A reader who wants to know what a mirrored page is
 * allowed to contain should not have to read two rewriters and diff them by hand,
 * and a test can assert that both paths honour these values rather than asserting
 * that each path matches its own hard-coded copy.
 */
export const HEAD_CONTRACT: HeadContract = {
  runtimeScriptId: RUNTIME_SCRIPT_ID,
  runtimeStyleId: RUNTIME_STYLE_ID,
  runtimeScript: RUNTIME_SCRIPT,
  runtimeCss: RUNTIME_CSS,
  csp: SNAPSHOT_CSP,
  robotsContent: 'noindex,nofollow,noarchive',
  // A meta refresh yanks the visitor out of the mirror, and an archived robots
  // directive says something about a site we are not: it is replaced by our own
  // noindex intent on the served response.
  strippedMetaHttpEquiv: ['refresh'],
  strippedMetaNames: ['robots'],
  base: { element: 'base', hrefAttribute: 'href' },
  stubScript: {
    element: 'script',
    type: 'text/plain',
    className: 'cw-stub',
    dataAttribute: 'data-cw-stub',
    missingAttribute: 'data-cw-missing',
  },
  form: {
    element: 'form',
    actionAttribute: 'action',
    originalActionAttribute: 'data-cw-action',
    onsubmitAttribute: 'onsubmit',
    onsubmit: 'return false',
    disabledAttribute: 'data-cw-disabled',
    disabledValue: '1',
  },
};

// ── Pure decisions ───────────────────────────────────────────────────────────
//
// These are the judgements the two rewriters must agree on. They are functions
// rather than inline `if`s so a test can drive them directly, without a parser and
// without a DOM.

/**
 * Is this `<meta>` one the contract removes?
 *
 * Attribute names and values are compared case-insensitively: archived pages were
 * written by hand for thirty years, and `http-equiv="Refresh"` is as common as the
 * lowercase spelling.
 */
export function isStrippedMeta(httpEquiv: string | null, name: string | null): boolean {
  const equiv = (httpEquiv ?? '').trim().toLowerCase();
  if (equiv && HEAD_CONTRACT.strippedMetaHttpEquiv.includes(equiv)) return true;
  const metaName = (name ?? '').trim().toLowerCase();
  return Boolean(metaName) && HEAD_CONTRACT.strippedMetaNames.includes(metaName);
}

/**
 * Is this `<base>` someone else's?
 *
 * The viewer injects its own base and removes every base from the upstream capture,
 * so "foreign" is the honest test: anything that is not the base we injected must
 * go. Written this way (rather than "remove every base") it stays correct even if a
 * rewriter implementation re-visits the content it just inserted, which a streaming
 * rewriter is allowed to do and a DOM-based one is not.
 */
export function isForeignBase(href: string | null, baseHref: string): boolean {
  return (href ?? '').trim() !== baseHref;
}

/** The decision for one `<script src>`: fetched, or replaced by an inert marker. */
export type ScriptDisposition = 'stub' | 'keep';

/**
 * Script triage (§6.4): dead analytics, ad networks and tag managers are stubbed
 * rather than fetched. This is the whole point of the step — a stubbed script cannot
 * hang the page for thirty seconds — so the decision is delegated to the single
 * shared list in `urlutil.ts` rather than duplicated per rewriter.
 */
export function scriptDisposition(src: string): ScriptDisposition {
  return shouldStubScript(src) ? 'stub' : 'keep';
}

/**
 * The inert marker that replaces a stubbed `<script src>`.
 *
 * `type="text/plain"` means the browser neither fetches nor executes it; the class is
 * what `RUNTIME_CSS` hides; the data attribute keeps the URL visible to a human
 * reading the source and to the runtime's own reporting.
 */
export function stubScriptHtml(src: string): string {
  const contract = HEAD_CONTRACT.stubScript;
  return (
    `<${contract.element} type="${escapeAttribute(contract.type)}"` +
    ` class="${escapeAttribute(contract.className)}"` +
    ` ${contract.dataAttribute}="${escapeAttribute(src)}"></${contract.element}>`
  );
}

/** The attributes a neutralised `<form>` must end up with, and the one it loses. */
export interface FormNeutralisation {
  /** Attribute to remove from the element. */
  removeAttribute: string;
  /** Attributes to set, in the order they should be applied. */
  attributes: Record<string, string>;
}

/**
 * Neutralise a form so it cannot post to the live internet (§10), preserving what
 * the author wrote in a data attribute so the shell can show where it would have
 * gone. A form with no action submits to the current URL, which under our base is a
 * snapshot route — recorded as the empty string, exactly as the ingest path stores it.
 */
export function formNeutralisation(action: string | null): FormNeutralisation {
  const contract = HEAD_CONTRACT.form;
  return {
    removeAttribute: contract.actionAttribute,
    attributes: {
      [contract.originalActionAttribute]: action ?? '',
      [contract.onsubmitAttribute]: contract.onsubmit,
      [contract.disabledAttribute]: contract.disabledValue,
    },
  };
}

// ── Markup builders ──────────────────────────────────────────────────────────

/**
 * Escape a value for use inside a double-quoted attribute.
 *
 * The injected markup is assembled as a string and handed to `prepend(…, { html: true })`
 * (or to linkedom's HTML parser on the ingest path), so a value containing a quote
 * would otherwise end the attribute early and let an archived URL inject markup into
 * our own head. Everything that reaches these builders is either a constant from this
 * package or a URL/path derived from the request, but the escape is not optional: the
 * one place it is skipped is the place where a stranger's bytes get to write HTML.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `<meta http-equiv="Content-Security-Policy" content="…">` */
export function cspMetaHtml(csp: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
}

/**
 * `<style id="cw-runtime-style">…</style>`.
 *
 * The CSS is inserted raw, not escaped: inside a `<style>` element character
 * references are not decoded, so escaping would corrupt selectors like `a > b`. That
 * makes "the stylesheet contains no `</style`" a precondition, and it is asserted in
 * the tests rather than assumed here.
 */
export function runtimeStyleHtml(): string {
  return `<style id="${escapeAttribute(HEAD_CONTRACT.runtimeStyleId)}">${HEAD_CONTRACT.runtimeCss}</style>`;
}

/**
 * `<script id="cw-runtime-script">…</script>`, inserted raw for the same reason as
 * the stylesheet: `<script>` is a raw-text element, so the body is code, not markup.
 * The precondition (`</script` does not appear inside the runtime) is asserted in the
 * tests next to the stylesheet's.
 */
export function runtimeScriptHtml(): string {
  return `<script id="${escapeAttribute(HEAD_CONTRACT.runtimeScriptId)}">${HEAD_CONTRACT.runtimeScript}</script>`;
}

/** `<base href="…">` — the snapshot route every relative URL resolves against. */
export function baseTagHtml(baseHref: string): string {
  return `<${HEAD_CONTRACT.base.element} ${HEAD_CONTRACT.base.hrefAttribute}="${escapeAttribute(baseHref)}">`;
}

/** `<meta name="…" content="…">` for each entry, in insertion order. */
export function metaTagsHtml(metas: Record<string, string>): string {
  let html = '';
  for (const [name, content] of Object.entries(metas)) {
    html += `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}">`;
  }
  return html;
}

// ── The injection ────────────────────────────────────────────────────────────

export interface HeadContractOptions {
  /** Snapshot route prefix for internal links, e.g. "/a/example.com/2024-03-15". */
  baseHref: string;
  /** CSP for the served document. Defaults to the §10 policy. */
  csp?: string;
  /** Extra `<meta name="...">` tags to inject (e.g. cw-mirror). */
  metas?: Record<string, string>;
}

export interface HeadInjection {
  baseHref: string;
  csp: string;
  runtimeScriptId: string;
  runtimeStyleId: string;
  /** The individual tags, for tests and for a reader who wants one of them alone. */
  parts: {
    cspMeta: string;
    runtimeStyle: string;
    runtimeScript: string;
    base: string;
    metas: string;
  };
  /** `parts` joined in order: one `prepend(html, { html: true })` inserts the lot. */
  html: string;
}

/**
 * Build the markup to insert at the very top of `<head>`.
 *
 * The order is the contract, and each position has a reason:
 *
 *   1. **CSP meta first.** A policy delivered in a `<meta>` element only governs the
 *      content that *follows* it in the document, so it has to precede every archived
 *      script and stylesheet to mean anything. It precedes our own runtime script too,
 *      which is fine: an inline script is allowed by `script-src 'unsafe-inline'`.
 *   2. **Runtime stylesheet second.** The stub-hiding and dead-link rules should be in
 *      place before the page's markup is parsed, not after.
 *   3. **Runtime script third.** Because this whole block is prepended, the shims exist
 *      before any archived script in the document runs — the failure §6.4 is about
 *      ("old pages break on missing globals") happens at the first line of page code,
 *      so "later in head" is not good enough.
 *   4. **Base tag fourth.** Relative URLs in everything after it resolve against the
 *      snapshot route instead of the original host (§6.4 "de-base").
 *   5. **Extra metas last.** They are metadata for our shell, so nothing depends on them.
 *
 * The caller is responsible for having removed the upstream document's own base, meta
 * refresh and meta robots first; `isForeignBase` and `isStrippedMeta` are the
 * decisions for that, shared with the ingest rewriter.
 */
export function headInjection(options: HeadContractOptions): HeadInjection {
  const baseHref = options.baseHref;
  const csp = options.csp ?? snapshotCsp();
  const parts = {
    cspMeta: cspMetaHtml(csp),
    runtimeStyle: runtimeStyleHtml(),
    runtimeScript: runtimeScriptHtml(),
    base: baseTagHtml(baseHref),
    metas: metaTagsHtml(options.metas ?? {}),
  };
  return {
    baseHref,
    csp,
    runtimeScriptId: HEAD_CONTRACT.runtimeScriptId,
    runtimeStyleId: HEAD_CONTRACT.runtimeStyleId,
    parts,
    html: [parts.cspMeta, parts.runtimeStyle, parts.runtimeScript, parts.base, parts.metas].join('\n'),
  };
}
