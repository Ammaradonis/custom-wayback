/**
 * A stand-in for the Workers `HTMLRewriter`, over linkedom, for the API tests.
 *
 * Node has no `lol-html`. This implements only the slice of the API the routes use
 * (`on`, `transform`, `getAttribute`/`setAttribute`/`removeAttribute`, `remove`,
 * `replace`, `prepend`, `before`) and mimics the two properties that trip real code up:
 * `transform()` returns a response whose headers are **immutable**, and handlers see
 * elements in document order, a `<head>` handler firing before its children. Why it
 * exists, and what it cannot prove, is set out at the top of `viewer.test.ts`.
 *
 * Importing this module installs it as `globalThis.HTMLRewriter`.
 */

import { parseHTML } from "linkedom";

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

export class StandInHTMLRewriter {
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
