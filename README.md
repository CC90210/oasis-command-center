# OASIS AI · Agent Command Center

The operating system for your AI agents. One URL that shows what every agent
in your empire is doing — outbound, inbound, decisions, pipeline, agent family,
live event bus tape. Multi-tenant, profile-driven, sellable to clients via the
setup wizard.

> Branded "OASIS AI" by default; the brand string is profile-driven, so each
> operator's dashboard renders their own brand pulled from `user_profiles.brand`.

Read-only for v1. Server-side Supabase queries (service role key stays on
the server). Built with Next.js 15 + React 19 + Tailwind + recharts + lucide-react.
No third-party auth libraries, no client-side state management.

## Pages

| Path | What it shows |
|---|---|
| `/` (Today) | Live MRR + primary lead + day schedule + manifesto |
| `/pipeline` | Merged Leads + Outbound + Inbound funnel |
| `/playbook` | Sales script + objection handlers + deal arch + daily drills |
| `/playbook/cold-call` | Cold Call Script V1 (5 stages, NEPQ) |
| `/playbook/objections` | 8 objection handlers |
| `/playbook/deals` | 3 client offers + 2 partner tiers |
| `/playbook/drills` | Mirror Run · Objection Volley · Recording Review |
| `/reasoning` | Decision tape with confidence + alternatives |
| `/agents` | Multi-agent status + event bus (filtered to enabled agents) |
| `/analytics` | MRR trajectory + funnel + lead sources |
| `/integrations` | Health dots for every connected service |
| `/settings` | Profile · integrations · agent wiring |
| `/api/inbound/n8n` | POST endpoint — n8n workflow posts classified emails here |

## Local dev

See [ENV_SETUP.md](ENV_SETUP.md) for the full environment variable reference.

```bash
git clone https://github.com/CC90210/oasis-command-center.git
cd oasis-command-center
npm install
# Create .env.local with at minimum BRAVO_SUPABASE_URL,
# BRAVO_SUPABASE_SERVICE_ROLE_KEY, BRAVO_SUPABASE_ANON_KEY, and one of
# BRAVO_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY.
npm run dev
# Open http://localhost:3100
```

## Deploy to Vercel

Production lives on the Vercel project `agent-dashboard` (org `cc90210`),
aliased at https://agent-dashboard-cc90210.vercel.app. The project is wired
to this GitHub repo — every push to `main` auto-deploys.

For first-time setup on a new machine:

```bash
npm i -g vercel
vercel link --project agent-dashboard
vercel pull                 # pulls production env into .vercel/.env.production.local
vercel --prod               # manual production deploy (rarely needed)
```

All production env vars live in **Vercel → agent-dashboard → Settings →
Environment Variables**. The dashboard never reads any `.env.agents` file.

## ISR — how fresh is the data?

Every page exports `dynamic = "force-dynamic"`, so every request hits Supabase
on the server. (We can switch to `revalidate = 20` later if Supabase egress
becomes a cost.)

## Why service role on the server (and why it's safe)

Every page is a React Server Component. Supabase queries run on Vercel's
serverless runtime; the service role key never touches the browser. The
client bundle contains zero Supabase credentials.

The `/api/inbound/n8n` route handler is a plain Node route (not edge) because
it uses Node's `crypto` for the SHA-256 secret hashing.

## Extending the dashboard

- **Add a page**: drop a folder under `app/` with `page.tsx` (or `route.ts` for an API)
- **Add a query**: extend `lib/queries.ts` — single source for all reads
- **Add a component**: drop it in `components/`, import with `@/components/...`
- **Add an agent**: edit `lib/agents.ts` (single registry feeds `/agents` + `/settings`)
- **Change the palette**: `tailwind.config.ts` has the OASIS-brand colors

## Files

| File | Purpose |
|---|---|
| `app/layout.tsx` | Root layout + Sidebar + footer |
| `app/page.tsx` | Today — the home dashboard |
| `app/<route>/page.tsx` | Every other page |
| `app/api/inbound/n8n/route.ts` | n8n inbound webhook |
| `components/Sidebar.tsx` | Left-rail nav |
| `components/Card.tsx` | Card / Stat / EmptyState / PageHeader / Tag |
| `components/IntegrationDot.tsx` | Green/red status dot for integrations |
| `components/charts/*.tsx` | recharts MRR + custom funnel + custom gauges |
| `lib/supabase.ts` | Supabase client factory + shared types |
| `lib/queries.ts` | Every query the dashboard makes |
| `lib/agents.ts` | Single agent registry (feeds `/agents` + `/settings`) |
| `lib/fmt.ts` | Time + status-color formatters |
| `tailwind.config.ts` | Theme (OASIS dark + gold) |

## Related backend

The Supabase schema, n8n bridge scripts, seeder, and setup wizard live in the
[Business-Empire-Agent](https://github.com/CC90210/CEO-Agent) repo:

- **Migrations**: `database/*.sql` — `user_profiles`, `daily_plans`, `n8n_webhook_secrets`, `integrations_health`, RPCs
- **Profile seeder**: `python scripts/seed_profile.py`
- **n8n bridge**: `python scripts/n8n_webhook_secret.py issue --profile-email <email>`
- **n8n setup doc**: `docs/N8N_INBOUND_WEBHOOK.md`
- **Bridge smoke test**: `python scripts/test_n8n_inbound_rpc.py`
- **Setup wizard hook**: `python install/bootstrap.py --create-command-center-account --email X --full-name Y`

This dashboard reads from the same Supabase project the rest of the empire
writes to (RLS-scoped per tenant).
