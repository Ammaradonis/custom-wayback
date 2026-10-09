/**
 * Blob store abstraction.
 *
 * Phase 1 writes to the local filesystem. The interface is deliberately the same
 * shape as R2 (content-addressed keys, put/get/head/list), so Phase 4 swaps in an
 * S3-compatible implementation without touching the crawler or the rewriter.
 *
 * Keys are always forward-slash relative paths, e.g. "assets/ab/abcd...".
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface PutResult {
  key: string;
  bytes: number;
  /** True when the bytes were already present (content-addressed hit, no write). */
  deduped: boolean;
}

export interface BlobStore {
  put(key: string, body: Uint8Array): Promise<PutResult>;
  get(key: string): Promise<Uint8Array | undefined>;
  has(key: string): Promise<boolean>;
  /** Total bytes currently stored (sum of file sizes). */
  size(): Promise<number>;
  root(): string;
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export class FsBlobStore implements BlobStore {
  private readonly base: string;
  private readonly known = new Set<string>();

  constructor(root: string) {
    this.base = resolve(root);
  }

  root(): string {
    return this.base;
  }

  private pathFor(key: string): string {
    const clean = key.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('..')) throw new Error(`refusing suspicious blob key: ${key}`);
    const full = resolve(join(this.base, clean));
    if (full !== this.base && !full.startsWith(this.base + sep)) {
      throw new Error(`blob key escapes store root: ${key}`);
    }
    return full;
  }

  async has(key: string): Promise<boolean> {
    if (this.known.has(key)) return true;
    try {
      await stat(this.pathFor(key));
      this.known.add(key);
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, body: Uint8Array): Promise<PutResult> {
    if (await this.has(key)) return { key, bytes: body.byteLength, deduped: true };
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    this.known.add(key);
    return { key, bytes: body.byteLength, deduped: false };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return undefined;
    }
  }

  /** Content-addressed insert: returns the hash and whether it was already stored. */
  async putContent(body: Uint8Array, prefix = 'assets'): Promise<PutResult & { hash: string }> {
    const hash = sha256Hex(body);
    const key = `${prefix}/${hash.slice(0, 2)}/${hash}`;
    const res = await this.put(key, body);
    return { ...res, hash };
  }

  async size(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          try {
            total += (await stat(full)).size;
          } catch {
            /* raced with deletion; ignore */
          }
        }
      }
    };
    await walk(this.base);
    return total;
  }

  async clearPrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
    for (const key of [...this.known]) {
      if (key.startsWith(prefix)) this.known.delete(key);
    }
  }
}

/** In-memory store used by tests. */
export class MemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Uint8Array>();

  root(): string {
    return 'memory://';
  }

  async has(key: string): Promise<boolean> {
    return this.map.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<PutResult> {
    const existed = this.map.has(key);
    if (!existed) this.map.set(key, body);
    return { key, bytes: body.byteLength, deduped: existed };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.map.get(key);
  }

  async size(): Promise<number> {
    let total = 0;
    for (const v of this.map.values()) total += v.byteLength;
    return total;
  }
}
