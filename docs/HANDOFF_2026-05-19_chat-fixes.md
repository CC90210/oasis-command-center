# Handoff — Command Center chat fixes + cross-empire session summary

**Date:** 2026-05-19
**From:** Bravo session running in `~/Business-Empire-Agent` (Claude Opus 4.7, IDE chat)
**To:** The next agent working on the Command Center (or any agent CC routes here)
**Status:** Diagnostic complete, NO code changes shipped to `oasis-command-center`. All Command Center work is queued for you. Other empire work (PropFlow, BEA) IS shipped — see "Already done elsewhere" section.

CC ended the session realizing they were chatting in the wrong window. Pick this up, review my diagnoses, ship the fixes that survive your review.

---

## TL;DR

1. **Command Center API chat mode is broken with a real root-cause** — AES-GCM auth-tag failure on `decryptField(encrypted_api_key)` in `chat-auth.ts`. Manifests as `"Unsupported state or unable to authenticate data"` rendered raw in the chat error banner. Either `FIELD_ENCRYPTION_KEY` was rotated since the OpenRouter key was saved, or local↔Vercel envelope keys diverged. **Immediate user-side fix:** re-paste OpenRouter key in Settings → AI Provider Accounts. **Code-side fix:** catch + surface a structured error with a deep-link to Settings.

2. **Three UX issues CC raised**, none touched yet:
   - Codex card's "Install guide" link goes to GitHub instead of an in-app setup flow
   - "AI Provider Accounts" + "Per-agent overrides" + "Use my own AI keys, just for me" feels redundant
   - API mode has no per-key selector when multiple provider keys are connected

3. **CC's chosen scope (verbal, not committed):** **Option B** in my proposal — bug fix + UX cleanup as a single PR. Confirm with CC before starting; they may want to defer parts.

4. **Already shipped to other repos this session (NOT Command Center):** PropFlow walkthroughs production hardening, email-engine bug fix in BEA, PropFlow Supabase migration applied. Details in the "Already done elsewhere" section below.

---

## The Command Center bug — full diagnosis

### Symptom

User opens the dashboard chat (`/agents` page), selects mode = `API + local tools` (which maps to `ChatMode = "cloud_bridge_tools"`), types any message. The reply slot shows:

> ⚠ Unsupported state or unable to authenticate data
> [Retry on CLI (local bridge) →]

### What's happening on the wire

1. `components/ChatWidget.tsx:submitText()` POSTs to `/api/chat` with body `{ agent_key: "bravo", session_id, messages, cloud_tools: "tools", tool_routing: "bridge_proxy" }` (line ~836).
2. `app/api/chat/route.ts` calls `getSessionUser()` (succeeds — cookies valid) then `resolveChatContext(user, agentKey)` from `lib/chat-auth.ts`.
3. `resolveChatContext` queries `agent_model_config` for `(tenant_id, user_id, agent_key="bravo")`. Either finds a user-override row OR falls back to the tenant-default row.
4. **It then calls `decryptField(encrypted_api_key)`** to recover the operator's OpenRouter key.
5. The decrypt throws — `crypto.createDecipheriv` AES-GCM `final()` fails the auth-tag check with the exact string `"Unsupported state or unable to authenticate data"`. The route catches this exception and returns it as the response body `{ error: "Unsupported state or unable to authenticate data" }`.
6. `ChatWidget.tsx:861` reads `errBody?.error` and pipes it directly into `setError(...)`. The `<div>` at line ~1683 renders the raw string in monospace.

### Why I'm confident this is AES-GCM, not Supabase auth

1. Initial guess was Supabase session because the string LOOKS like a `gotrue-js` error. **It isn't.** Confirmed by grepping `node_modules`: the literal "Unsupported state or unable to authenticate" lives in:
   - `node_modules/@next/env/dist/index.js`
   - `node_modules/next/dist/compiled/crypto-browserify/index.js`
   - `node_modules/next/dist/compiled/next-server/server.runtime.prod.js`
   
   No hit in `@supabase/*`. This is Node's `crypto` module (or its browserify shim) throwing during `decipher.final()`.

2. Supabase auth would surface as a 401 from `getSessionUser()`, hitting a different code path entirely.

3. The chat tester is the operator (CC). Operator email check passes. Session cookies are valid. The break is post-auth.

### The KEK rotation hypothesis (most likely cause)

The dashboard encrypts AI provider keys at rest in `agent_model_config.encrypted_api_key`. The encryption envelope (KEK) is sourced from an environment variable — verify by reading `lib/field-encryption.ts`. If that env var:

- Was rotated on Vercel after CC saved the OpenRouter key, OR
- Differs between local-dev and Vercel-prod, OR  
- Was generated freshly without backing up the prior value

…then every previously-stored encrypted key is undecryptable on the new envelope. The fix is simply re-encrypting under the new KEK by re-saving the key in Settings.

**Verify the KEK env var name** by reading `lib/field-encryption.ts`. Check Vercel env on `agent-dashboard` project for that key's presence + recency.

### What to ship

**Surgical fix (recommended first PR):**

1. In `lib/chat-auth.ts`, wrap the `decryptField(...)` call in try/catch. On failure, return:
   ```ts
   {
     ok: false,
     status: 500 as const,
     code: "key_decrypt_failed" as const,
     detail: "Stored key cannot be decrypted under the current encryption envelope. Re-paste your API key in Settings → AI Provider Accounts.",
   }
   ```

2. In `components/ChatWidget.tsx`, add a branch in the error renderer (~line 1683):
   ```tsx
   {error === "key_decrypt_failed" && (
     <div className="text-xs text-fg-muted font-sans">
       Your saved provider key can no longer be decrypted (encryption
       envelope changed). Open{" "}
       <Link href="/settings#providers" className="text-accent underline">
         Settings → AI provider accounts
       </Link>{" "}
       and click <strong>Replace key</strong> on the affected provider —
       takes 30 seconds, re-encrypts under the current envelope.
     </div>
   )}
   ```

3. After CC re-pastes the OpenRouter key, the chat works again immediately. The structured error means the next time this happens (envelope rotation, vendor change, etc.) the user knows exactly what to do.

**User-side immediate fix to share with CC (works without any code change):**

> Open Settings → AI Provider Accounts → OpenRouter → click **Replace key**. Paste the same key value. Save. Try the chat again.

---

## The three UX gaps CC raised

CC wants these addressed alongside the bug fix. I sketched Plan B in the prior turn but didn't write code. Reproducing the plan here so you don't lose it:

### Gap 1 — Codex install: "Install guide" links to GitHub

**Current state** (per Settings page screenshot):

> **Codex CLI** · NOT INSTALLED
> Uses your OpenAI subscription via the Codex CLI / plugin.
> `npm install -g @openai/codex`
> [Install guide ↗]

The link goes to the OpenAI Codex GitHub README, not an in-app setup flow.

**What CC wants:** parity with the Claude Code card behavior — click "Set up" → in-app guided flow that:
1. Runs `npm install -g @openai/codex` via the local bridge (`bridge_tools` already supports shell exec — check `bravo_cli/bridge_tools.py`)
2. Once installed, kicks off `codex auth login` and pipes the OAuth flow back to the dashboard
3. When CC's Codex auth = READY, the card flips green

**Files to touch:**
- `components/settings/LocalCliProvidersCard.tsx` — the card UI
- Possibly a new `app/api/bridge/install-cli/route.ts` to proxy install + auth commands to the bridge
- Bridge daemon side (`~/Business-Empire-Agent/bravo_cli/bridge_chat_server.py` or `bridge_tools.py`) — add an `install_cli` endpoint that whitelists `npm install -g @openai/codex` + `codex auth login`

Apply the same pattern to **Gemini CLI** ("NEEDS AUTH" state in the screenshot) and any future local-model entries.

### Gap 2 — Settings redundancy

The screenshot shows three overlapping concepts on Settings:
- **AI Provider Accounts** (workspace-level — OpenRouter shown CONNECTED, others NOT CONNECTED)
- **Per-agent overrides** (mentioned in chat header copy)
- **Use my own AI keys, just for me** (personal override card)

CC says: "I don't get it. They're just different use cases I guess but I don't know."

**Proposed consolidation** (CC verbally approved as Plan B step 3):

Collapse all three into ONE section called **"Agent Models"** with a row per (provider, agent) where each row has a scope chip:

| Provider | Agent | Scope chip | Key status |
|---|---|---|---|
| OpenRouter | Workspace default | 🌐 Workspace | CONNECTED |
| Anthropic | Bravo | 🤖 Per-agent | NOT CONNECTED |
| OpenAI | (me only) | 👤 Just me | NOT CONNECTED |

Same underlying data (`agent_model_config` rows with `user_id` null/set + `agent_key` "*"/specific). One mental model.

Touches `app/settings/page.tsx` + `components/settings/*` files.

### Gap 3 — API-mode key picker

When CC switches the chat to API mode (`cloud_only` or `cloud_bridge_tools`), there's no UI to pick which connected provider's key to use for THIS chat. Currently the route just picks whatever `agent_model_config` says.

**What CC wants:** a small dropdown above the chat input (visible only in API modes) that lists the connected providers and lets them pick the active key for the session. Like Cursor's model picker.

**Implementation sketch:**
- `components/ChatWidget.tsx` — new state `sessionProviderOverride: Provider | null`, dropdown component visible only when `chatMode === "cloud_only" || "cloud_bridge_tools"`
- POST to `/api/chat` includes `provider_override` in the body
- `app/api/chat/route.ts` + `lib/chat-auth.ts` respect the override, falling back to agent-config if no override

---

## Already done elsewhere this session (NOT Command Center — verified)

| Area | Repo | Commits | Status |
|---|---|---|---|
| PropFlow 3D Gaussian Splat walkthroughs (full feature: DB, API, UI, trainer, CI, health, recovery, cost controls, cron) | `~/realestate-App` (`CC90210/real-estate-App`) | 8 commits `790dc11..5c16689` on main | Shipped, Vercel deployed. **BLOCKED on:** Cloudflare R2 credentials + RunPod endpoint creation (CC needs to follow `docs/walkthroughs/R2_SETUP.md` then I run `services/splat-trainer/scripts/deploy_runpod.py`). |
| PropFlow Supabase migration applied (walkthrough_jobs + RLS + recovery functions) | PropFlow Supabase project `yuqwdwsdjxliaipkyskg` (in CC's `goldstorm2003@gmail.com` Supabase account) | 2 SQL migrations applied via Management API | ✅ Verified — 3 functions registered in `pg_proc`, table has 17 cols / 4 RLS policies / 6 indexes |
| PropFlow Vercel env vars (`R2_BUCKET`, `RUNPOD_API_KEY`, `WALKTHROUGH_WEBHOOK_SECRET`, `CRON_SECRET`) | Vercel project `real-estate-app` | All 3 environments | ✅ Set. Still missing: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RUNPOD_ENDPOINT_ID` (CC's manual step). |
| Email-engine body-eating bug fix (HTML auto-detect + reject non-HTML `--html`) | `~/Business-Empire-Agent` (`CC90210/CEO-Agent`) | `1b49999` (CLI) + `6bf793a` (gateway) on main | ✅ Shipped to BEA main. Bridge picks up the patched scripts on next agent chat turn. |
| Saved Meet link added to brain/USER.md Critical Links | BEA (local-only runtime file, gitignored) | local edit | ✅ Future agent invocations find `https://meet.google.com/oqd-xpoq-fgw` on first read |
| Command Center local repo pulled to current | `~/APPS/oasis-command-center` | fast-forward to `52c4e18a` | ✅ Local now matches origin/main matches what Vercel has deployed |

---

## Outstanding for the next agent (your action items)

Ordered by what unblocks CC the fastest:

1. **Tell CC to re-paste OpenRouter key in Settings** — fixes API mode immediately without any code change. Verify by switching chat mode to `API + local tools` and sending `yo wsp`. Expected: real response from the model, no error banner.

2. **Once user-side workaround proves the diagnosis right, ship the structured `key_decrypt_failed` error** so the next envelope rotation doesn't manifest as a cryptic crypto message. Two file changes only:
   - `lib/chat-auth.ts` — try/catch around `decryptField`
   - `components/ChatWidget.tsx` — new error code branch

3. **Decide with CC** whether to bundle the three UX gaps (Codex setup / Settings consolidation / API-mode key picker) into one PR or sequence them. My recommendation was bundled as Plan B but CC didn't commit before realizing they were in the wrong chat.

4. **Once R2 + RunPod are configured** (separate workstream), run `python services/splat-trainer/scripts/deploy_runpod.py create --image ghcr.io/cc90210/propflow-splat-trainer:latest` and set `RUNPOD_ENDPOINT_ID` on Vercel. That's the last blocker before PropFlow walkthroughs can train a real model end-to-end.

---

## Decisions still pending for CC

Don't start coding the UX changes until CC confirms these:

- **Codex install flow scope:** Does CC want auto-install via the bridge (the bridge runs `npm install -g @openai/codex` with admin elevation prompted via UAC), or copy-paste-the-command + "I'll run it myself" flow? Auto-install is nicer but Windows UAC makes it brittle.
- **Settings consolidation naming:** "Agent Models" is my suggestion. CC may prefer "Connected Providers" or "AI Setup" or something brand-aligned.
- **Per-agent override semantics:** When a per-agent override exists for Bravo (e.g. Anthropic Direct) AND a workspace default (OpenRouter), which wins for an API-mode chat session with Bravo? Currently the code prefers per-agent; document the precedence in the UI.
- **Multi-provider precedence in API mode:** If CC has both Anthropic AND OpenRouter connected, what's the default? The agent's configured provider (cleanest) or the most recently used (most discoverable)?

---

## Files and references you'll want open

**Command Center (this repo):**
- `lib/chat-auth.ts` — resolver for (user, agent_key) → provider + decrypted key
- `lib/field-encryption.ts` — the KEK-using decrypt logic (read first, find the env var name)
- `lib/cloud-tool-runner.ts` — the native Anthropic tool_use loop; `TOOL_DEFINITIONS` lives here (line ~111)
- `components/ChatWidget.tsx` — 1,800+ line chat surface. Mode types at line 84. Error rendering at ~1671. submitText at ~764.
- `app/api/chat/route.ts` — main cloud chat entry point
- `app/api/chat/resume/route.ts` — bridge-proxy tool-result resume path
- `components/settings/LocalCliProvidersCard.tsx` — the Codex / Gemini / Claude Code detection cards
- `app/settings/page.tsx` — Settings hub

**Cross-empire references:**
- `~/Business-Empire-Agent/bravo_cli/bridge_chat_server.py` — local bridge daemon (port 9100), spawns Claude Code CLI subprocess
- `~/Business-Empire-Agent/bravo_cli/bridge_tools.py` — bridge's tool dispatch (where you'd add `install_cli` endpoint)
- `~/Business-Empire-Agent/scripts/email_engine.py` + `scripts/send_gateway.py` — already patched today; reference for "how a clean two-layer defense looks"

**Vercel project IDs (useful for env-var management via `vercel_env_tool.py`):**
- `agent-dashboard` (this Command Center) — `prj_zVcflyqzh2Ljbx7U6NlyztU0yYIN` — deploys to `agent-dashboard-cc90210.vercel.app`
- `real-estate-app` (PropFlow) — `prj_zTvnKVBkcV4j9DPfPle3m6X1P8cU`

**Supabase project refs:**
- Bravo's empire DB (Command Center's `BRAVO_SUPABASE_URL`) — `phctllmtsogkovoilwos.supabase.co` (account: CC's main, GitHub-linked)
- PropFlow's project — `yuqwdwsdjxliaipkyskg.supabase.co` (account: goldstorm2003@gmail.com, SEPARATE from main)

**Access tokens in `.env.agents` (BEA, never read directly):**
- `SUPABASE_ACCESS_TOKEN` — for the CC main account
- `ACCESS_TOKEN` — for the goldstorm2003 account (PropFlow only)
- `VERCEL_TOKEN` + `VERCEL_TEAM_ID` — full Vercel API access
- `RUNPOD_API_KEY` — already set
- No Cloudflare R2 creds currently — that's CC's pending step

---

## How this session got here (context for review)

Started today fixing PropFlow's broken landing page (Supabase paused, CC resumed, I applied migration). Then CC tested the Command Center chat with `BRAVO` agent on mode `CLI (local bridge)`, asked it to send an email — it sent an email containing just the string `"true"`. Diagnosed + fixed two layers (`email_engine.py` CLI + `send_gateway.py` gateway). Then CC opened the Command Center on `API + local tools` mode, hit the AES-GCM error. I diagnosed it as KEK-rotation. CC asked for the "extensive fix with sequential thinking" and I sketched Plan A/B/C. Mid-proposal CC realized they were in the wrong chat (the IDE-side Bravo session, not the in-Command-Center chat). Hence this handoff.

If you're the in-Command-Center Bravo picking this up: you have the same identity, same brain, just different access. The bridge running locally on CC's machine is YOU. Read this doc, verify my diagnoses, ship the fixes CC greenlights.

Good luck — this should be a clean handoff.
