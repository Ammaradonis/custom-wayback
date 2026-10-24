/**
 * Archive.org authentication.
 *
 * Two properties matter and both are security-relevant, so they are asserted rather than
 * assumed:
 *
 *  1. **A partial pair sends nothing.** Half a credential is not "almost authenticated":
 *     archive.org answers a bare key with an authentication error, so sending one would
 *     turn anonymous success into authenticated failure.
 *  2. **Credentials never leave archive.org.** These are account keys. Attaching them to a
 *     redirect target or an archived site's own origin would hand a credential to a third
 *     party, so the host gate is the important half of the module.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveAuthHeaders,
  archiveAuthMode,
  archiveHeadersFor,
  isArchiveHost,
} from "../src/lib/archive-auth.ts";

test("both halves make an authenticated request; either half alone sends nothing", () => {
  const both = { ARCHIVE_S3_ACCESS_KEY: "ACCESS", ARCHIVE_S3_SECRET_KEY: "SECRET" };
  assert.deepEqual(archiveAuthHeaders(both), { Authorization: "LOW ACCESS:SECRET" });
  assert.equal(archiveAuthMode(both), "authenticated");

  assert.deepEqual(archiveAuthHeaders({ ARCHIVE_S3_ACCESS_KEY: "ACCESS" }), {});
  assert.deepEqual(archiveAuthHeaders({ ARCHIVE_S3_SECRET_KEY: "SECRET" }), {});
  assert.deepEqual(archiveAuthHeaders({}), {});
  assert.equal(archiveAuthMode({}), "anonymous");
});

test("a secret pasted with a trailing newline still produces a valid header", () => {
  // A newline inside a header value is a hard TypeError in the fetch API, not a quiet
  // mismatch, so trimming is the difference between working and throwing on every request.
  const headers = archiveAuthHeaders({
    ARCHIVE_S3_ACCESS_KEY: "  ACCESS\n",
    ARCHIVE_S3_SECRET_KEY: "SECRET\r\n",
  });
  assert.deepEqual(headers, { Authorization: "LOW ACCESS:SECRET" });
});

test("only archive.org hosts are recognised", () => {
  for (const url of [
    "https://archive.org/wayback/available?url=x",
    "https://web.archive.org/web/2024id_/https://example.com/",
    "https://web.archive.org/cdx/search/cdx?url=x",
  ]) {
    assert.equal(isArchiveHost(url), true, url);
  }
  for (const url of [
    "https://example.com/",
    "https://archive.org.evil.test/",
    "https://notarchive.org/",
    "not a url",
  ]) {
    assert.equal(isArchiveHost(url), false, url);
  }
});

test("credentials are withheld from every non-archive host", () => {
  const env = { ARCHIVE_S3_ACCESS_KEY: "ACCESS", ARCHIVE_S3_SECRET_KEY: "SECRET" };

  assert.deepEqual(archiveHeadersFor("https://web.archive.org/x", env, { Accept: "*/*" }), {
    Authorization: "LOW ACCESS:SECRET",
    Accept: "*/*",
  });

  // An archived page's own origin must never see the key.
  assert.deepEqual(archiveHeadersFor("https://example.com/app.js", env, { Accept: "*/*" }), {
    Accept: "*/*",
  });
  assert.deepEqual(archiveHeadersFor("https://example.com/", env), {});
});
