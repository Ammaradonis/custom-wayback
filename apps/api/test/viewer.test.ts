/**
 * The viewer's on-demand path, and the head contract it must share with ingest.
 *
 * ## What is under test, and why it needs a test at all
 *
 * `fetchOnDemand` is the only place a page is rewritten at read time (plan.md §3.1
 * forbids it everywhere else, and §5 allows this one exception after the post-serve
 * purge job has deleted the stored blob). It used to apply a naive rewrite — a base
 * tag and a CSP meta, nothing else — so a page's *second* visit behaved differently
 * from its first: no runtime shim, no script triage, a live meta refresh, a live form
 * action, a competing `<base>`. None of that is visible on a fresh install, which is
 * exactly why it survived.
 *
 * These tests drive the real `fetchOnDemand` (and, for the routing decision, the real
 * Hono router) against a stubbed `fetch`, and they check the output against the
 * *pipeline's* contract values rather than against literals, so a change to one path
 * that ignores the other shows up as a failure here.
 *
 * ## Why there is a stand-in for `HTMLRewriter`
 *
 * `HTMLRewriter` is a Workers global. Node has no `lol-html`, and this route's whole
 * reason for using it is that it streams with constant memory, so swapping the
 * implementation for a DOM parser would test something other than what ships. The
 * stand-in below implements only the slice of the API the route uses (`on`, `transform`,
 * `getAttribute`/`setAttribute`/`removeAttribute`, `remove`, `replace`, `prepend`,
 * `before`) over linkedom, and it deliberately mimics the two properties that trip
 * real code up:
 *
 *   - `transform()` returns a response whose headers are **immutable**, as the real one
 *     does, so a route that hands that response back or decorates its headers fails
 *     here instead of throwing in production;
 *   - handlers see elements in document order, with a `<head>` handler firing before
 *     its children, which is what makes "the runtime script precedes every archived
 *     script" a real assertion rather than a coincidence.
 *
 * What it does *not* prove: that the route streams, and that real lol-html parses
 * exactly as linkedom does. Neither is testable under `node --test`; both are covered
 * by the fact that the Worker is bundled against the real Workers types
 * (`wrangler deploy --dry-run`). Everything that *can* be a pure function was pushed
 * into `@custom-wayback/pipeline`, where it is tested directly with no parser at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseHTML } from "linkedom";

import {
  HEAD_CONTRACT,
  RUNTIME_CSS,
  RUNTIME_SCRIPT,
  RUNTIME_SCRIPT_ID,
  RUNTIME_STYLE_ID,
  SNAPSHOT_CSP,
  escapeAttribute,
  formNeutralisation,
  headInjection,
  isForeignBase,
  isStrippedMeta,
  scriptDisposition,
  snapshotCsp,
  snapshotCspForOrigin,
  stubScriptHtml,
} from "@custom-wayback/pipeline";
import { WAYBACK_RAW_BASE } from "@custom-wayback/shared";

import { rewriteHtml } from "../src/queue/rewrite.ts";
import {
  fetchOnDemand,
  leakedArchiveResource,
  parseResourcePath,
  resourcePath,
  scheduleWarm,
  viewerRouter,
} from "../src/routes/viewer.ts";
import type { Env } from "../src/env.ts";

// ── The stand-in ─────────────────────────────────────────────────────────────

/**
 * The subset of a DOM node the stand-in needs, declared narrowly on purpose: a test
 * double that can do anything proves nothing about what the shipping code does with it.
 */
interface DomNode {
  nodeType: number;
  readonly childNodes: ArrayLike<DomNode>;
  readonly firstChild: DomNode | null;
  readonly nextSibling: DomNode | null;
  readonly parentNode: DomNode | null;
  remove(): void;
  insertBefore(node: DomNode, reference: DomNode | null): DomNode;
  appendChild(node: DomNode): DomNode;
}

interface DomElement extends DomNode {
  readonly tagName: string;
  readonly ownerDocument: DomDocument;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  matches(selector: string): boolean;
}

interface DomDocument {
  readonly documentElement: DomElement | null;
  createElement(tagName: string): DomElement;
  createTextNode(text: string): DomNode;
  querySelector(selector: string): DomElement | null;
  toString(): string;
}

const ELEMENT_NODE = 1;

function isElement(node: DomNode): node is DomElement {
  return node.nodeType === ELEMENT_NODE;
}

function parse(source: string): DomDocument {
  return parseHTML(source).document as unknown as DomDocument;
}

/** What a handler did to the element it was given. */
interface MutationState {
  removed: boolean;
  /** Nodes a `replace()` put in the element's place; they are visited next. */
  replacements: DomElement[];
}

interface ElementHandler {
  element?(element: StandInElement): void;
}

interface RegisteredHandler {
  selector: string;
  handler: ElementHandler;
}

type InsertPosition = "afterbegin" | "beforeend" | "beforebegin" | "afterend";

/**
 * Split a content argument the way the real API does: `{ html: true }` means "parse
 * this as markup", anything else means "this is text". Every call site in the route
 * passes markup; the text branch exists so the stand-in does not silently treat a
 * missing option as HTML.
 */
function contentNodes(document: DomDocument, content: string, html?: boolean): DomNode[] {
  if (!html) return [document.createTextNode(content)];
  const holder = document.createElement("div");
  (holder as unknown as { innerHTML: string }).innerHTML = content;
  return Array.from(holder.childNodes);
}

function insertRelative(
  element: DomElement,
  position: InsertPosition,
  content: string,
  options?: { html?: boolean },
): DomElement[] {
  const nodes = contentNodes(element.ownerDocument, content, options?.html);
  switch (position) {
    case "afterbegin": {
      const first = element.firstChild;
      for (const node of nodes) element.insertBefore(node, first);
      break;
    }
    case "beforeend":
      for (const node of nodes) element.appendChild(node);
      break;
    case "beforebegin": {
      const parent = element.parentNode;
      if (parent) for (const node of nodes) parent.insertBefore(node, element);
      break;
    }
    case "afterend": {
      const parent = element.parentNode;
      const reference = element.nextSibling;
      if (parent) for (const node of nodes) parent.insertBefore(node, reference);
      break;
    }
  }
  return nodes.filter(isElement);
}

/** An element as a handler sees it. */
class StandInElement {
  constructor(
    private readonly el: DomElement,
    private readonly state: MutationState,
  ) {}

  get tagName(): string {
    return this.el.tagName;
  }

  get removed(): boolean {
    return this.state.removed;
  }

  getAttribute(name: string): string | null {
    return this.el.getAttribute(name);
  }

  hasAttribute(name: string): boolean {
    return this.el.hasAttribute(name);
  }

  setAttribute(name: string, value: string): void {
    this.el.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.el.removeAttribute(name);
  }

  remove(): void {
    this.state.removed = true;
    this.el.remove();
  }

  replace(content: string, options?: { html?: boolean }): void {
    this.state.replacements = insertRelative(this.el, "beforebegin", content, options);
    this.state.removed = true;
    this.el.remove();
  }

  prepend(content: string, options?: { html?: boolean }): void {
    insertRelative(this.el, "afterbegin", content, options);
  }

  append(content: string, options?: { html?: boolean }): void {
    insertRelative(this.el, "beforeend", content, options);
  }

  before(content: string, options?: { html?: boolean }): void {
    insertRelative(this.el, "beforebegin", content, options);
  }

  after(content: string, options?: { html?: boolean }): void {
    insertRelative(this.el, "afterend", content, options);
  }
}

/**
 * Document order, pre-order: an element's handler runs before its children's, which is
 * what makes `head` injection land ahead of the scripts inside it.
 *
 * Two details are on purpose. Children are re-read *after* the handler ran, so nodes
 * the handler inserted are visited too — more aggressive than much of the real
 * implementation, which is the safe direction for a test: the shipping handlers are
 * written to be correct even if their own output comes back to them (`isForeignBase`,
 * `isStrippedMeta` and the `script[src]` check all ignore the injected markup).
 * And a replaced element's replacement is visited, because the real rewriter's output
 * stream contains it.
 */
function visit(element: DomElement, handlers: RegisteredHandler[]): void {
  const state: MutationState = { removed: false, replacements: [] };
  const wrapped = new StandInElement(element, state);

  for (const { selector, handler } of handlers) {
    if (!element.matches(selector)) continue;
    handler.element?.(wrapped);
    // A removed element is gone; handing it to a later handler would let two handlers
    // mutate the same node after the first one deleted it. The route registers at most
    // one handler per element, so this can only mask a mistake, not create one.
    if (state.removed) break;
  }

  if (state.removed) return;
  if (state.replacements.length > 0) {
    for (const replacement of state.replacements) visit(replacement, handlers);
    return;
  }
  for (const child of Array.from(element.childNodes)) {
    if (isElement(child)) visit(child, handlers);
  }
}

/**
 * Wrap the headers of a response the way an immutable header list behaves: reading is
 * fine, and every mutation throws the error workerd throws. Used for the response
 * `transform()` returns.
 */
function immutableHeaders(headers: Headers): Headers {
  return new Proxy(headers, {
    get(target, property) {
      if (property === "set" || property === "append" || property === "delete") {
        return () => {
          throw new TypeError("Can't modify immutable headers.");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

class StandInHTMLRewriter {
  private readonly handlers: RegisteredHandler[] = [];

  on(selector: string, handler: ElementHandler): StandInHTMLRewriter {
    this.handlers.push({ selector, handler });
    return this;
  }

  transform(response: Response): Response {
    const handlers = [...this.handlers];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const source = await response.text();
          controller.enqueue(new TextEncoder().encode(applyRewriters(source, handlers)));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    const out = new Response(body, { status: response.status, statusText: response.statusText });
    // The real `transform()` keeps the upstream response's header guard. Reproduce the
    // consequence that matters: mutating these headers throws, exactly as it does in a
    // Worker, so a route that returns this response directly fails the test below.
    Object.defineProperty(out, "headers", { value: immutableHeaders(out.headers), configurable: true });
    return out;
  }
}

/**
 * `lol-html` does not synthesise elements. A capture that never opens a `<head>` has
 * no head element at all — which is what the route's fallback exists for — while
 * linkedom always creates one. So drop the implied head when the source has no literal
 * one, or that branch could never be exercised and every test would quietly take the
 * main path.
 */
function applyRewriters(source: string, handlers: RegisteredHandler[]): string {
  const document = parse(source);
  if (!/<head[\s>]/i.test(source)) document.querySelector("head")?.remove();
  if (document.documentElement) visit(document.documentElement, handlers);
  return document.toString();
}

(globalThis as { HTMLRewriter?: unknown }).HTMLRewriter = StandInHTMLRewriter;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DOMAIN = "example.com";
const DAY = "2024-03-15";
const TS = "20240315120000";
const PAGE_URL = `https://${DOMAIN}/`;
const SNAPSHOT_BASE = `/a/${DOMAIN}/${DAY}/`;
const GA_URL = "https://www.google-analytics.com/analytics.js";

/** An archived page carrying one of every defect the on-demand path used to keep. */
const ARCHIVED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Example Domain</title>
  <base href="https://evil.test/">
  <meta http-equiv="refresh" content="0; url=https://live.example.com/">
  <meta name="robots" content="index,follow">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>Example Domain</h1>
  <img src="https://cdn.example.com/logo.png" alt="logo">
  <script id="ga-script" src="${GA_URL}"></script>
  <script id="app-js" src="/app.js"></script>
  <script id="app-inline">window.dataLayer.push({ event: "pageview" });</script>
  <form action="/search"><input name="q"></form>
</body>
</html>`;

// ── Harness ──────────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  r2_key: string | null;
  ts: string;
  resolved_day: string | null;
  delta_days: number | null;
  purged_at: number | null;
  served_at: number | null;
}

/**
 * A D1 fake for the two statements the viewer route issues, matched by shape. Anything
 * unrecognised is recorded rather than silently answered with nothing — a new query in
 * the route should fail the test, not look like an empty database (the same rule as
 * `queue.test.ts`, which needs a much larger fake because the stage machine issues a
 * much larger set of statements).
 */
class FakeSnapshotDb {
  readonly unrecognised: string[] = [];

  constructor(
    private readonly snapshot: SnapshotRow | null,
    private readonly resolution: { resolved_day: string } | null = null,
  ) {}

  binding(): D1Database {
    const self = this;

    function makeStatement(sql: string): D1PreparedStatement {
      const normalised = sql.replace(/\s+/g, " ").trim();
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          // The route now also selects `url`, because the on-demand path needs the
          // capture's *original* URL to build the id_ request and the resource proxy.
          // Recognising the statement by its leading columns rather than its exact text
          // keeps the fake from silently answering "no such snapshot" the moment a
          // column is added — which presents as a 404 for a page that exists.
          if (
            /^SELECT id, r2_key, ts, resolved_day, delta_days, purged_at, served_at(?:, url)? FROM snapshots/i.test(
              normalised,
            ) ||
            /^SELECT .*\burl\b.* FROM snapshots/i.test(normalised)
          ) {
            return self.snapshot;
          }
          if (/^SELECT resolved_day FROM link_resolutions/i.test(normalised)) {
            return self.resolution;
          }
          self.unrecognised.push(normalised.slice(0, 120));
          return null;
        },
        async all() {
          self.unrecognised.push(normalised.slice(0, 120));
          return { results: [] };
        },
        async run() {
          self.unrecognised.push(normalised.slice(0, 120));
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement as unknown as D1PreparedStatement;
    }

    return {
      prepare: makeStatement,
      async batch() {
        return [];
      },
    } as unknown as D1Database;
  }
}

interface Harness {
  env: Env;
  db: FakeSnapshotDb;
  /** Every URL the Worker fetched, in order. */
  fetches: string[];
  /** What the route stored in the edge cache, by key. */
  edge: Map<string, Response>;
  restore(): void;
}

interface HarnessOptions {
  archived?: string;
  archivedStatus?: number;
  snapshot?: SnapshotRow | null;
  /**
   * Answer a request before the defaults do: an archive redirect, an asset, a
   * different content type. `undefined` falls through to the default behaviour.
   */
  respond?: (url: string) => Response | undefined;
  /** Edge cache contents, by key; `put` writes land here too. */
  edge?: Map<string, Response>;
  /** The static-assets binding, for the app-shell path. */
  assets?: Fetcher;
}

function harness(options: HarnessOptions = {}): Harness {
  const db = new FakeSnapshotDb(options.snapshot ?? null);
  const fetches: string[] = [];

  const edge = options.edge ?? new Map<string, Response>();
  const env = {
    DB: db.binding(),
    ...(options.assets ? { ASSETS: options.assets } : {}),
    // `serveCachedPage` calls R2 only when the cache misses; an empty bucket is what
    // makes the route fall through to the on-demand path.
    STORAGE: {
      async get() {
        return null;
      },
    } as unknown as R2Bucket,
    CRAWLER_USER_AGENT: "CustomWaybackTestBot/1.0",
    SNAPSHOT_BEHAVIOR: "exact",
    PURGE_GRACE_SECONDS: "1800",
  } as unknown as Env;

  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetches.push(url);
    const scripted = options.respond?.(url);
    if (scripted) return scripted;
    if (url.includes("id_")) {
      return new Response(options.archived ?? ARCHIVED_HTML, {
        status: options.archivedStatus ?? 200,
        headers: { "content-type": "text/html" },
      });
    }
    // Any other request from this route would be the bug the comment in viewer.ts
    // warns about: fetching assets at read time.
    return new Response("unexpected fetch", { status: 500 });
  }) as typeof globalThis.fetch;

  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(key: string) {
        const hit = edge.get(key);
        return hit ? hit.clone() : undefined;
      },
      async put(key: string, response: Response) {
        // Read the body now, as the real cache does, so a test sees what was stored.
        const body = await response.arrayBuffer();
        edge.set(key, new Response(body, { status: response.status, headers: response.headers }));
      },
    },
  };

  return {
    env,
    db,
    fetches,
    edge,
    restore: () => {
      globalThis.fetch = originalFetch;
      (globalThis as { caches?: unknown }).caches = originalCaches;
    },
  };
}

async function runOnDemand(path = "/"): Promise<{ response: Response; html: string; h: Harness }> {
  const h = harness();
  const response = await fetchOnDemand(DOMAIN, DAY, path, TS, h.env);
  return { response, html: await response.text(), h };
}

/**
 * The execution context Hono hands the route. `waitUntil` work is collected so a test can
 * wait for the background writes (edge cache, warming) it is asserting on.
 */
const pending: Promise<unknown>[] = [];
const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    pending.push(promise);
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function settle(): Promise<void> {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

// ── The contract, as values ──────────────────────────────────────────────────

test("the head contract injects exactly the runtime ids, CSS and JS the ingest rewriter injects", () => {
  const injection = headInjection({ baseHref: SNAPSHOT_BASE });

  assert.equal(injection.runtimeScriptId, RUNTIME_SCRIPT_ID);
  assert.equal(injection.runtimeStyleId, RUNTIME_STYLE_ID);
  assert.equal(HEAD_CONTRACT.runtimeScript, RUNTIME_SCRIPT);
  assert.equal(HEAD_CONTRACT.runtimeCss, RUNTIME_CSS);

  assert.ok(injection.parts.runtimeScript.includes(`id="${RUNTIME_SCRIPT_ID}"`));
  assert.ok(injection.parts.runtimeScript.includes(RUNTIME_SCRIPT));
  assert.ok(injection.parts.runtimeStyle.includes(`id="${RUNTIME_STYLE_ID}"`));
  assert.ok(injection.parts.runtimeStyle.includes(RUNTIME_CSS));
  assert.equal(injection.parts.base, `<base href="${SNAPSHOT_BASE}">`);
  assert.ok(injection.parts.cspMeta.includes(`content="${escapeAttribute(snapshotCsp())}"`));

  // The order is the contract: a meta-delivered CSP only governs what follows it, and
  // the shims have to exist before any archived script runs.
  const positions = [
    injection.html.indexOf(injection.parts.cspMeta),
    injection.html.indexOf(injection.parts.runtimeStyle),
    injection.html.indexOf(injection.parts.runtimeScript),
    injection.html.indexOf(injection.parts.base),
  ];
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    `the injected block is out of order: ${positions.join(", ")}`,
  );
  assert.ok(positions.every((position) => position >= 0));

  // `metas` is how the on-demand path tells the runtime which rendition it is in.
  const withMeta = headInjection({ baseHref: SNAPSHOT_BASE, metas: { "cw-mirror": '{"day":"x"}' } });
  assert.ok(withMeta.html.includes('<meta name="cw-mirror" content="{&quot;day&quot;:&quot;x&quot;}">'));
});

test("snapshotCsp() is the §10 policy, and extra directives can only add to it", () => {
  // The plan's own words, so the policy cannot drift into something merely similar.
  assert.ok(snapshotCsp().startsWith("default-src 'self' 'unsafe-inline' data: blob:"));
  assert.ok(HEAD_CONTRACT.csp === SNAPSHOT_CSP);
  assert.equal(snapshotCsp(), SNAPSHOT_CSP);
  assert.equal(snapshotCsp("   "), SNAPSHOT_CSP, "blank extras are not directives");
  assert.equal(snapshotCsp("report-uri /cw-report"), `${SNAPSHOT_CSP}; report-uri /cw-report`);

  for (const directive of ["form-action 'none'", "base-uri 'self'", "object-src 'none'", "frame-src 'self'"]) {
    assert.ok(SNAPSHOT_CSP.includes(directive), `the §10 policy must state ${directive}`);
  }
  // Deliberately absent: browsers ignore `frame-ancestors` in a meta-delivered policy.
  assert.ok(!SNAPSHOT_CSP.includes("frame-ancestors"));
});

test("the contract data says what is stripped and how a form is neutralised", () => {
  assert.deepEqual([...HEAD_CONTRACT.strippedMetaHttpEquiv], ["refresh"]);
  assert.deepEqual([...HEAD_CONTRACT.strippedMetaNames], ["robots"]);

  // Case is not a detail on pages written across thirty years.
  assert.equal(isStrippedMeta("refresh", null), true);
  assert.equal(isStrippedMeta("Refresh", null), true);
  assert.equal(isStrippedMeta(null, "robots"), true);
  assert.equal(isStrippedMeta(null, "ROBOTS"), true);
  assert.equal(isStrippedMeta("Content-Security-Policy", null), false);
  assert.equal(isStrippedMeta(null, "cw-mirror"), false);
  assert.equal(isStrippedMeta(null, null), false);

  // Only a foreign base goes; the base the viewer injected survives even if a rewriter
  // were to re-visit its own output.
  assert.equal(isForeignBase("https://evil.test/", SNAPSHOT_BASE), true);
  assert.equal(isForeignBase(null, SNAPSHOT_BASE), true);
  assert.equal(isForeignBase(SNAPSHOT_BASE, SNAPSHOT_BASE), false);

  assert.deepEqual(formNeutralisation("/search"), {
    removeAttribute: "action",
    attributes: {
      "data-cw-action": "/search",
      onsubmit: "return false",
      "data-cw-disabled": "1",
    },
  });
  // A form with no action posts to its own URL; recorded as empty rather than as
  // "undefined", which is what the ingest rewriter stores.
  assert.equal(formNeutralisation(null).attributes["data-cw-action"], "");
});

test("script triage stubs dead third-party hosts and keeps everything else", () => {
  assert.equal(scriptDisposition(GA_URL), "stub");
  assert.equal(scriptDisposition("https://www.googletagmanager.com/gtm.js?id=GTM-1"), "stub");
  assert.equal(scriptDisposition("https://connect.facebook.net/en_US/fbevents.js"), "stub");
  assert.equal(scriptDisposition("/app.js"), "keep", "same-origin app code is the page, not a beacon");
  assert.equal(scriptDisposition("app.js"), "keep");
  assert.equal(scriptDisposition("https://cdn.example.com/jquery.min.js"), "keep");
  assert.equal(scriptDisposition("data:text/javascript,void 0"), "keep");
});

test("stubScriptHtml() builds the ingest marker and escapes the URL it carries", () => {
  assert.equal(
    stubScriptHtml(GA_URL),
    `<script type="text/plain" class="cw-stub" data-cw-stub="${GA_URL}"></script>`,
  );
  // A URL is a stranger's bytes: it must not be able to end the attribute early.
  const nasty = 'https://evil.test/x.js" onload="alert(1)';
  const marker = stubScriptHtml(nasty);
  assert.ok(!marker.includes('" onload='), marker);
  assert.ok(marker.includes(escapeAttribute(nasty)));
  assert.equal(HEAD_CONTRACT.stubScript.type, "text/plain");
  assert.equal(HEAD_CONTRACT.stubScript.className, "cw-stub");
});

test("the runtime stylesheet and script cannot break out of their raw-text elements", () => {
  // Both are injected raw — character references are not decoded inside `<style>` or
  // `<script>`, so escaping them would corrupt the CSS and the code. That makes "no
  // closing tag inside" a precondition of the raw insertion, so it is asserted.
  assert.ok(!RUNTIME_CSS.includes("</style"), "RUNTIME_CSS would end its own element");
  assert.ok(!RUNTIME_SCRIPT.includes("</script"), "RUNTIME_SCRIPT would end its own element");
  assert.ok(RUNTIME_SCRIPT.includes("__cwRuntime"), "the shim the §6.4 contract is about");
});

test("the HTMLRewriter stand-in refuses header mutation, like the real transform() result", async () => {
  const upstream = new Response(ARCHIVED_HTML, { headers: { "content-type": "text/html" } });
  const transformed = new StandInHTMLRewriter().transform(upstream);
  assert.throws(() => transformed.headers.set("X-Test", "1"), /immutable/i);
  assert.equal(await transformed.text(), ARCHIVED_HTML, "with no handlers the bytes pass through");
});

// ── The on-demand output ─────────────────────────────────────────────────────

test("the on-demand output carries the runtime, the CSP and the snapshot base", async () => {
  const { response, html, h } = await runOnDemand();
  try {
    assert.equal(response.status, 200);
    const { document } = parseHTML(html);

    const runtime = document.querySelector(`#${RUNTIME_SCRIPT_ID}`);
    assert.ok(runtime, "the runtime shim is the whole point of §6.4's shim injection");
    assert.equal(runtime?.textContent, RUNTIME_SCRIPT, "the runtime is the pipeline's, byte for byte");
    assert.ok(html.includes(`id="${RUNTIME_STYLE_ID}"`), "the injected stylesheet is missing");

    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    assert.ok(csp, "an archived page with no CSP is untrusted code running unbounded (§10)");
    assert.equal(csp?.getAttribute("content"), snapshotCsp(), "the CSP must be the pipeline's value");

    const bases = Array.from(document.querySelectorAll("base"));
    assert.equal(bases.length, 1, "exactly one base, ours");
    assert.equal(bases[0]?.getAttribute("href"), SNAPSHOT_BASE);

    // The runtime reports what it is looking at to the shell; on this path that is the
    // on-demand rendition.
    const mirror = document.querySelector('meta[name="cw-mirror"]');
    assert.ok(mirror, "the toolbar bridge meta is missing");
    assert.deepEqual(JSON.parse(mirror?.getAttribute("content") ?? "{}"), {
      day: DAY,
      url: PAGE_URL,
      ts: TS,
      source: "on-demand",
      resolvedDay: DAY,
      deltaDays: null,
      resourceProxy: true,
    });
  } finally {
    h.restore();
  }
});

test("the on-demand output drops the capture's own base, meta refresh and meta robots", async () => {
  const { html, h } = await runOnDemand();
  try {
    const { document } = parseHTML(html);

    assert.equal(document.querySelectorAll('base[href="https://evil.test/"]').length, 0);
    assert.ok(!html.includes("evil.test"), "a competing base resolves relative URLs against the original host");
    assert.equal(document.querySelectorAll('meta[http-equiv="refresh"]').length, 0);
    assert.ok(!/http-equiv="refresh"/i.test(html), "a meta refresh drags the visitor out of the mirror");
    assert.equal(document.querySelectorAll('meta[name="robots"]').length, 0);
  } finally {
    h.restore();
  }
});

test("the on-demand output stubs a dead analytics script and keeps a live app script", async () => {
  const { html, h } = await runOnDemand();
  try {
    const { document } = parseHTML(html);

    const stubbed = document.querySelector(`script.cw-stub[data-cw-stub="${GA_URL}"]`);
    assert.ok(stubbed, "the analytics script must become an inert marker, not a live request");
    assert.equal(stubbed?.getAttribute("type"), "text/plain");

    const liveSources = Array.from(document.querySelectorAll("script[src]")).map((el) => el.getAttribute("src"));
    assert.deepEqual(
      liveSources,
      [`/_cw/r/${TS}/https/example.com/app.js`],
      `only the app script may stay live, through the resource route; got ${JSON.stringify(liveSources)}`,
    );
    assert.ok(!html.includes(`src="${GA_URL}"`), "the dead URL must not survive as a live src");
    assert.ok(!document.querySelector("#ga-script"), "the original script element should be replaced outright");

    // A script with no src is page code and is left exactly as it was.
    assert.ok(document.querySelector("#app-inline"), "inline scripts are not triaged");
  } finally {
    h.restore();
  }
});

test("the on-demand output neutralises form actions", async () => {
  const { html, h } = await runOnDemand();
  try {
    const { document } = parseHTML(html);
    const form = document.querySelector("form");
    assert.ok(form, "the fixture has a form");
    assert.equal(form?.getAttribute("action"), null, "a live form action posts into the internet (§10)");
    assert.equal(form?.getAttribute("data-cw-action"), "/search", "the author's intent is preserved for the shell");
    assert.equal(form?.getAttribute("onsubmit"), "return false");
    assert.equal(form?.getAttribute("data-cw-disabled"), "1");
  } finally {
    h.restore();
  }
});

test("the on-demand response is labelled, unindexable, uncached, and its headers are ours to decorate", async () => {
  const { response, h } = await runOnDemand();
  try {
    assert.equal(response.headers.get("X-Custom-Wayback-Source"), "on-demand");
    assert.equal(response.headers.get("X-Robots-Tag"), HEAD_CONTRACT.robotsContent);
    assert.ok((response.headers.get("X-Robots-Tag") ?? "").includes("noindex"));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");

    // `src/index.ts` decorates every response by mutating headers in place
    // (`secureHeaders`, and `injectToolbarHeaders` on the R2 path). The response this
    // route returns must therefore be mutable — the transformer's own response is not.
    response.headers.set("X-Wayback-Resolved-Day", DAY);
    response.headers.delete("X-Wayback-Resolved-Day");
  } finally {
    h.restore();
  }
});

test("the injected runtime precedes every archived script in the served document", async () => {
  const { html, h } = await runOnDemand();
  try {
    const runtimeAt = html.indexOf(`id="${RUNTIME_SCRIPT_ID}"`);
    const cspAt = html.indexOf('http-equiv="Content-Security-Policy"');
    // The analytics element is gone by now — it was replaced by its marker — so the
    // marker stands in for it, and the markers for the two kept scripts stand for
    // themselves. All three are body content, i.e. stuff that runs after head.
    const archived = [
      'id="app-js"',
      'id="app-inline"',
      `data-cw-stub="${GA_URL}"`,
    ].map((needle) => [needle, html.indexOf(needle)] as const);

    assert.ok(runtimeAt >= 0 && cspAt >= 0);
    for (const [needle, position] of archived) {
      assert.ok(position >= 0, `expected ${needle} in the served document`);
      assert.ok(position > runtimeAt, `an archived script ran before the shims existed (${needle})`);
      // A meta-delivered policy only governs what follows it, so it has to lead too.
      assert.ok(position > cspAt, `an archived script ran before the CSP governed it (${needle})`);
    }
  } finally {
    h.restore();
  }
});

test("a capture with no <head> still gets the contract", async () => {
  const headless = `<!DOCTYPE html><html><body><p>1996 called</p><script src="${GA_URL}"></script></body></html>`;
  const h = harness({ archived: headless });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    const html = await response.text();
    const { document } = parseHTML(html);

    assert.ok(html.includes(`id="${RUNTIME_SCRIPT_ID}"`), "the runtime must still be injected");
    assert.ok(html.includes(`<base href="${SNAPSHOT_BASE}">`), "and the base");
    assert.ok(html.indexOf(`id="${RUNTIME_SCRIPT_ID}"`) < html.indexOf("<body"), "the injected head comes first");
    assert.ok(document.querySelector("script.cw-stub"), "and triage still runs");
  } finally {
    h.restore();
  }
});

test("an upstream failure is a 502, not a half-rewritten page", async () => {
  const h = harness({ archivedStatus: 404 });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /404/);
  } finally {
    h.restore();
  }
});

// ── The route decides to use it ──────────────────────────────────────────────

test("the route sends a purged snapshot down the on-demand path", async () => {
  const h = harness({
    snapshot: {
      id: "snap-1",
      r2_key: null,
      ts: TS,
      resolved_day: null,
      delta_days: null,
      purged_at: 1_700_000_000,
      served_at: 1_699_000_000,
    },
  });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, h.env, executionCtx);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("X-Custom-Wayback-Source"),
      "on-demand",
      "a page whose blob the purge job deleted must not fall back to a naive rewrite",
    );
    assert.ok(html.includes(`id="${RUNTIME_SCRIPT_ID}"`));
    assert.equal(h.fetches.length, 1, "exactly one upstream request: no assets on the read path");
    assert.ok(
      h.fetches[0]?.startsWith(`${WAYBACK_RAW_BASE}/${TS}id_/${PAGE_URL}`),
      `raw id_ bytes, got ${h.fetches[0]}`,
    );
    assert.deepEqual(h.db.unrecognised, [], "the fake understood every statement the route issued");
  } finally {
    h.restore();
  }
});

test("the route falls through to the on-demand path when R2 has nothing", async () => {
  const h = harness({
    // The row still claims an R2 key, so this is the "cache miss" branch rather than
    // the purge branch — the other way into the same function.
    snapshot: {
      id: "snap-2",
      r2_key: `pages/${DOMAIN}/${DAY}/deadbeefdeadbeef.html`,
      ts: TS,
      resolved_day: null,
      delta_days: null,
      purged_at: null,
      served_at: null,
    },
  });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, h.env, executionCtx);
    const html = await response.text();
    const { document } = parseHTML(html);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Custom-Wayback-Source"), "on-demand");
    // The route allows its own origin for mirrored resources: an opaque-origin frame
    // cannot match them with 'self' alone.
    assert.equal(
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      snapshotCspForOrigin("http://localhost"),
      "the same policy, whichever way the page arrived",
    );
    const header = response.headers.get("Content-Security-Policy") ?? "";
    assert.ok(header.startsWith(snapshotCspForOrigin("http://localhost")), header);
    assert.match(header, /; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox$/);
  } finally {
    h.restore();
  }
});

test("asset references go through the same-origin resource route, and none is fetched at read time", async () => {
  // Rewriting a reference is a string transformation; fetching it is the browser's
  // business, later, through `/_cw/r/`. The page path itself must never fetch assets —
  // that would put archive.org back on the critical path (§3.1) — and the policy must
  // never allow-list the original hosts, which is what keeps a dead beacon dead (§10).
  const { html, h } = await runOnDemand();
  try {
    const { document } = parseHTML(html);
    assert.equal(
      document.querySelector('link[rel="stylesheet"]')?.getAttribute("href"),
      `/_cw/r/${TS}/https/example.com/style.css`,
    );
    assert.equal(document.querySelector("img")?.getAttribute("src"), `/_cw/r/${TS}/https/cdn.example.com/logo.png`);
    assert.equal(h.fetches.length, 1, `only the page fetch is allowed, saw ${h.fetches.join(", ")}`);
    assert.ok(!snapshotCsp().includes("cdn.example.com"), "the policy must not allow-list the original origin");
  } finally {
    h.restore();
  }
});

// ── Contract equivalence with the ingest rewriter ────────────────────────────

test("contract equivalence: ingest and on-demand cannot drift on ids, robots intent, triage or forms", async () => {
  const h = harness();
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    const onDemandHtml = await response.text();
    const onDemand = parseHTML(onDemandHtml).document;

    // The real ingest rewriter, over the same archived bytes, in the state an ingest
    // job is in for its first page: nothing fetched yet, so no asset map and no link
    // map. This is a different code path, a different parser and — deliberately — a
    // different rendition of the same decisions.
    //
    // Asset *references* are excluded from the comparison, by design: the on-demand
    // path cannot build the content-addressed asset map without fetching and hashing
    // the assets, so `src`/`href`/`url()` are left pointing at their original absolute
    // URLs there (and the §10 CSP blocks those requests). Everything that is not an
    // asset reference has to agree, and is compared below.
    const { document: ingestDom } = parseHTML(ARCHIVED_HTML);
    const ingest = rewriteHtml(ingestDom, {
      domain: DOMAIN,
      day: DAY,
      pageUrl: PAGE_URL,
      assetMap: new Map(),
      linkMap: new Map(),
    });
    const ingestDoc = parseHTML(ingest.html).document;

    // 1. Runtime ids and payloads: the same elements, from the same pipeline constants.
    assert.equal(ingestDoc.querySelector(`#${RUNTIME_SCRIPT_ID}`)?.textContent, RUNTIME_SCRIPT);
    assert.equal(ingestDoc.querySelector(`#${RUNTIME_STYLE_ID}`)?.textContent, RUNTIME_CSS);
    assert.equal(onDemand.querySelector(`#${RUNTIME_SCRIPT_ID}`)?.textContent, RUNTIME_SCRIPT);
    assert.ok(onDemandHtml.includes(`id="${RUNTIME_STYLE_ID}"`));

    // 2. The noindex intent: the ingest path writes it into a meta, this path into a
    //    response header, and both must be the pipeline's one value.
    assert.equal(ingestDoc.querySelector('meta[name="robots"]')?.getAttribute("content"), HEAD_CONTRACT.robotsContent);
    assert.equal(response.headers.get("X-Robots-Tag"), HEAD_CONTRACT.robotsContent);
    assert.equal(onDemand.querySelectorAll('meta[name="robots"]').length, 0, "the capture's own is stripped");

    // 3. Base handling: both paths remove the capture's base and inject their own.
    assert.equal(ingestDoc.querySelectorAll("base").length, 1);
    assert.equal(ingestDoc.querySelector('base[href="https://evil.test/"]'), null);
    assert.equal(onDemand.querySelector('base[href="https://evil.test/"]'), null);
    // The values differ on purpose: the ingest path has already rewritten every URL to
    // an absolute route, so `/` is enough there, while an on-demand page still has
    // relative URLs that must land on the snapshot route.
    assert.equal(ingestDoc.querySelector("base")?.getAttribute("href"), "/");
    assert.equal(onDemand.querySelector("base")?.getAttribute("href"), SNAPSHOT_BASE);

    // 4. Script triage: the dead host is stubbed by both, with the same marker and the
    //    same recorded URL. The ingest rewriter's list is its own copy, so this is a
    //    real drift detector between the two, not a tautology.
    const ingestStub = ingestDoc.querySelector("script[data-cw-stub]");
    const onDemandStub = onDemand.querySelector("script[data-cw-stub]");
    assert.ok(ingestStub, "the ingest rewriter must stub the dead analytics host too");
    assert.ok(onDemandStub, "the on-demand path must stub it");
    for (const stub of [ingestStub, onDemandStub]) {
      assert.equal(stub?.getAttribute("type"), HEAD_CONTRACT.stubScript.type);
      assert.equal(stub?.getAttribute("class"), HEAD_CONTRACT.stubScript.className);
      assert.equal(stub?.getAttribute("data-cw-stub"), GA_URL);
    }
    // `/app.js` is *kept* by triage on both paths; the renditions differ afterwards —
    // with no asset bytes at ingest it becomes a `data-cw-missing` marker, and at read
    // time it is served through the resource route.
    assert.equal(scriptDisposition("/app.js"), "keep");
    assert.equal(ingestDoc.querySelector('script[data-cw-missing="/app.js"]')?.getAttribute("type"), "text/plain");
    assert.ok(onDemand.querySelector(`script[src="/_cw/r/${TS}/https/example.com/app.js"]`));

    // 5. Form neutralisation: the attribute sets must be identical, attribute for
    //    attribute, from the same contract data.
    const ingestForm = ingestDoc.querySelector("form");
    const onDemandForm = onDemand.querySelector("form");
    const formAttributes = (form: Element | null): Record<string, string> =>
      Object.fromEntries(
        Array.from(form?.attributes ?? []).map((attribute) => [attribute.name, attribute.value]),
      );
    assert.deepEqual(formAttributes(onDemandForm), formAttributes(ingestForm));
    assert.equal(onDemandForm?.getAttribute("action"), null);
    assert.equal(onDemandForm?.getAttribute("data-cw-action"), "/search");
    assert.equal(onDemandForm?.getAttribute("onsubmit"), "return false");
    assert.equal(onDemandForm?.getAttribute("data-cw-disabled"), "1");

    // 6. Strip lists agree: neither path may keep a meta refresh or a meta robots.
    assert.equal(ingestDoc.querySelectorAll('meta[http-equiv="refresh"]').length, 0);
    assert.equal(onDemand.querySelectorAll('meta[http-equiv="refresh"]').length, 0);
  } finally {
    h.restore();
  }
});

// ── Finding the capture: the archive's redirects, followed by hand ───────────

/** An archive redirect, the way `id_` replay sends one. */
function archiveRedirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { Location: location } });
}

test("a redirect the site itself made when captured moves the viewer to that route", async () => {
  // samsung.com's homepage is captured as a 301 to /us/. Serving /us/ under the `/`
  // route would resolve every relative link against the wrong directory.
  const h = harness({
    respond: (url) =>
      url === `${WAYBACK_RAW_BASE}/${TS}id_/${PAGE_URL}`
        ? archiveRedirect(301, `/web/${TS}id_/https://www.example.com/us/`)
        : undefined,
  });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), `/a/${DOMAIN}/${DAY}/us/`);
    assert.equal(h.fetches.length, 1, "the redirect is answered without fetching its target");
  } finally {
    h.restore();
  }
});

test("the archive's own nearest-capture redirect is followed, and the page says which capture it is", async () => {
  const nearest = "20240314235959";
  const h = harness({
    respond: (url) =>
      url === `${WAYBACK_RAW_BASE}/${TS}id_/${PAGE_URL}`
        ? archiveRedirect(302, `https://web.archive.org/web/${nearest}id_/https://www.example.com/`)
        : undefined,
  });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(h.fetches, [
      `${WAYBACK_RAW_BASE}/${TS}id_/${PAGE_URL}`,
      `${WAYBACK_RAW_BASE}/${nearest}id_/https://www.example.com/`,
    ]);
    const mirror = JSON.parse(
      parseHTML(html).document.querySelector('meta[name="cw-mirror"]')?.getAttribute("content") ?? "{}",
    );
    assert.equal(mirror.ts, nearest);
    assert.equal(mirror.url, "https://www.example.com/");
    assert.equal(mirror.resolvedDay, "2024-03-14", "the toolbar can say the capture is from the day before");
  } finally {
    h.restore();
  }
});

test("an archive redirect that leaves web.archive.org is never followed", async () => {
  const h = harness({
    respond: (url) => (url.includes("id_") ? archiveRedirect(302, "https://live.example.com/") : undefined),
  });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    assert.equal(response.status, 502);
    assert.ok(!h.fetches.some((url) => url.startsWith("https://live.example.com")));
  } finally {
    h.restore();
  }
});

// ── The route: edge cache, app shell, subresources ───────────────────────────

test("a rendered page is stored at the edge, and the next visit is served from it with no D1 or archive work", async () => {
  const edge = new Map<string, Response>();
  const first = harness({ edge });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, first.env, executionCtx);
    await response.text();
    await settle();
    assert.equal(response.headers.get("X-Custom-Wayback-Cache"), "miss");
    assert.equal(response.headers.get("Cache-Control"), "no-store", "the browser never keeps it");
    assert.equal(response.headers.get("X-CW-Edge-Store"), null, "the internal marker never leaves the Worker");
    assert.equal(edge.size, 1);
    const [stored] = [...edge.values()];
    assert.match(stored?.headers.get("Cache-Control") ?? "", /public, max-age=\d+/);
  } finally {
    first.restore();
  }

  const second = harness({ edge });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, second.env, executionCtx);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Custom-Wayback-Cache"), "hit");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(html.includes(`id="${RUNTIME_SCRIPT_ID}"`));
    assert.deepEqual(second.fetches, [], "an edge hit asks archive.org nothing");
    assert.deepEqual(second.db.unrecognised, []);
  } finally {
    second.restore();
  }
});

test("a failure is not stored at the edge", async () => {
  const edge = new Map<string, Response>();
  const h = harness({ edge, archivedStatus: 503 });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, h.env, executionCtx);
    await response.text();
    await settle();
    assert.equal(response.status, 502);
    assert.equal(edge.size, 0);
  } finally {
    h.restore();
  }
});

test("a top-level navigation to a viewer URL gets the app shell, not the archived page", async () => {
  const shellHtml = "<!doctype html><div id=root></div>";
  const assets = {
    async fetch(request: Request) {
      assert.equal(new URL(request.url).pathname, "/");
      return new Response(shellHtml, { headers: { "Content-Type": "text/html" } });
    },
  } as unknown as Fetcher;
  const h = harness({ assets });
  try {
    const response = await viewerRouter.request(
      `/${DOMAIN}/${DAY}/about`,
      { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" } },
      h.env,
      executionCtx,
    );
    assert.equal(await response.text(), shellHtml);
    assert.deepEqual(h.fetches, [], "the shell never touches archive.org");
    response.headers.set("X-Test", "1"); // the response is ours to decorate
  } finally {
    h.restore();
  }
});

test("a subresource request on a viewer route is answered with the archived asset, not a rewritten page", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const h = harness({
    respond: (url) =>
      url.endsWith("id_/https://example.com/img/hero.png")
        ? new Response(png, { headers: { "Content-Type": "image/png" } })
        : undefined,
  });
  try {
    const response = await viewerRouter.request(
      `/${DOMAIN}/${DAY}/img/hero.png`,
      { headers: { "Sec-Fetch-Dest": "image" } },
      h.env,
      executionCtx,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
    assert.deepEqual(h.fetches, [
      `${WAYBACK_RAW_BASE}/${DAY.replace(/-/g, "")}120000id_/https://example.com/img/hero.png`,
    ]);
  } finally {
    h.restore();
  }
});

test("a capture that is not a document is served as itself", async () => {
  const h = harness({
    respond: (url) =>
      url.includes("id_") ? new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } }) : undefined,
  });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/brochure.pdf", TS, h.env);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.equal(await response.text(), "%PDF-1.4");
  } finally {
    h.restore();
  }
});

test("a page that declares its encoding only in markup is labelled with it", async () => {
  // The injected head pushes the page's own <meta charset> past the 1024 bytes a
  // browser scans, so the header has to say it.
  const latin1 = `<!DOCTYPE html><html><head><meta charset="iso-8859-1"><title>cafe</title></head><body></body></html>`;
  const h = harness({
    respond: (url) =>
      url.includes("id_") ? new Response(latin1, { headers: { "Content-Type": "text/html" } }) : undefined,
  });
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/", TS, h.env);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=iso-8859-1");
  } finally {
    h.restore();
  }
});

test("a page's base is its own directory, so its script resolves relative URLs as the original did", async () => {
  const h = harness();
  try {
    const response = await fetchOnDemand(DOMAIN, DAY, "/iphone/index.html", TS, h.env);
    const { document } = parseHTML(await response.text());
    assert.equal(document.querySelector("base")?.getAttribute("href"), `/a/${DOMAIN}/${DAY}/iphone/`);
  } finally {
    h.restore();
  }
});

// ── The resource URL scheme and the leak net ─────────────────────────────────

test("resource paths keep the original directory structure and round-trip", () => {
  const original = new URL("https://www.apple.com:8443/v/home/main.built.js?v=3");
  const path = resourcePath(TS, original);
  assert.equal(path, `/_cw/r/${TS}/https/www.apple.com:8443/v/home/main.built.js?v=3`);
  assert.ok(!path.includes("//"), "no double slash for anything in between to collapse");

  // What makes webpack's publicPath 'auto' and `import './chunk.js'` work: resolving
  // relative to the proxied file lands on the proxied sibling.
  const sibling = new URL("./chunk.js", `https://app.test${path}`);
  assert.deepEqual(parseResourcePath(sibling.pathname, sibling.search), {
    ts: TS,
    url: "https://www.apple.com:8443/v/home/chunk.js",
  });

  const parsed = parseResourcePath(`/_cw/r/${TS}/https/www.apple.com:8443/v/home/main.built.js`, "?v=3");
  assert.deepEqual(parsed, { ts: TS, url: original.href });
  assert.equal(parseResourcePath(`/_cw/r/2024/https/a.test/x`, ""), null, "a timestamp is 14 digits");
  assert.equal(parseResourcePath(`/_cw/r/${TS}/ftp/a.test/x`, ""), null, "http(s) only");
});

test("a root-relative URL an archived page built in script is recovered from its Referer", () => {
  const leak = (path: string, headers: Record<string, string>) =>
    leakedArchiveResource(new Request(`https://app.test${path}`, { headers }));

  assert.deepEqual(
    leak("/images/hero.jpg", {
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Site": "cross-site",
      Referer: `https://app.test/a/${DOMAIN}/${DAY}/iphone/`,
    }),
    { ts: `${DAY.replace(/-/g, "")}120000`, url: "https://example.com/images/hero.jpg", destination: "image" },
  );

  // A stylesheet's own relative reference, issued from the proxied stylesheet.
  assert.deepEqual(
    leak("/fonts/a.woff2", {
      "Sec-Fetch-Dest": "font",
      "Sec-Fetch-Site": "cross-site",
      Referer: `https://app.test/_cw/r/${TS}/https/www.apple.com/v/styles/main.css`,
    }),
    { ts: TS, url: "https://www.apple.com/fonts/a.woff2", destination: "font" },
  );

  // The app shell's own requests are same-origin and are never touched.
  assert.equal(
    leak("/favicon.ico", {
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Site": "same-origin",
      Referer: `https://app.test/a/${DOMAIN}/${DAY}/`,
    }),
    null,
  );
  // Navigations and fetches are not assets.
  assert.equal(
    leak("/about", {
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Site": "cross-site",
      Referer: `https://app.test/a/${DOMAIN}/${DAY}/`,
    }),
    null,
  );
  // A Referer from another origin proves nothing.
  assert.equal(
    leak("/x.png", {
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Site": "cross-site",
      Referer: `https://elsewhere.test/a/${DOMAIN}/${DAY}/`,
    }),
    null,
  );
});

// ── Warming ──────────────────────────────────────────────────────────────────

test("warming prepares likely next pages and what they need to paint, at most two, never twice", async () => {
  const edge = new Map<string, Response>();
  const h = harness({ edge });
  try {
    const routes = [
      `/a/${DOMAIN}/${DAY}/one`,
      `/a/${DOMAIN}/${DAY}/one#section`, // same page
      "/not-a-route",
      `/a/${DOMAIN}/not-a-day/x`,
      ...Array.from({ length: 8 }, (_, i) => `/a/${DOMAIN}/${DAY}/p${i}`),
    ];
    const accepted = scheduleWarm(h.env, executionCtx, "https://app.test", routes);
    assert.equal(accepted, 2, "one warm request prepares a small batch");
    await settle();

    const pages = [...edge.keys()].filter((key) => key.includes("/page/"));
    assert.equal(pages.length, 2);
    // The fixture's stylesheet and its blocking app script are warmed with the first
    // page; the second page shares them, so they cost nothing more. The analytics script
    // is stubbed, never fetched.
    const archived = h.fetches.filter((url) => url.includes("id_"));
    assert.equal(archived.filter((url) => url.endsWith("/style.css")).length, 1);
    assert.equal(archived.filter((url) => url.endsWith("/app.js")).length, 1);
    assert.equal(archived.length, 2 + 2, "two pages and two shared assets");
    assert.ok(!h.fetches.some((url) => url.includes("google-analytics")));

    // Already at the edge: a second warm costs no archive request at all.
    const before = h.fetches.length;
    scheduleWarm(h.env, executionCtx, "https://app.test", routes);
    await settle();
    assert.equal(h.fetches.length, before);
  } finally {
    h.restore();
  }
});

test("warming stands down while archive.org is throttling, including after a visit was throttled", async () => {
  const throttle = (url: string) => (url.includes("id_") ? new Response("Too Many Requests", { status: 429 }) : undefined);
  const edge = new Map<string, Response>();
  const h = harness({ edge, respond: throttle });
  try {
    scheduleWarm(h.env, executionCtx, "https://app.test", [`/a/${DOMAIN}/${DAY}/one`, `/a/${DOMAIN}/${DAY}/two`]);
    await settle();
    // The first 429 ends the batch: the second page is never asked for.
    assert.equal(h.fetches.filter((url) => url.includes("id_")).length, 1);
    assert.ok(![...edge.keys()].some((key) => key.includes("/page/")), "a throttled page is not stored");

    // The data centre remembers, so the next batch asks for nothing.
    const before = h.fetches.length;
    scheduleWarm(h.env, executionCtx, "https://app.test", [`/a/${DOMAIN}/${DAY}/three`]);
    await settle();
    assert.equal(h.fetches.length, before);
  } finally {
    h.restore();
  }

  // A visit is still attempted while throttled — the reader asked for it — and its 429
  // is what tells the prefetcher to wait.
  const visitEdge = new Map<string, Response>();
  const visit = harness({ edge: visitEdge, respond: throttle });
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, visit.env, executionCtx);
    assert.match(await response.text(), /rate-limiting/);
    await settle();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("X-Custom-Wayback-Archive"), "throttled");

    const before = visit.fetches.length;
    scheduleWarm(visit.env, executionCtx, "https://app.test", [`/a/${DOMAIN}/${DAY}/four`]);
    await settle();
    assert.equal(visit.fetches.length, before);
  } finally {
    visit.restore();
  }
});

test("warming ignores anything that is not a list of routes", () => {
  const h = harness();
  try {
    assert.equal(scheduleWarm(h.env, executionCtx, "https://app.test", "nope"), 0);
    assert.equal(scheduleWarm(h.env, executionCtx, "https://app.test", [42, null, "/v1/jobs"]), 0);
  } finally {
    h.restore();
  }
});

// ── The archive-only frame origin ────────────────────────────────────────────

const APP = "https://app.test";

function frameHarness(options: HarnessOptions = {}): Harness {
  const h = harness(options);
  Object.assign(h.env, { ROLE: "frame", APP_ORIGIN: APP });
  return h;
}

test("on the frame origin an archived page keeps a real origin; on the app origin it never does", async () => {
  const onApp = harness();
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, onApp.env, executionCtx);
    await response.text();
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    assert.match(policy, /; sandbox [^;]*$/);
    assert.ok(!policy.includes("allow-same-origin"), "on the app's own origin the page must stay opaque (§10)");
  } finally {
    onApp.restore();
  }

  const onFrame = frameHarness();
  try {
    const response = await viewerRouter.request(`/${DOMAIN}/${DAY}/`, {}, onFrame.env, executionCtx);
    await response.text();
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /; sandbox [^;]*allow-same-origin/);
  } finally {
    onFrame.restore();
  }
});

test("a frame-origin URL opened on its own goes to the viewer on the app origin", async () => {
  const h = frameHarness();
  try {
    const response = await viewerRouter.request(
      `/${DOMAIN}/${DAY}/about`,
      { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" } },
      h.env,
      executionCtx,
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), `${APP}/${DOMAIN}/${DAY}/about`);
    assert.deepEqual(h.fetches, []);
  } finally {
    h.restore();
  }
});

test("on the frame origin a same-origin leak is an archived page's, and is recovered", () => {
  const request = new Request("https://frame.test/images/hero.jpg", {
    headers: {
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Site": "same-origin",
      Referer: `https://frame.test/a/${DOMAIN}/${DAY}/`,
    },
  });
  assert.equal(leakedArchiveResource(request), null, "on the app origin same-origin means the shell");
  assert.deepEqual(leakedArchiveResource(request, { sameOriginIsArchive: true }), {
    ts: `${DAY.replace(/-/g, "")}120000`,
    url: "https://example.com/images/hero.jpg",
    destination: "image",
  });
});
