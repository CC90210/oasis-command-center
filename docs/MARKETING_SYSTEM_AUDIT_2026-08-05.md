# OASIS Marketing System Audit — 2026-08-05

## Executive finding

The production surface is the OASIS Command Center founders portal deployed by
Vercel (`agent-dashboard`, aliased to `oasisai.work`). The Maven showroom is a
separate review catalog and must not be treated as the marketing system.

The production deployment is `Ready`, and the founders gate, tenant scoping,
private Storage, signed playback URLs, and batched URL signing are sound. The
system is not yet ready for a blind bulk migration: Phase 1/2 covers the library
and link-based training intake, while review, metrics, retrieval, publishing,
and calendar remain incomplete.

## Hazards, ranked

### P0 — no stable brand identity (fixed in migration 134)

`marketing_asset` originally had channel and campaign but no brand/project.
Mixing OASIS, R3Sol, Arthrisil, blyss, and other portfolio work under campaigns
would corrupt filtering, training retrieval, and performance attribution.
Migration 134 adds `brand_slug`, `brand_name`, validation, and a tenant/brand
index. The library now labels assets and supports brand filtering.

### P0 — production registration was not a governed workflow (hardened locally)

The only local registration utility was untracked and defaulted every item to
OASIS campaign metadata, landing URL, 9:16, and 1080×1920. It now requires a
brand, validates channel/aspect, accepts campaign and landing metadata, derives
dimensions, is dry-run by default, checks duplicates by source, and compensates
for partial Storage/database failures. It still must be committed and shipped.

### P1 — large-video ingestion is not implemented

The browser training UI currently ingests links; it does not yet provide the
designed direct-to-Storage media drop lane. The CLI utility buffers files in
memory and is suitable for ordinary short-form assets, not large long-form
archives. Implement signed resumable/direct uploads with size, MIME, checksum,
and completion-token verification before migrating large files.

### P1 — no end-to-end optimization loop yet

The review viewer/verdict loop, metrics connectors, retrieval-at-generation,
publishing, and calendar are still later phases. The system can centralize and
play media now, but cannot yet truthfully claim to optimize it automatically.

### P1 — no authoritative archive manifest

The current filesystem contains finals, browser derivatives, B-roll, scene
fragments, previews, and duplicated showroom copies. Bulk uploading every MP4
would pollute the library. Migration must classify `final`, `variant`, `source`,
`preview`, and `scene`, then upload canonical finals and attach derivatives to
the same asset.

### P2 — source idempotency is application-only

Registration checks `(tenant_id, source)` before insert, but the database does
not enforce uniqueness. Concurrent agents can race and create duplicates. Add a
partial unique index after auditing existing source duplicates.

### P2 — storage cost and retention are undefined

Private Supabase Storage is correct, but long-form video can grow quickly.
Define retained originals, delivery proxies, poster generation, archival tier,
and deletion/restore policy before scaling ingestion.

## Inventory snapshot

The CMO repository contains these canonical completed outputs worth migration
review now:

- OASIS: system ad v1, mission ad v2, neural-tree v1/v2, load-bearing ad,
  platform reveal, second-time, plus intro/outro brand cards.
- Arthrisil: repair ad v1.
- blyss: 60-second fume-safety final plus eleven source scenes.
- Warner: 9:16 reel and 16:9 showcase.

The showroom deploy directory also contains numerous previews, B-roll clips,
generated scene fragments, and duplicates. Those should not become independent
library assets without classification. No local R3Sol directory or completed
R3Sol video was found on this machine during this audit; today’s R3Sol outputs
must be registered at render completion.

## Required release order

1. Merge and deploy migration 134 plus the brand-aware UI/queries.
2. Run the registration tool in dry-run mode for each canonical final.
3. Apply migration 134 to production and execute uploads with Vercel-provided
   credentials; verify inline playback in `/founders/marketing/library`.
4. Build direct large-media ingestion and a durable asset manifest.
5. Complete verdicts, metrics, retrieval, and publishing in that order so the
   library becomes a learning and optimization system rather than storage only.

