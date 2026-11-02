# Deviations from spec

Format: stage · area · spec said · we did · why

## Stage 1
- **Schema (additive)** · spec §5 · no `rev_seq` table · added `rev_seq(id,value)` with one row · spec §6 requires ONE delta cursor `rev`; separate per-table counters drop edges (review H2). Rev is still "increases on change", now global-monotonic.
- **Triggers (additive)** · spec §5 · 8 triggers · added `nodes_ad AFTER DELETE ON nodes` deleting the `fts_docs` row · prevents orphan FTS hits for deleted nodes (review M3); `fts_docs` has no FK in spec.
- **FTS oversized bodies** · spec §5 ("Тела > 2 МБ в индекс не идут, fts_truncated=1") · truncated body was indexed · oversized body now stored truncated in `bodies.text` for preview but `fts_docs.body` is NULL, so it is absent from `node_fts`; search of such bodies is the separate file pass (review H1).
- **Node engine** · spec §8 ("Node ≥ 18") · `engines.node` is `>=22.5` · `node:sqlite` is 22.5+; better-sqlite3 fallback not implemented yet.
- **Test invocation** · — · `node --test tests/` fails on Node 22.23.3 · `npm test` runs `node --test tests/*.test.js`.

## Stage 5
- **Transport** · spec §8 (`ws` dependency) · used `ws@8.22.1` via `npm install ws@8` · registry reachable; no hand-rolled RFC6455 server needed. Hub uses `WebSocketServer({ noServer: true })` + `handleUpgrade`.
- **Snapshot cursor** · spec §6 · `open.rev` implied as initial cursor · snapshot is read inside one deferred read transaction; cursor is the DB max rev at that read, so rows committed during the page read arrive as deltas. Client-supplied `rev` on `open` is ignored (a full snapshot supersedes it); `page` snapshots carry an informational cursor and never move the subscriber's live cursor.

## Stage 7
- **Refetch write exception** · spec §8 ("В БД скана не пишет никогда") vs §9 row 7 (`refetch` must change `rev` and arrive as a delta) · the server stays read-only for everything except the explicit `refetch` action, which opens a short-lived writable connection, updates that one node + body + findings, and closes · spec demands a write path for refetch while forbidding a persistent writer; the exception is scoped to one node and one action.
