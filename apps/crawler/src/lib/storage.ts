/**
 * Storage adapter: writes to either:
 *  - Cloudflare R2 (via S3-compatible API) — production
 *  - MinIO or local filesystem — development
 *
 * Configured via environment variables (names only; values come from .dev.vars or the OS env).
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** "r2" | "minio" | "local" */
  driver: "r2" | "minio" | "local";
  /** Only for "local" driver: base directory. */
  localDir?: string;
}

export class Storage {
  private s3: S3Client | null = null;
  private readonly config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    if (config.driver !== "local") {
      this.s3 = new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.driver === "minio",
      });
    }
  }

  /** Returns true if the key already exists (skip re-upload). */
  async exists(key: string): Promise<boolean> {
    if (this.config.driver === "local") {
      try {
        await fs.access(this.localPath(key));
        return true;
      } catch {
        return false;
      }
    }
    try {
      await this.s3!.send(
        new HeadObjectCommand({ Bucket: this.config.bucketName, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (this.config.driver === "local") {
      const p = this.localPath(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, body);
      return;
    }
    await this.s3!.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Hashed asset keys are immutable.
        CacheControl: key.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=86400",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    if (this.config.driver === "local") {
      try {
        await fs.unlink(this.localPath(key));
      } catch {
        // Non-fatal.
      }
      return;
    }
    await this.s3!.send(
      new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: key }),
    );
  }

  private localPath(key: string): string {
    return path.join(this.config.localDir ?? "./.local-storage", key);
  }
}

// ── Key builders (shared with the Worker) ────────────────────────────────────

export function pageKey(domain: string, day: string, urlHash: string): string {
  return `pages/${domain}/${day}/${urlHash}.html`;
}

export function assetKey(hash: string): string {
  return `assets/${hash.slice(0, 2)}/${hash}`;
}

export function sha256Hex(input: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("hex");
}

export function urlHash(url: string): string {
  return sha256Hex(url).slice(0, 32);
}
