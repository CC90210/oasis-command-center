# Content area rebuild: design spec

**Status:** for Adon's approval. Nothing is built. Evidence read 2026-10-10 ~21:15 ET from OCC `origin/main` (tip: Automations safety rails, #580) plus read-only database checks.
**Assumption to confirm:** "KLO data" means Klaviyo (question 1).

## 1. Summary

Content gets one **Tools** tab organised by job (Research, Create, Repurpose, Publish, Measure), every section collapsible. Server-only tools ship first and work the same for CC, Adon and later clients: save a link as a reference, audience brief, three video concepts, a script, repurposing, and a Performance tab with a time window, trends, every post, email (Klaviyo) and ads (Meta). Computer tools (downloading the file, competitor top posts, rendering a Studio draft) run only on the asking person's own connected computer and appear only when it is connected; for Adon they wait on the connector work (O4, J1, O7). Downloads are labelled "Reference only" and can never be published. Nothing these tools make publishes without two human approvals: the script, then the draft.

## 2. What exists today

| Area | Verified today | Broken or missing |
|---|---|---|
| Access | Founders only (`lib/founders/gate.ts`); clients get a 404. The `content` module is OASIS-only (`lib/os/modules.ts:46`). | No client door. |
| Tools page | Tools and Whiteboard, both collapsible `<h2><button aria-expanded>` (`app/founders/marketing/tools/page.tsx`). | No grouping by job. Sections sit on a shadow (constitution rule 14). |
| Tools | Repurpose a post (server, workspace AI account), Download a video (computer). Learn from a link moved to Admin > Agent training in the cleanup that dropped Score a hook (#579). | One production run ever: Repurpose, failed `ai_failed`, 2026-10-10 02:31 UTC. No success on record. |
| Downloader, server | Complete: 5 signed routes, R2 upload, Library item in the Downloads tab with `rights_status: unknown` and source URL (`lib/tools/runner-handlers.ts`). Publish refuses every brand but OASIS (`publish/route.ts:109`). | Source and rights are shown nowhere. |
| Downloader, computer | CC's PC only: CEO-Agent branch `feat/tools-runner` (CC's downloader; unmerged, no PR), off by default. No runner has checked in (`tool_runners` is empty), so the card cannot show. | **Breaks the per-person rule.** Runners serve a workspace, not a person (`lib/tools/store.ts` `liveRunnersFor`). If CC switches his on, Adon's downloads run on CC's PC. |
| Performance | Stored snapshot, fixed 30 days: totals, by channel, top watch time, top 5 (`app/founders/marketing/performance/page.tsx`). Fed by CC's `sync_post_analytics.py` polling Zernio `GET /v1/analytics`. Live: last sync 2026-10-11 00:29 UTC; 366 OASIS posts; 74% linked to a Library item. | No window, trend, full post list, email or ads. TikTok and YouTube silent since 2026-08-21. Em dashes in copy. |
| Connections | Zernio and Meta Ads key cards with a real Test, from the fix that made every Connections button work (#574) (`lib/os/connectors.ts:879-937`). Both say results do not flow yet. | No workspace has saved either key. Meta sign-in waits on App Review. Klaviyo: nothing. |
| Oasis Studio | Adon's PC only (private `oasis-studio`): gateway over 7 creative apps, HyperFrames, a stutter gate (`tools/qa/motion_audit.py`), a sound finder, Pixabay footage access. Handed to Maven 2026-10-09. | Director (brief to review) designed, not built. Recent ads rejected for stutter. No path from OCC. Installed on CC's PC: NOT VERIFIED. |
| Audiences | Playbook has a "Buyer profile (ICP)" slot. | Empty for every workspace. |

## 3. Tools, grouped by job

**Tabs:** Overview, Library, Tools, Performance ("Content Tools" becomes "Tools").

**Card rules, identical for CC, Adon and clients:** one catalog function draws cards per viewer. Workspace things (AI account, keys, data) are shared; computer things follow only the viewer's own computer. A card that cannot run for this viewer is not drawn (question 2). Each card says "Runs in OASIS" or "Runs on your computer, <name>, seen 2 min ago". A missing connection links owners to its setup and tells others to ask an owner.

| Group | Tool | What it does | Runs / needs | Status |
|---|---|---|---|---|
| Research | Save a link | Paste a YouTube, TikTok or Instagram post; saved to Library > References with its source. | OASIS | New (A3) |
| Research | Audience brief | Pains, objections, triggers, their words, angles. | OASIS / AI account | New (A5) |
| Research | Download the file | Adds the video (95 MB max) and captions to that Library item. | Your computer | Waits on T0 (CC), T1 (Adon) |
| Research | Competitor top posts | 3 accounts max: their 10 most-viewed recent posts as references. No files. | Your computer | New, waits (C2) |
| Create | Make a video | From an audience, reference or product page: three concepts, then a script. | OASIS / AI account | New (A5) |
| Create | Render a draft | Approved script to a 9:16 draft with voice and captions, gated for stutter and loudness. | Your computer with Studio | New, waits (S1) |
| Create | Whiteboard | Sketch live on a call; Present full screen. | Browser | Exists |
| Repurpose | Repurpose a post | One post into LinkedIn, Instagram and Threads versions. | OASIS / AI account | Exists; needs one proven run |
| Repurpose | Original from a reference | New script borrowing a reference's structure, never its words or footage. | OASIS / AI account | New (A5) |
| Repurpose | Clip and caption | Your own long video into captioned shorts. | Your computer | Later |
| Publish | Post to channels | An approved OASIS item's publish panel. | CC's publisher | Exists, OASIS brand only |
| Publish | Review queue | Drafts waiting for a yes. | OASIS | Exists |
| Measure | Social results | The Performance tab. | OASIS / Zernio | Improved (A4, Z1) |
| Measure | Email results | Klaviyo campaigns: sent, opens, clicks, revenue. | OASIS / Klaviyo key | New (K1, K2) |
| Measure | Ad results | Meta spend, clicks, leads, cost per lead. | OASIS / Meta Ads key | New sync (M1) |

Client publishing is not in this plan: it needs a server-side send gate with caps and an audit trail.

**UI doctrine** (`oasis-ui-library/ROUTING.md`, `DESIGN_CONSTITUTION.md`)
- Reuse CollapsibleSection (`aria-expanded` heading button, remembered, kept mounted where a card holds work), bordered not shadowed (rule 14). Semantic tokens only (7, 26); no indigo or violet, even on the "Made with AI" badge (8a).
- Tabular numerals, right-aligned numeric columns (6, 17); 44 px targets, WCAG 2.2 AA (11, 13); empty states are text, one icon, one action (23). No new dependency (recharts is installed; `dataviz` skill first). No em dashes or house agent names in copy.
- Gate: `ui_slop_lint.py` with `state/ui-slop-baseline.occ.json`, a 6-viewport `web-design-audit`, keyboard and screen-reader checks.

## 4. Link grabber

**Rights:** downloading a creator's video is fine for reference and study inside the workspace; reposting it needs the creator's rights.

| Step | What happens | Where |
|---|---|---|
| 1. Paste | Existing validator: one post only (profiles refused), https, 2,048 characters max, no user name or port. | OASIS |
| 2. Save | Library item at once, brand `downloads` (tab renamed References). Title and author from YouTube's and TikTok's public oEmbed; Instagram saves the link only (its oEmbed needs a Meta app). Optional 280-character note. | OASIS |
| 3. Download | Shown only while the viewer's own approved computer is live; claimable only by a computer owned by whoever asked. | Your computer |
| 4. Run | yt-dlp and ffprobe as argv lists. No browser cookies, no signed-in accounts. | Your computer |
| 5. Store | Presigned PUT to R2 `marketing-media/<workspace>/<item>/`; server checks size and MD5, then attaches the file to the same item. | OASIS + R2 |

**Limits:** 95 MiB, 20-minute run, 3 tries, 5 in flight per workspace, one job per link (existing); new: one job per computer, 30 saves per person per day (proposed).
**Failures:** the existing plain lines (`lib/tools/errors.ts`: private, sign-in needed, rate limited, region-locked, removed, too large, too slow, computer offline), plus "Your computer is not connected," refused at Run with nothing queued.
**Computer dependency:** CC after T0, which needs O1 (only the owner reaches his computer). Adon after T1, which needs O4 (your computer claims only your jobs) and J1 (the connector on his PC). Clients after J2 (the packaged connector).
**Label:** "Reference only" badge, "Open original" link, publish panel replaced by one line, publish refusal kept and tested. A Studio render never uses a reference's footage or audio.

## 5. Audience to viral video

| Step | What | Where | Output |
|---|---|---|---|
| 1. Start | Audience (saved or typed, 1,500 characters max), a reference, or a product page (the existing safe page reader in `lib/tools/worker/learn-from-link.ts`) | OASIS | A project |
| 2. Brief | One model call | OASIS, workspace AI | Pains, desires, objections, their words, where they watch |
| 3. References | Paste up to 10 post links now; "Find top posts" later | OASIS, later your computer | References with any metrics available |
| 4. Concepts | Safe, bold, wildcard: hook (12 words max), angle, borrowed pattern, format, length | OASIS | Person picks one |
| 5. Script | Timed beats, voice-over, on-screen text (7 words a card max), B-roll cues, captions, CTA, 3 test hooks; banned-claims check when the brand has a list | OASIS | Person edits, then **Approve script** |
| 6. Draft | Fixed template: 1080x1920, 30 fps, voice, burned captions, -14 LUFS; gates: 0 freezes, 0 jumps, loudness, safe zones | Your computer, Studio | MP4, .srt, caption; Library draft "Needs review", badge "Made with AI" |
| 7. Publish | A person approves the draft, then the existing publish panel | OASIS + CC's publisher | Posted |

- One model call per step inside the 60-second request (55-second budget, `lib/tools/worker/ai.ts`) on the workspace AI account, never the platform key or CC's subscription. Steps 1-5 need nothing from O4, J1 or O7.
- Untrusted text (captions, product pages, pasted posts) is fenced; answers are schema-checked before saving, as Repurpose does.
- Publish refuses: a reference, an unapproved draft, a draft with media of unknown licence, a draft missing its AI badge.
- New tables `content_projects` and `content_audiences`; every query names the workspace (Turso has no row security).

## 6. Performance tab

| Source | Numbers | How | Status |
|---|---|---|---|
| Zernio (social) | Views, impressions, likes, comments, shares, saves, follows, watch time | OASIS: CC's script. Others: new OCC sync, own key (Z1) | Live for OASIS |
| Klaviyo (email) | Recipients, delivered, open and click rate, conversions, revenue, unsubscribes per campaign | Daily sync (K2) | New |
| Meta Ads | Spend, impressions, reach, clicks, CTR, CPC, leads, cost per lead, per campaign per day | Daily sync (M1), also fills Growth > Ads | New |

**Layout**, each section collapsible: 7, 30 or 90 days with change against the previous period; Social (totals, by channel, daily trend with a table alternative, every post sortable with its Library link, held attention); Email; Ads; a freshness line per source. Money carries its currency code; a missing value reads "Not reported", never a dash or zero.

| State | Shows |
|---|---|
| Not connected | Owner: the card's Connect link. Others: "Ask a workspace owner to connect it." |
| Never synced | "First numbers arrive within the hour." |
| Plan without analytics | "Your Zernio plan does not include analytics." |
| Stale | Numbers plus "Last pulled at 14:05." |
| Read failed | "Could not load these numbers. That is not the same as having none." |

## 7. Connections to add

Pattern from #574: schema (`lib/tenant-integration-schemas.ts`), probe (`lib/integrations/key-probes.ts`), card (`lib/os/connectors.ts`), covered by `tests/every-connector-works.test.ts`. Test is one read, no side effect; keys encrypted.

| Slice | What | Size |
|---|---|---|
| K1 Klaviyo card | Private key (`pk_`), read-only: accounts, campaigns, flows, metrics. Test: `GET https://a.klaviyo.com/api/accounts`, header `Authorization: Klaviyo-API-Key`, `revision: 2026-07-15` (docs read 2026-10-10); shows the organisation name. | 4 h |
| K2 Klaviyo sync | Daily: find "Placed Order", then `POST /api/campaign-values-reports` (2/min, 225/day). Stores `email_campaign_metrics`. | 8 h |
| M1 Meta Ads sync | Existing card (`ads_read` token + ad account). Daily `GET /act_{id}/insights` by campaign and day (fields confirmed against Meta's docs at build). Stores `ad_insights_daily`. Lead Ads still wait on App Review. | 10 h |
| Z1 Zernio sync | For workspaces with a saved key: a port of CC's script (all pages, analytics-access check, upsert per post). One writer per workspace (question 4). | 8 h |
| Later | YouTube Data API key (competitor research without a computer), Shopify token (e-com revenue), Pixabay key (B-roll for clients). | ~4 h card + ~1 day each |

Syncs run from `/api/cron/marketing-sync?source=...`, registered in `workers/oasis-cc-cron` and `config/cron-registry.json`.

## 8. Build order

Every slice: Codex review, ten-check acceptance on a synthetic workspace, done only when merged to main and the Cloudflare Workers run for that merge reports success.

**Ships now, no computer (about 71 h)**
1. **A1 Tools layout** (6 h). Rename, 5 groups, registry `group`, per-viewer cards, Whiteboard into Create. Files: `tools/page.tsx`, `ContentTabs.tsx`, `lib/os/match.ts`, `lib/tools/catalog.ts`, `components/tools/*`. Tests: tabs match crumbs; every tool has a group; two founders with the same computer state see the same cards.
2. **A2 Reference label** (3 h, after A1). Files: `library/page.tsx`, `asset/[id]/page.tsx`, `AssetPublishPanel.tsx`. Tests: badge and link render; publish refuses a reference.
3. **A3 Save a link** (6 h, after A2). Server tool `save_reference`; oEmbed limited to YouTube and TikTok hosts, 5-second timeout. Tests: host allowlist, dedupe, workspace isolation. oEmbed from Cloudflare: NOT VERIFIED until its canary.
4. **A4 Performance, social** (10 h). Files: `performance/page.tsx`, `lib/founders-performance-core.ts`, `lib/founders/performance-queries.ts`. Tests: `performance-metrics`, `content-speed` (no network call while rendering), a failed read never shows as zero.
5. **A5 Video project** (16 h, after A1, A3). Migration; executors `audience_brief`, `video_concepts`, `video_script`; project page with script approval. Tests: schema-checked answers, injection fixture, approval required, other workspace refused.
6. **K1 Klaviyo card** (4 h). Files and tests: section 7 pattern; probe answers for 200, 401, 403, 429.
7. **M1 Meta Ads sync** (10 h, after A4). 8. **K2 Klaviyo sync** (8 h, after K1, A4). 9. **Z1 Zernio sync** (8 h, after A4; OASIS switch needs CC). Files: `app/api/cron/marketing-sync/route.ts` (new), one migration, the cron table and registry, the Performance sections. Tests: cron-table coverage, parsing of recorded vendor answers, workspace scope, back-off on 429.

**Waits on the computer work (about 60 h once unblocked)**

10. **T0 Downloader bound to its owner** (4 h, after O1). CC's runner claims only CC's jobs; Download shows only to the person whose own computer is live; works as today (a new Library item). Files: `lib/tools/{store,catalog,session-handlers,runner-handlers}.ts`. Must merge before CC switches his runner on. Test: Adon's job is never claimable by CC's runner.
11. **T1 Downloads on your own computer** (16 h, after O4 deployed and J1 live). `tool_v1` claim protocol, job token bound to job and computer, handler in `JARVIS/services/oasis-connector/`, attach to the reference item, captions. Tests: only the asker's computer can claim; no cookies in argv; size cap.
12. **C2 Competitor top posts** (8 h, after T1). Metadata only. Tests: no file downloaded; at most 10 per account.
13. **S1 Studio draft render** (32 h, after O4, J1, O7, A5). `studio_v1` protocol, a fixed vertical template in `oasis-studio`, the gates, Library draft with licence list and AI badge. Tests: a planted stutter fails; a reference's media is never used.
14. **D1 Client door** (6 h, after tenant entitlements). Content module replaces the founders gate in `lib/tools/access.ts`; server tools only until J2. Tests: a client sees only its own data and no computer tools.

## 9. Open questions (one tap each)

1. **Does "KLO data" mean Klaviyo?** Recommend: Yes. [Yes] [No, something else]
2. **Computer tools before your computer is connected:** Recommend: hide them; one line says they appear once it is. [Hide] [Show, no button]
3. **First draft renderer:** Recommend: a fixed template (predictable, safe, testable), the Studio director agent later. [Template first] [Director first]
4. **OASIS's social numbers:** Recommend: ask CC to save OASIS's Zernio key in Connections so OCC is the one writer, the same path clients use. [Ask CC] [Keep CC's script]
5. **Clients get the server tools:** Recommend: after two weeks of OASIS use and a passing ten-check acceptance. [After 2 weeks] [Now] [Later]

## 10. Risks

| Risk | Mitigation |
|---|---|
| Downloads run on the wrong person's computer (the downloader serves the workspace today). | T0 first; CC keeps `TOOLS_RUNNER_ENABLED` off until it merges. |
| Platforms block downloads. | No cookies or signed-in accounts; rate limits shown plainly. |
| Studio quality and licences. | Stutter gate must pass; OpenMontage (AGPL) never in the render path; Remotion licence past 3 staff; codec legal read before selling; no Freesound audio until its commercial terms are answered. |
| An agent render reading untrusted captions on a PC. | Template first; fenced inputs; job folder only; allowlisted commands. |
| Tools unproven in production. | A live canary per tool before calling it done. |
| Vendor rate limits; two writers to social numbers. | Daily syncs with back-off; one writer per workspace. |
| Workspace isolation on Turso. | Workspace id on every row and query; cross-workspace tests. |
| AI disclosure and health claims. | AI badge required to publish; banned-claims check when a list exists; Instagram "AI info" on post. |
