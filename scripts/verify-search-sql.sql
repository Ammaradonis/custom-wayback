-- Proves the Phase 5 search SQL against a real SQLite/FTS5 engine.
--
-- This exists because a fake database cannot prove anything about FTS5: the whole
-- risk in `apps/api/src/lib/search.ts` is whether FTS5's `MATCH`, `bm25()` ranking
-- and the ownership join behave as assumed. A mock would just encode the same
-- assumptions back at us.
--
-- Run against a scratch database — it creates its own rows and deletes them again:
--
--   npx wrangler d1 execute <db> --local --file scripts/verify-search-sql.sql
--
-- The equivalent assertions against the Worker's HTTP surface are in
-- `apps/api/test/search.test.ts` (query building, offline) and the local smoke
-- path in the runbook.

-- ── Fixture ──────────────────────────────────────────────────────────────────
-- One user owning two domains, so the ownership join can be shown to *exclude* a
-- domain the user does not own. All ids are prefixed `zzq-` so cleanup is exact.

DELETE FROM snapshot_fts WHERE doc_id LIKE 'zzq-%';
DELETE FROM search_docs WHERE snapshot_id LIKE 'zzq-%';
DELETE FROM snapshots WHERE id LIKE 'zzq-%';
DELETE FROM ingests WHERE id LIKE 'zzq-%';
DELETE FROM domains WHERE id LIKE 'zzq-%';
DELETE FROM users WHERE id LIKE 'zzq-%';

INSERT INTO users (id, email, password_hash, created_at) VALUES
  ('zzq-user', 'zzq@example.test', 'x', 0);

-- The second domain belongs to a *different* user, which is the case that matters:
-- a search run as zzq-user must not surface it.
INSERT INTO users (id, email, password_hash, created_at) VALUES
  ('zzq-outsider', 'zzq-outsider@example.test', 'x', 0);

INSERT INTO domains (id, user_id, domain, budget_json, tracking_status, added_at) VALUES
  ('zzq-domain', 'zzq-user',     'zzq-owned.test',   '{}', 'active', 0),
  ('zzq-other',  'zzq-outsider', 'zzq-foreign.test', '{}', 'active', 0);

INSERT INTO ingests (id, domain_id, month, status, stage) VALUES
  ('zzq-ingest', 'zzq-domain', '2024-03', 'ready', 'done'),
  ('zzq-forn',   'zzq-other',  '2024-03', 'ready', 'done');

INSERT INTO snapshots (id, ingest_id, domain, url, day, ts, status_code, mime, bytes, r2_key) VALUES
  ('zzq-snap-1', 'zzq-ingest', 'zzq-owned.test',   'https://zzq-owned.test/pricing',  '2024-03-15', '20240315090000', 200, 'text/html', 100, 'pages/x/1.html'),
  ('zzq-snap-2', 'zzq-ingest', 'zzq-owned.test',   'https://zzq-owned.test/products', '2024-03-15', '20240315090000', 200, 'text/html', 100, 'pages/x/2.html'),
  ('zzq-snap-3', 'zzq-forn',   'zzq-foreign.test', 'https://zzq-foreign.test/pricing','2024-03-15', '20240315090000', 200, 'text/html', 100, 'pages/x/3.html');

INSERT INTO search_docs (snapshot_id, domain, url, day, title, bytes, indexed_at) VALUES
  ('zzq-snap-1', 'zzq-owned.test',   'https://zzq-owned.test/pricing',   '2024-03-15', 'Pricing — Widget Pro', 100, 0),
  ('zzq-snap-2', 'zzq-owned.test',   'https://zzq-owned.test/products',  '2024-03-15', 'Products',             100, 0),
  ('zzq-snap-3', 'zzq-foreign.test', 'https://zzq-foreign.test/pricing', '2024-03-15', 'Foreign Pricing',      100, 0);

INSERT INTO snapshot_fts (doc_id, url, title, text, domain, day, ts) VALUES
  ('zzq-snap-1', 'https://zzq-owned.test/pricing', 'Pricing — Widget Pro',
   'Widget Pro costs one hundred pounds and ships worldwide. Pricing updated for spring.',
   'zzq-owned.test', '2024-03-15', '20240315090000'),
  ('zzq-snap-2', 'https://zzq-owned.test/products', 'Products',
   'Our catalogue of widgets, gadgets and assorted mechanisms.',
   'zzq-owned.test', '2024-03-15', '20240315090000'),
  ('zzq-snap-3', 'https://zzq-foreign.test/pricing', 'Foreign Pricing',
   'A widget belonging to a domain this user does not own.',
   'zzq-foreign.test', '2024-03-15', '20240315090000');

-- ── Q1: ownership is enforced by the join ────────────────────────────────────
-- Expect exactly 2 rows, both zzq-owned.test. zzq-foreign.test must NOT appear.
SELECT 'Q1 owned only (expect 2, all zzq-owned.test)' AS probe, f.doc_id, f.domain
FROM snapshot_fts f
JOIN search_docs sd ON sd.snapshot_id = f.doc_id
JOIN snapshots s ON s.id = sd.snapshot_id
JOIN ingests i ON i.id = s.ingest_id
JOIN domains d ON d.id = i.domain_id
WHERE snapshot_fts MATCH '"widget"*' AND d.user_id = 'zzq-user'
ORDER BY -bm25(snapshot_fts, 4.0, 10.0, 1.0) DESC;

-- ── Q2: title is weighted above body text ────────────────────────────────────
-- "pricing" appears in snap-1's *title* and snap-3's title, but only snap-1 is
-- owned. Expect snap-1 first, and its score to beat a body-only match.
SELECT 'Q2 title weighting (expect zzq-snap-1 first)' AS probe, f.doc_id, f.title,
       -bm25(snapshot_fts, 4.0, 10.0, 1.0) AS score
FROM snapshot_fts f
JOIN search_docs sd ON sd.snapshot_id = f.doc_id
JOIN snapshots s ON s.id = sd.snapshot_id
JOIN ingests i ON i.id = s.ingest_id
JOIN domains d ON d.id = i.domain_id
WHERE snapshot_fts MATCH '"pricing"*' AND d.user_id = 'zzq-user'
ORDER BY score DESC;

-- ── Q3: prefix matching, which is what makes the search box feel live ────────
-- "mech" must find "mechanisms". Expect n = 1.
SELECT 'Q3 prefix match (expect 1)' AS probe, COUNT(*) AS n
FROM snapshot_fts WHERE snapshot_fts MATCH '"mech"*';

-- ── Q4: the COUNT(*) behind the "N results" figure ───────────────────────────
-- Expect total = 2 (owned only).
SELECT 'Q4 ownership-scoped count (expect 2)' AS probe, COUNT(*) AS total
FROM snapshot_fts f
JOIN search_docs sd ON sd.snapshot_id = f.doc_id
JOIN snapshots s ON s.id = sd.snapshot_id
JOIN ingests i ON i.id = s.ingest_id
JOIN domains d ON d.id = i.domain_id
WHERE snapshot_fts MATCH '"widget"*' AND d.user_id = 'zzq-user';

-- ── Q5: a term that matches nothing returns nothing, not an error ────────────
SELECT 'Q5 no matches (expect 0)' AS probe, COUNT(*) AS n
FROM snapshot_fts WHERE snapshot_fts MATCH '"zzzznotpresent"*';

-- ── Cleanup ──────────────────────────────────────────────────────────────────
DELETE FROM snapshot_fts WHERE doc_id LIKE 'zzq-%';
DELETE FROM search_docs WHERE snapshot_id LIKE 'zzq-%';
DELETE FROM snapshots WHERE id LIKE 'zzq-%';
DELETE FROM ingests WHERE id LIKE 'zzq-%';
DELETE FROM domains WHERE id LIKE 'zzq-%';
DELETE FROM users WHERE id LIKE 'zzq-%';
