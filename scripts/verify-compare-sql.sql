-- Proves the Phase 5 comparison SQL against a real SQLite engine.
--
-- The comparison feature answers "which pages changed between two months?" with
-- two indexed reads and no R2 traffic, because each crawl records a
-- `content_digest`. What that claim depends on is SQL: a self-join between two
-- months of the same domain, keyed on URL, with `added` and `removed` falling out
-- of which side is NULL.
--
-- A mock would encode the same assumptions back at us, so this runs against a
-- real database. It creates its own rows and deletes them again.
--
--   npx wrangler d1 execute <db> --local --file scripts/verify-compare-sql.sql
--
-- The classification logic on top of these rows is unit-tested exhaustively in
-- `apps/api/test/compare.test.ts`.

-- ── Cleanup any previous run ─────────────────────────────────────────────────
DELETE FROM snapshots WHERE id LIKE 'zzc-%';
DELETE FROM ingests WHERE id LIKE 'zzc-%';
DELETE FROM domains WHERE id LIKE 'zzc-%';
DELETE FROM users WHERE id LIKE 'zzc-%';

-- ── Fixture: one domain, two months ──────────────────────────────────────────
-- The four cases the feature must distinguish, one page each:
--   /same    identical digest in both months        -> unchanged
--   /price   digest differs                         -> changed
--   /new     only in the later month                -> added
--   /old     only in the earlier month              -> removed
--   /nodig   present in both, no digests anywhere   -> unknown (honest)

INSERT INTO users (id, email, password_hash, created_at) VALUES
  ('zzc-user', 'zzc@example.test', 'x', 0);

INSERT INTO domains (id, user_id, domain, budget_json, tracking_status, added_at) VALUES
  ('zzc-domain', 'zzc-user', 'zzc-compare.test', '{}', 'active', 0);

INSERT INTO ingests (id, domain_id, month, status, stage) VALUES
  ('zzc-feb', 'zzc-domain', '2024-02', 'ready', 'done'),
  ('zzc-mar', 'zzc-domain', '2024-03', 'ready', 'done');

INSERT INTO snapshots (id, ingest_id, domain, url, day, ts, status_code, mime, bytes, r2_key, content_digest, title) VALUES
  ('zzc-s1a', 'zzc-feb', 'zzc-compare.test', 'https://zzc-compare.test/same',  '2024-02-10', '20240210090000', 200, 'text/html', 100, 'pages/a.html', 'digest-same',  'Same page'),
  ('zzc-s1b', 'zzc-mar', 'zzc-compare.test', 'https://zzc-compare.test/same',  '2024-03-10', '20240310090000', 200, 'text/html', 100, 'pages/b.html', 'digest-same',  'Same page'),
  ('zzc-s2a', 'zzc-feb', 'zzc-compare.test', 'https://zzc-compare.test/price', '2024-02-10', '20240210090000', 200, 'text/html', 120, 'pages/c.html', 'digest-price-1', 'Pricing'),
  ('zzc-s2b', 'zzc-mar', 'zzc-compare.test', 'https://zzc-compare.test/price', '2024-03-10', '20240310090000', 200, 'text/html', 118, 'pages/d.html', 'digest-price-2', 'Pricing'),
  ('zzc-s3b', 'zzc-mar', 'zzc-compare.test', 'https://zzc-compare.test/new',   '2024-03-11', '20240311090000', 200, 'text/html',  90, 'pages/e.html', 'digest-new',    'New page'),
  ('zzc-s4a', 'zzc-feb', 'zzc-compare.test', 'https://zzc-compare.test/old',   '2024-02-11', '20240211090000', 200, 'text/html',  80, 'pages/f.html', 'digest-old',    'Old page'),
  -- /nodig: both months, no digests. Size and title agree, so nothing is provable.
  ('zzc-s5a', 'zzc-feb', 'zzc-compare.test', 'https://zzc-compare.test/nodig', '2024-02-12', '20240212090000', 200, 'text/html',  70, 'pages/g.html', NULL, 'No digest'),
  ('zzc-s5b', 'zzc-mar', 'zzc-compare.test', 'https://zzc-compare.test/nodig', '2024-03-12', '20240312090000', 200, 'text/html',  70, 'pages/h.html', NULL, 'No digest');

-- ── Q1: the classification query, exactly as the route issues it ─────────────
-- Expect one row per URL with `kind` derived from the join, and exactly one page
-- in each of the five buckets.
SELECT 'Q1 classification (expect changed 1, added 1, removed 1, unchanged 1, unknown 1)' AS probe,
       COALESCE(b.url, a.url) AS url,
       CASE
         WHEN b.id IS NULL THEN 'added'
         WHEN a.id IS NULL THEN 'removed'
         WHEN b.content_digest IS NOT NULL AND a.content_digest IS NOT NULL
           THEN CASE WHEN b.content_digest = a.content_digest THEN 'unchanged' ELSE 'changed' END
         WHEN (b.bytes IS NOT NULL AND a.bytes IS NOT NULL AND b.bytes != a.bytes) THEN 'changed'
         WHEN b.title IS NOT a.title THEN 'changed'
         ELSE 'unknown'
       END AS kind
FROM (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2024-02-%') b
FULL OUTER JOIN (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2024-03-%') a
  ON a.url = b.url
ORDER BY kind, url;

-- ── Q2: the bucket counts, which is what the compare summary shows ───────────
SELECT 'Q2 bucket counts (expect one of each)' AS probe, kind, COUNT(*) AS n
FROM (
  SELECT COALESCE(b.url, a.url) AS url,
         CASE
           WHEN b.id IS NULL THEN 'added'
           WHEN a.id IS NULL THEN 'removed'
           WHEN b.content_digest IS NOT NULL AND a.content_digest IS NOT NULL
             THEN CASE WHEN b.content_digest = a.content_digest THEN 'unchanged' ELSE 'changed' END
           WHEN (b.bytes IS NOT NULL AND a.bytes IS NOT NULL AND b.bytes != a.bytes) THEN 'changed'
           WHEN b.title IS NOT a.title THEN 'changed'
           ELSE 'unknown'
         END AS kind
  FROM (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2024-02-%') b
  FULL OUTER JOIN (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2024-03-%') a
    ON a.url = b.url
)
GROUP BY kind
ORDER BY kind;

-- ── Q3: a month with no snapshots at all must not error ─────────────────────
-- An empty side is the normal case for a domain whose second month was never
-- crawled; the join must produce rows, all classified 'added'.
SELECT 'Q3 empty earlier month (expect 4 added: all of the later month''s URLs)' AS probe, COUNT(*) AS n
FROM (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2019-01-%') b
FULL OUTER JOIN (SELECT * FROM snapshots WHERE id LIKE 'zzc-%' AND day LIKE '2024-03-%') a
  ON a.url = b.url
WHERE b.id IS NULL;

-- ── Q4: the index the per-page detail lookup depends on ─────────────────────
-- Must be able to find both months' rows for one URL without a table scan.
SELECT 'Q4 per-URL lookup across both months (expect 2)' AS probe, COUNT(*) AS n
FROM snapshots
WHERE domain = 'zzc-compare.test'
  AND url = 'https://zzc-compare.test/price'
  AND (day LIKE '2024-02-%' OR day LIKE '2024-03-%');

-- ── Cleanup ──────────────────────────────────────────────────────────────────
DELETE FROM snapshots WHERE id LIKE 'zzc-%';
DELETE FROM ingests WHERE id LIKE 'zzc-%';
DELETE FROM domains WHERE id LIKE 'zzc-%';
DELETE FROM users WHERE id LIKE 'zzc-%';
