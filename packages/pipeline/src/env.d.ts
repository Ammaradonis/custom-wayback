/**
 * The complete platform surface this package is allowed to use.
 *
 * These declarations exist so the package can be compiled with `lib: ["ES2022"]`
 * alone: no DOM lib (which would let `document`/`window` through), no `@types/node`
 * (which would let `process`/`Buffer` through) and no Workers types (which would let
 * `caches`/`ExecutionContext` through). Every name below — plus the ES2022 built-ins
 * — exists in both Node 22+ and Cloudflare Workers.
 *
 * If an edit here reaches for anything else platform-specific, it fails to compile
 * *here*, rather than at runtime in one of the two environments. Widening this file is
 * therefore a deliberate change to the package's runtime contract.
 */

declare class URLSearchParams implements Iterable<[string, string]> {
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParams);
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class URL {
  constructor(input: string | URL, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class TextEncoder {
  constructor();
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
