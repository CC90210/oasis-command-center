# OASIS AI · Agent Command Center

The operating system for CC's AI agents. One URL that shows what every agent
in the empire is doing — outbound, inbound, decisions, pipeline, agent family,
live event bus tape, and a chat surface that routes to either the operator's
local CLI (Claude Code / Codex / Gemini) or a cloud API key. Multi-tenant,
profile-driven, sellable to clients via the setup wizard.

> Branded "OASIS AI" by default; the brand string is profile-driven so each
> tenant's dashboard renders their own brand from `user_profiles.brand`.

Next.js 14 + React 19 + Tailwind + recharts + lucide-react + Supabase
(server-side, service role stays on the server). No third-party auth
libraries.

## Live

Production: **<https://agent-dashboard-cc90210.vercel.app>** (auth-gated —
CC's working copy). Every push to `main` auto-deploys via Vercel.

## Pages

| Path | What it shows |
|---|---|
| `/` (anonymous) | Public marketing home — rewritten to `app/(marketing)/home`, so the URL stays `/`. Signed in, the same path is the Today dashboard below. |
| `/fleet` · `/work` · `/about` · `/contact` | Public marketing site. Not `/agents` — that is the auth-gated dashboard page. |
| `/start` | Entry-path chooser (build / sign in / download). Was `/welcome` until 2026-07-31; the old URL 308s here. |
| `/privacy` · `/terms` · `/dmca` | Public legal pages, rendered from `lib/legal/constants.ts` |
| `/download` | Public download surface for the OASIS Desktop app (alpha.6) |
| `/desktop-link` | Deep-link sign-in target for the desktop app (mints pair codes, fires `oasis://pair` deep link) |
| `/login` · `/signup` | Supabase email + Google OAuth |
| `/forgot-password` · `/auth/reset-password` | Self-serve password recovery |
| `/` (Today) | Live MRR + primary lead + day schedule + manifesto |
| `/pipeline` | Merged Leads + Outbound + Inbound funnel |
| `/agents` | Multi-agent chat (CLI bridge or cloud API key), header status, history |
| `/reasoning` | Decision tape with confidence + alternatives |
| `/playbook` | Hub — sales script, deals, drills, security, onboarding, prompts |
| `/playbook/prompts` | 40 saved prompts (operator + client toolkit), live search |
| `/operations` | Bridge + warm pool + per-CLI status + activity tape |
| `/health` | Service health rollup |
| `/analytics` | MRR trajectory + funnel + lead sources |
| `/automations` | Cron jobs · n8n workflows · scheduled tasks |
| `/settings` | Profile · AI provider keys · agent wiring · devices |

## How chat routing works

The chat surface at `/agents` has two modes — selectable per-message via the
mode dropdown:

- **CLI (local bridge)** — browser POSTs directly to `localhost:9100/chat` on
  the operator's machine. The bridge (Python sidecar shipped with the desktop
  app or `bravo bridge serve`) spawns Claude Code / Codex / Gemini CLI with
  the operator's persona prompt. Full file/script access, free under the
  operator's CLI subscription.
- **Cloud + my files** / **Cloud only** — POST to `/api/chat` (Next route).
  Native Anthropic tool_use loop on the dashboard's API key. Cloud tools
  available immediately; deferred (file/bridge) tools round-trip via the
  browser to the operator's local bridge when present.

Bridge status dot in the sidebar is live: refreshed every 30s by ChatWidget's
client-side health probe against `localhost:9100/health`.

## Desktop app

The `apps/oasis-desktop/` Electron app lives in the
[Business-Empire-Agent](https://github.com/CC90210/CEO-Agent) repo. Current
release: **alpha.6** (Mac universal + Linux x86_64/arm64). Highlights:

- `oasis://` deep-link protocol — dashboard mints a pair code, fires
  `oasis://pair?code=...`, desktop catches it and redeems automatically.
- Magic-link Supabase session transport — after pairing, the desktop's
  Electron browser gets a real session cookie so the dashboard renders
  signed-in on first paint.
- Bridge sidecar with enriched PATH discovery (Homebrew / npm-global / Bun /
  Deno / nvm) so chat works from Electron's slim LaunchServices PATH.

Downloads route through `/api/download/desktop` which 307s to the latest
GitHub release asset for the operator's OS.

## Local dev

```bash
git clone https://github.com/CC90210/oasis-command-center.git
cd oasis-command-center
npm install
# Create .env.local — at minimum:
#   BRAVO_SUPABASE_URL
#   BRAVO_SUPABASE_SERVICE_ROLE_KEY
#   NEXT_PUBLIC_SUPABASE_ANON_KEY
#   BRAVO_ANTHROPIC_API_KEY (or BRAVO_OPENROUTER_API_KEY for cloud chat)
#   BRAVO_FIELD_ENCRYPTION_KEY (AES-256-GCM key for stored provider keys)
npm run dev
# Open http://localhost:3100
```

See [ENV_SETUP.md](ENV_SETUP.md) for the full environment variable reference.

## Deploy

Vercel project `agent-dashboard` (org `cc90210`). Every push to `main`
auto-deploys.

First-time CLI setup on a new machine:

```bash
npm i -g vercel
vercel link --project agent-dashboard
vercel pull                 # pulls production env into .vercel/
vercel --prod               # manual production deploy (rarely needed)
```

All production env vars live in **Vercel → agent-dashboard → Settings →
Environment Variables**. The dashboard never reads any `.env.agents` file.

## ISR + freshness

Most routes export `dynamic = "force-dynamic"` so every request hits Supabase
on the server. The home dashboard and Operations page poll their hot data
client-side too (bridge health every 30s, CLI status every 20s).

## Security

- Service role Supabase queries run on Vercel's serverless runtime; the key
  never touches the browser. Client bundle has zero Supabase credentials.
- Provider API keys stored in `agent_model_config.encrypted_api_key`
  (AES-256-GCM via `BRAVO_FIELD_ENCRYPTION_KEY`). Two-tier: workspace default
  + per-user override.
- `/api/inbound/n8n` is a plain Node route (not edge) — uses Node `crypto`
  for SHA-256 HMAC verification on incoming webhook signatures.
- Override approvals (`/overrides` was deprecated; the surface has been
  removed — `exec_guard` blocks now route through the local bridge's
  approval CLI directly).

## Extending the dashboard

- **Add a page**: drop a folder under `app/` with `page.tsx` (or `route.ts`
  for an API). Add a back-link to `/playbook` if it's a `/playbook/*` deep
  page (consistency with the other 9 deep pages).
- **Add a query**: extend `lib/queries.ts` — single source for all reads.
- **Add a component**: drop it in `components/`, import with `@/components/`.
- **Add an agent**: edit `lib/agents.ts` (single registry feeds `/agents` +
  `/settings`).
- **Add a prompt**: edit `lib/prompts-library.ts` — entry with id, category
  (`ops_daily` / `system_health` / `agent_tooling` / etc), audience
  (`operator` / `client` / `shared`), title (2-4 words), description (one
  sentence), and the prompt body.
- **Add a provider**: extend `lib/providers.ts` PROVIDER_REGISTRY + add the
  probe URL + headers in `app/api/agent-config/test-connection/route.ts`.
- **Change the palette**: `tailwind.config.ts` has the OASIS-brand colors.

## Sibling repos

The dashboard reads from the same Supabase the rest of the empire writes to
(RLS-scoped per tenant):

- [Business-Empire-Agent](https://github.com/CC90210/CEO-Agent) — Bravo's
  brain: bridge daemon (`bravo_cli/`), 115 CLI tools (`scripts/`), 150+
  skills, desktop app (`apps/oasis-desktop/`), Supabase migrations
  (`database/*.sql`), Telegram bridge, MCP server configs.
- [CMO-Agent](https://github.com/CC90210/CMO-Agent) — Maven (CMO).
- [CFO-Agent](https://github.com/CC90210/CFO-Agent) — Atlas (CFO).

This dashboard is the read-and-chat surface; mutations route through Bravo's
brain repo's APIs and the local bridge daemon.
