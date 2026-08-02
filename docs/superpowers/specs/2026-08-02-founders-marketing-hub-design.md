# Founders Portal — Marketing Hub (design)

**Date:** 2026-08-02 (rev 2, after Adon's vision clarification)
**Author:** APEX / Maven (CMO)
**Repo:** `CC90210/oasis-command-center` · branch `apex/founders-marketing` · worktree `C:/Users/echel/oasis-marketing-wt`
**Status:** DESIGN — awaiting Adon's review. No code written yet.

---

## 1. What this actually is

**It is a training instrument that happens to look like a dashboard.**

Rev 1 of this spec got the emphasis wrong: it treated training as one of seven screens. Adon's
correction, verbatim:

> "The dashboard is really just going to be putting your full power in a dashboard and really
> making it seem as if I'm able to train you in large quantities that will be automatically
> ingested by you over a reasonable period of time. Really creating that ability to train you
> seamlessly. **That's the majority of what this Marketing tab is going to be for.**"

Everything else exists to feed that. The content library exists so there is something to learn
from. The metrics exist so the learning is grounded in what actually worked. The review queue
exists because a founder's verdict is the highest-quality training signal available.

So the build order changes: **library and training come first, publishing comes late.**

### Adon's three stated pillars

> "a dashboard for us to see all of the generated content. Whenever you update or generate a new
> type of video, I'm able to watch it seamlessly on there, whether that's an ad, whether that's
> HTML, whether that's a video, short term, long form. Everything is going to be centralized in
> one place in terms of just data storage."

> "an aspect of it where we're able to see all of our metrics for every single type of market.
> Everything that we do has to be tracked and we have to be getting the most information from it
> so that we can use that to train you and enhance you and involve you as a CMO agent."

> "Really creating that ability to train you seamlessly."

| Pillar | Job | Why it exists |
|---|---|---|
| **Library** | Every generated artifact, watchable in place. Ads, HTML, short-form, long-form. One storage location. | The corpus. You cannot train on what you cannot find. |
| **Metrics** | Every channel tracked, maximum extraction. | Grounds the training in outcomes, not opinions. |
| **Training** | Large-quantity ingestion, automatic, over time. | **The majority of the feature.** |

---

## 2. Decisions locked (Adon, 2026-08-02)

| Question | Decision |
|---|---|
| Where does it live | **Founders-only root route** `/founders/marketing`. **SunBiz gets no view of this, at all.** |
| Publishing | Per-channel, later. **Instagram is first.** |
| Cadence | Plan first, then build in chunks with a checkpoint per phase |
| Outreach centralization | **Explicitly deferred.** "That's something we'll do later on." Not in this build. |
| Future | Two CMO agents (Adon's and CC's) co-working on OASIS marketing, synced |

---

## 3. The founders-only gate (security, read this one carefully)

Adon's requirement is absolute: *"Sunbiz will have no view of this. It's a completely separate
dashboard."*

**The obvious implementation is wrong and would have leaked.** `resolveSessionContext()` returns
`isAdmin`, derived from `is_owner || team_role in ('admin','owner')` (`lib/api-auth.ts:100`).
Those flags are **per-tenant**. SunBiz has its own owner and admin profiles. Gating `/founders/marketing`
on `isAdmin` would have shown it to every SunBiz admin.

The gate must key on **tenant identity**, not role:

```ts
// lib/founders/gate.ts (predicates live in lib/founders-marketing-core.ts)
const FOUNDERS_TENANT_IDS = (process.env.FOUNDERS_TENANT_IDS || "").split(",").filter(Boolean);

export async function requireFounder(): Promise<{ tenantId: string; profileId: string }> {
  const profile = await getActiveProfile();
  if (!profile?.tenant_id) notFound();                       // 404, not 403
  if (!FOUNDERS_TENANT_IDS.includes(profile.tenant_id)) notFound();
  return { tenantId: profile.tenant_id, profileId: profile.id };
}
```

Three deliberate choices:

1. **Env-driven allowlist, empty by default.** If `FOUNDERS_TENANT_IDS` is unset, nobody gets in.
   Fails closed, which is this repo's stated doctrine.
2. **`notFound()` (404), not `403`.** A 403 confirms the route exists. SunBiz should not learn
   there is a founders portal.
3. **Nav entry is conditional on the same gate**, so the tab never renders for a non-founder.
   Route gate and nav gate call the same function, so they cannot drift apart.

Known tenant constant: `OASIS_FUNNEL_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452"`
(slug `oasis-ai-cc`, `lib/forms/oasis-funnel-seed.ts:31`). Adon confirms the exact
founder tenant id(s) before Phase 1; CC likely needs to be in the list too.

There is a test for this. `tests/marketing-founders-gate.test.ts` asserts a SunBiz-shaped profile
gets `notFound`, and it goes in the `test:sunbiz` chain so a future refactor cannot quietly
open the door.

**Every marketing table also carries `tenant_id` with full RLS**, even though routing is
founders-only. `getServiceSupabase()` bypasses RLS repo-wide, so tenant filtering is manual
discipline here; the repo's reviewer rule is to grep new routes for `.from(` without a nearby
`.eq('tenant_id', …)`. This costs one column per table and buys defence in depth.

---

## 4. The training loop

This is the core mechanism. Everything in the data model serves it.

```
   INGEST                    EXTRACT                 STORE              USE
 ┌──────────────┐        ┌───────────────┐      ┌────────────┐    ┌──────────────┐
 │ drop a video │──┐     │ transcript    │      │            │    │              │
 │ paste a link │──┼────▶│ hook timing   │─────▶│  corpus    │───▶│  retrieved   │
 │ metrics CSV  │──┤     │ on-screen text│      │  + labels  │    │  at generate │
 │ write lesson │──┘     │ teardown      │      │  + vectors │    │              │
 └──────────────┘        └───────────────┘      └────────────┘    └──────┬───────┘
        ▲                   (async, queued)                              │
        │                                                                ▼
        │                 ┌───────────────────────────────┐      ┌──────────────┐
        └─────────────────│  verdicts + real performance  │◀─────│    drafts    │
                          └───────────────────────────────┘      └──────────────┘
```

**"Automatically ingested over a reasonable period of time"** is the load-bearing phrase. Ingest
must be asynchronous and queued. You drop 40 videos, walk away, and they are processed in the
background. Nothing blocks on a request.

### The training signals, ranked by value

| Signal | Value | Why |
|---|---|---|
| **Request-changes note** | Highest | Says exactly where the boundary is. "The hook is too slow" is worth more than ten approvals. |
| **Rejection + reason** | High | Negative knowledge. Compounds, never expires. |
| **Real performance on a shipped asset** | High | Ground truth. Not an opinion. |
| **Reference media** (a reel that worked) | Medium | Exemplar of a form, not of our voice. |
| **Approval** | Low | Says "fine," locates no boundary. |

This inverts the naive design. Most tools optimize for fast approval. This one optimizes for
**capturing why something was wrong**, because that is what makes the agent better.

Every corpus item is labelled `exemplar` (do more of this) or `counter_example` (never again),
and carries provenance so a claim can always be traced to its source.

---

## 5. Multi-agent: two CMOs

> "Hopefully eventually [CC]'s agents will have to be communicating with each other as two
> individual CMO agents co-working on Oasis's marketing. We're going to sync you guys up as well."

Not building agent-to-agent sync now, but the schema must not preclude it. **Retrofitting
identity onto rows is a backfill migration on live data**, so it goes in from day one at a cost
of one column:

- `marketing_asset.author_agent` — which agent produced it (`maven-adon`, `maven-cc`, `human`)
- `marketing_review.reviewer` + `reviewer_agent` — who judged it
- `marketing_corpus.contributed_by` — whose training input this was
- `marketing_event.actor` — already in the design

With that, "sync you guys up" later is a read across a shared table plus a conflict rule, not a
rewrite. Without it, it is a migration against production rows.

---

## 6. Screens

Ordered by build priority, which now differs from rev 1.

### 6.1 `/founders/marketing` — Studio (landing)

Opens on decisions, not charts. Research basis: 60-80% of internal dashboards go unused, and the
most-cited cause is presenting data instead of demanding an action; if adoption has not happened
in 30 days it generally never does.

Four verbs per item, from LangChain's Agent Inbox vocabulary crossed with Ziflow's review
decisions: **Approve · Edit · Request changes · Reject.** Request-changes requires a note,
because that note is the product.

### 6.2 `/founders/marketing/library` — Library ← *builds first with the foundation*

> "Whenever you update or generate a new type of video, I'm able to watch it seamlessly."

Every artifact, playable in place. Filter by channel, format, status, campaign, date. Video plays
inline with HTTP range requests so scrubbing works on large files. HTML renders in a sandboxed
frame. Long-form and short-form sit side by side. One storage location, one grid.

### 6.3 `/founders/marketing/train` — Train Maven ← *the majority of the feature*

Four intake lanes, all asynchronous:

| Lane | Input | Extracted |
|---|---|---|
| **Drop media** | drag-and-drop video/image | transcript, hook timing, pacing, on-screen text, structural teardown |
| **Paste a link** | YouTube / IG reel / TikTok URL | transcript, public metrics, teardown |
| **Upload metrics** | Ads Manager / GSC / IG export CSV | performance joined onto the creative that earned it |
| **Write a lesson** | free text | voice corrections, standing rules, "never again" |

Each item shows its processing state (queued → extracting → indexed → in use) so bulk ingestion is
legible rather than a black box. A queue of 40 that will take an hour should say so.

### 6.4 `/founders/marketing/performance` — Metrics

> "Everything that we do has to be tracked and we have to be getting the most information from it."

Sectioned by source. Every tile stamped with **where the number came from and how fresh it is**,
because one wrong number kills trust in the whole surface. Search Console's last 3-4 days render
greyed since that data is not final. Email opens are de-emphasized (Apple MPP makes roughly half
of tracked opens synthetic).

### 6.5 `/founders/marketing/brief` — Brief the agent

Channel, angle, offer, quantity, constraints → drafts land in the Studio queue. Briefs are
saveable and reusable.

### 6.6 `/founders/marketing/asset/[id]` — Review viewer

Full-fidelity render, **per-placement preview for ads** (a flat JPG hides crop, text cutoff and
CTA behaviour, which is exactly why Meta built Creative Hub), version stack, decision log.

### 6.7 `/founders/marketing/calendar` — Calendar

Month/week/list, drag to reschedule. Status is a visual property of the tile. Approval gates
publish rather than annotating it.

---

## 7. What is actually buildable

Researched 2026-08-02. This constrains the product, so it is stated plainly rather than discovered
later.

| Channel | Read | Publish | Gate |
|---|---|---|---|
| **Instagram** (own Business acct) | **Yes, free** — views, reach, saved, shares, likes, comments, total_interactions, reels_skip_rate | Graph API | **Standard Access, no App Review.** This is why Instagram is the right first channel. |
| Facebook Page | Degraded — `views` only; impressions + page fans deprecated Nov 2025; Reels unique impressions died Jun 2026 | Graph API | Same Meta app |
| TikTok | Yes, free — view/like/comment/share. **No watch time, no reach, no FYP impressions, no demographics via any public API** | `video.publish` | **GATED.** Content Posting audit required; until it passes **every auto-posted video is forced private** |
| YouTube | Yes — watch time, avg view duration, thumbnail impressions + CTR | Data API | 10k quota units/day; `search.list` costs 100/call, avoid |
| Meta Ads | Yes — 70+ metrics, creative-level | Marketing API | `7d_view`/`28d_view` attribution returns no data as of Jan 2026 |
| Google Ads | Yes — incl. impression share, keyword quality score | API | **GATED.** Basic Access application, known 2026 review backlog |
| Search Console | Yes — clicks, impressions, CTR, position | n/a | Free. **Lags 2-4 days** |
| Email | ESP-native | existing drip engine | ~49% of opens synthetic (Apple MPP) |

**Start day one, in parallel, because they are multi-week external queues:** Google Ads Basic
Access application · TikTok Content Posting audit · Meta app review for publish scopes.

The hub will never fabricate a number to fill a tile. Where a metric is unobtainable it says so.

---

## 7b. What already exists (build on it, do not rebuild it)

Verified 2026-08-02 by reading the tree. This is the most important section of the spec: most of
the hard infrastructure for asynchronous training ingestion **is already in production here.**

| Need | Already exists | Path |
|---|---|---|
| **Zero-cost LLM calls** | `queueInfer()` — enqueues to `inference_jobs`, a daemon on the APEX PC executes it via the Claude CLI on the **Max subscription**. No paid API tokens. Paid fallback was deliberately removed 2026-07-21. | `lib/bridge-infer.ts:73` |
| **Timeout vs outage semantics** | The three-way branch: `timedOut` → retry quietly · `!ok && !timedOut` → alarm · `ok` → parse. Copy this shape exactly. | `lib/lenders/classify-reply.ts:152` |
| **Large binary upload (the video lane)** | `createSignedUploadUrl` — browser PUTs **direct to Supabase Storage**, server only mints the URL. Already carries 25 MB bank statements. Plus an HMAC completion token so a client cannot lie about what it uploaded. | `app/api/forms/upload-url/route.ts`, `lib/chat-attachments.ts:128` |
| **Upload + metadata atomicity** | upload → insert row → **compensating `remove()` on insert failure** | `lib/chat-attachments.ts:83` |
| **A daemon processing a stored file** | `document_extraction_jobs` carries a `storage_path` the daemon downloads; results come back by **HMAC POST to `/api/internal/apply-extraction`**. | `database/104_document_extraction_jobs.sql` |
| **Not double-processing a job** | Partial unique index `where status in ('pending','running')` — enforced by the database, not by a read-then-insert race. | `database/121_phone_lookup_jobs.sql:93` |
| **Untrusted content fencing** | `redactAll` + `wrapUntrusted` + `safeJsonExtract`, and **hash after redaction** so the dedupe key matches what is actually stored | `lib/secret-redaction.ts`, `lib/llm-input-boundary.ts` |
| **Injecting context into an agent turn** | `composeDashboardContextV2` fans out tool calls into a `DASHBOARD STATE` block on every turn. The corpus becomes a second block beside it. | `lib/agent-context.ts:45` |

**The video-ingestion architecture is therefore not new.** It is `document_extraction_jobs`
pointed at a different file type: browser uploads direct to Storage → we insert a job row → the
APEX daemon downloads, transcribes, and analyses → HMAC POST returns the extraction. That path is
already proven in production for PDFs.

### Maven already exists here, and this build is what makes her promise true

`lib/agents/library.ts:110` defines Maven with:

```ts
base_prompt: "You are Maven, the CMO agent for {{tenant.brand.name}}. Match the operator's
              voice samples on file. ..."
required_tools: ["content_calendar_query", "voice_samples", "late_tool"],
```

**All three tools are declared and none are implemented.** "Match the operator's voice samples on
file" is a promise with no corpus behind it. The full CMO persona also already exists at
`lib/agent-personas.ts:59`. So this build is not introducing a CMO agent; it is supplying the
corpus, the calendar and the publisher that the existing one was written to expect.

### The one genuinely hard architectural decision: retrieval

There is **no pgvector, no embeddings, no vector search, and no FTS** anywhere in this repo. That
is confirmed, not assumed. And `claude -p` cannot emit embeddings, so the subscription seam that
makes everything else free **does not cover embedding generation**.

Two options, and I recommend the first:

1. **Lexical retrieval v1** (recommended). Postgres `pg_trgm` is already in use elsewhere
   (`find_similar_merchants`), and the repo has a working keyword-scoring retriever to mirror
   (`lib/cloud-knowledge-tools.ts:119`). Ships in Phase 4, costs nothing, no new infrastructure.
   Good enough while the corpus is in the hundreds of items.
2. **Vector retrieval.** Requires enabling the `vector` extension on the Supabase project, plus an
   embedding provider that is **not** the Claude CLI — either local embeddings on the APEX daemon
   (matching the existing daemon posture) or a metered API, which contradicts the standing
   subscription-only directive.

Recommendation: ship lexical in Phase 4, add local embeddings on the daemon in a later phase once
the corpus is big enough that lexical demonstrably misses. Do not block the build on it.

---

## 8. Data model (`database/133_marketing_hub.sql`)

> **Migration number corrected.** An earlier pass said 112. `database/` actually holds 42 files
> running 070→132, and **112 is already double-booked** (`112_conversations_spine.sql` and
> `112_esign.sql`). Next free number is **133**.

Every table: `tenant_id uuid not null references tenants(id)`, five-line RLS ritual
(`enable` → `force` → `revoke all from anon, authenticated` → service_role policy → tenant policy),
`if not exists` throughout so it re-runs safely.

| Table | Holds |
|---|---|
| `marketing_asset` | channel, format, status, hook, body, cta, aspect, duration, campaign, **author_agent**, scheduled_for, published_at |
| `marketing_asset_media` | files backing an asset: video, poster, preview, source. Storage key + mime + bytes. |
| `marketing_review` | decision, note, reviewer, **reviewer_agent**, acted_on_at. The training signal. |
| `marketing_request` | operator → agent queue: kind, brief, channel, status, response |
| `marketing_corpus` | kind (media/link/metrics/lesson), source_url, transcript, extraction jsonb, **label** (exemplar/counter_example), **contributed_by**, processing state |
| `marketing_metric_daily` | per-asset per-day, with **`source`** so no number is unattributable |
| `marketing_event` | append-only audit, both directions, with `actor` |

Channel taxonomy is closed (`organic-instagram`, `organic-facebook`, `organic-tiktok`,
`organic-youtube`, `paid-meta`, `paid-google`, `seo-article`, `seo-landing`, `email`) with `track`
derived. Closed enums beat free text when an agent writes the rows.

---

## 9. Phases

Each ends at a checkpoint: gates green (`typecheck` + `lint` + `test:sunbiz`), a Vercel preview URL,
and Adon reviews before I continue.

| Phase | Ships | Proof |
|---|---|---|
| **1. Foundation + Library** | migration **133**, founders gate + its test, `lib/marketing-core.ts` (pure), readers, nav entry, `/marketing` shell, **`/founders/marketing/library` with inline playback**, Storage bucket + signed-upload route | SunBiz-shaped profile 404s; a real video uploads and plays on the preview URL |
| **2. Train Maven** | 4 intake lanes, ingestion job table (partial-unique-index dedupe), corpus storage, processing-state UI, `/api/internal/apply-extraction`-style HMAC callback | 40 items ingested in background; a dropped video and a pasted link both produce indexed corpus rows |
| **3. Studio queue** | four-verb verdict loop, asset viewer, verdicts persisted as training signal | approve / request-changes round-trip proven on preview |
| **4. Retrieval (lexical)** | corpus retrieved at generation time via `pg_trgm` + keyword scoring; wired into the turn beside `DASHBOARD STATE`; implements Maven's declared `voice_samples` tool | a generated draft provably cites corpus items; a prior "request changes" note visibly changes output |
| **5. Metrics** | ingest (CSV first, then IG Graph), per-source sections, freshness + provenance stamps | a real export renders with correct source attribution |
| **6. Brief + generate** | brief composer, request queue, Maven returns drafts | a brief on preview produces a draft in the queue |
| **7. Instagram publishing** | publish adapter interface + `manual` + `instagram` | one real post published from the hub |
| **8. Calendar** | month/week/list, drag-to-reschedule, scheduled state | an approved asset schedules and publishes |

**Deferred by Adon's explicit instruction:** outreach centralization ("we'll do later on"), and
agent-to-agent CMO sync (schema is ready for it; the sync itself is not in this build).

---

## 10. Collision map

Open PRs touching marketing-adjacent code: **#115** and **#105** (drip/send path, high risk),
**#54** (drip pacing), **#2** (SMS blaster). This build avoids every one of them.

Everything is net-new under `app/founders/`, `components/founders/`, `lib/founders/`,
`database/112_*`. The only shared file is the nav entry (`lib/nav-config.ts`, `CC_NAV`) — one
surgical hunk, announced on the session bus first, because that file is currently dirty in the
main checkout from a peer session.

The main checkout `C:/Users/echel/oasis-command-center` is on stale `apex/cc-callback-redirect-fix`
with 18 dirty peer files. **Not touched.** All work is in `C:/Users/echel/oasis-marketing-wt`.

---

## 11. Open questions for Adon

1. **Exact founder tenant id(s)** for `FOUNDERS_TENANT_IDS`. Is CC's profile on the same tenant as
   yours (`oasis-ai-cc` / `ef8d389e-…`), or a separate one that also needs allowlisting?
2. **The OASIS content archive is not on this machine.** A full sweep found **5 OASIS video files
   total**: the one Instagram system ad, the two brand cards, and a site hero video. The YouTube
   folder has thumbnails but no video. `content-studio`'s compositions have never been rendered.
   `brain/research/content_registry.md` says the OASIS section is empty. So: where does CC's
   archive actually live — his machine, Google Drive, or only ever posted to Instagram? If it
   only exists on the account, that is arguably better (the posts carry their real metrics), but
   it moves the Meta connection earlier in the build order. Handle found: **`@oasisaisolutions`**.
3. **Instagram account + access.** Which handle, and is it a Business or Creator account connected
   to a Meta app? Insights need a Business/Creator account; a Personal one reads nothing.
4. **Storage budget.** Long-form video is large. Supabase Storage has a free-tier ceiling and the
   library is meant to hold everything. Worth knowing what we are willing to spend before Phase 1
   picks a storage backend.

---

## 12. Naming collision found during Phase 1 (recorded so nobody re-introduces it)

`lib/marketing/` **already exists in this repo and means the PUBLIC MARKETING
SITE** — `/home`, `/fleet`, `/work`, `/about`, `/contact`, `/start`, rendered from
`app/(marketing)/`, with `car-geometry.ts`, `fleet.ts`, `hotspots.ts` and
`routes.ts` alongside. `app/layout.tsx` already imports `ALL_MARKETING_PATHS`
from it to decide which routes render full-bleed.

Putting the founders portal in `lib/marketing/` would have sat private,
authenticated, founders-only code directly beside the anonymous public website
under the same name. Nothing would have broken; every future reader would have
been misled.

**Resolved by namespace, before any of it shipped:**

| Concern | Path |
|---|---|
| Public marketing website | `lib/marketing/`, `app/(marketing)/` — untouched |
| Founders portal | `lib/founders/`, `lib/founders-marketing-core.ts`, `app/founders/`, `components/founders/` |

The route is `/founders/marketing`, which also leaves `/founders/*` open for the
rest of the portal — Adon: *"The Founders Portal will get everything."*
