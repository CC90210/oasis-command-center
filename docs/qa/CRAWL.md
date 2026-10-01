# The signed-in QA crawl

**What it is:** a robot that signs in as four different people and opens every
page of the Command Center, on a laptop screen and on a phone screen, and
writes down everything that is wrong: error pages, requests that fail, names
of our internal agents shown to a client, text cut off at the edge of a box,
pages that scroll sideways, bars drawn on top of each other, and slow pages.

**Code:** `scripts/qa/` (`crawl.mjs` drives the browser, `crawl-lib.mjs` holds
the rules, `build-db.mjs` + `seed.mjs` make the local database,
`egress-guard.cjs` cuts the network, `export-schema.mjs` refreshes the schema).
**Workflow:** `.github/workflows/qa-crawl.yml`.
**Tests:** `npm run test:qa` (in CI; the crawl itself is not, it needs a build).

---

## Who it signs in as

| Viewer | Who that is | Persona names checked |
|---|---|---|
| `founder_owner` | the OASIS founder owner (CC's role): owner of the OASIS workspace, platform operator, finance owner | no |
| `founder_second` | the second founder (Adon's role): OASIS admin with admin access, finance owner, not a platform operator | no |
| `client_owner` | the owner of a client workspace OASIS set up (Acme Plumbing, synthetic) | yes |
| `sales_rep` | an OASIS sales rep (closer) | yes |

The sessions are minted by the app's own code (`lib/turso-auth.ts`
`signSession`, with the onboarding claim from `lib/onboarding-claim.ts`, the
same claim the login route stamps) and signed with a secret generated for the
run. Nobody logs in with a password.

## Which pages

Derived, never hand-written: every row of the OS rail catalog
(`lib/os/nav.ts`) plus every `app/**/page.tsx`. Public pages are skipped by
middleware's own `isPublic` rule (marketing, sign-in, legal, public forms)
unless a rail row links them. Dynamic segments (`/pipeline/[id]`,
`/clients/[id]`, `/team/[dept]`, `/t/[slug]`...) are filled with the seeded ids
and the department catalog; a dynamic page with no value is listed under "Not
crawled" in the report rather than guessed. Every viewer opens every page, so
the report also shows who gets a 404 where (the access table).

## What it checks on every page

- **Error page:** a 5xx, the error boundary (`app/error.tsx`, its text and
  digest), an uncaught exception, a page that did not load, a signed-in viewer
  sent to sign in, or a 404 behind a link the viewer's own rail draws.
- **Failed request:** any request to the app that answered 4xx/5xx or failed.
- **Persona name leak:** Bravo, Maven, Atlas, Aura, Hermes, Lex or Conaugh in
  visible text, a tooltip, a label or the tab title, for the client owner and
  the rep.
- **Console error:** `console.error` output (resource failures are reported
  once, as failed requests).
- **Clipped text:** an element with text whose content is wider or taller than
  its box while the box hides the overflow (`overflow: hidden` or `clip`), and
  whose own text runs past the edge. The kind says how: `ellipsis`, `clamp`
  (a line clamp) or `cut` (the text just stops).
- **Overlapping fixed bars:** two fixed or sticky elements drawn over each
  other, at least one of them a bar (30% of the screen across or down), at the
  top of the page and again after scrolling down.
- **Horizontal page scroll:** the page is wider than the screen, with the
  elements that push past the right edge.
- **Slow:** more than 3 seconds from the start of navigation until `<main>`
  holds content (no loading skeleton left), or content that never appeared.

Defects are ranked in that order. The report groups repeats by the element or
shell component that causes them (the rail, the breadcrumb header, the page
title block, the footer), so one broken component shows as one cause.

## Running it on GitHub (normal way)

1. Actions > **QA crawl** > **Run workflow** (on `main`). Optional inputs:
   `viewers` (comma list), `match` (a regular expression over routes),
   `concurrency` (pages open at once per viewer, default 2).
2. Wait about 30 to 60 minutes. The job summary shows the counts and the
   grouped causes.
3. Download the **qa-crawl** artifact: `report/qa-crawl.md` (readable),
   `report/qa-crawl.json` (everything, for tools), `report/seed.json`, and
   `logs/server.log` + `logs/egress.log` for digging into an error page.

From a terminal:

```
gh workflow run qa-crawl.yml --repo CC90210/oasis-command-center --ref main
gh run watch <run id> --repo CC90210/oasis-command-center
gh run download <run id> --repo CC90210/oasis-command-center --name qa-crawl --dir qa-crawl
```

It never runs on pull requests (too slow) and reads no repository secret.

## Running it on your own machine

Needs a machine that can run `next build` (about 6 GB free memory). From the
repository root, in bash:

```
npm ci
npm i --no-save playwright@1.58.2 && npx playwright install chromium

export QA_DIR="$PWD/.qa"; mkdir -p "$QA_DIR/report" "$QA_DIR/logs"
export TURSO_DB_PATH="$QA_DIR/occ-qa.db" TURSO_DATABASE_URL="file:$QA_DIR/occ-qa.db" TURSO_AUTH_TOKEN=local-qa-placeholder
export EMPIRE_DATA_BACKEND=turso_cloud EMPIRE_AUTH_BACKEND=turso NEXT_TELEMETRY_DISABLED=1
export FOUNDERS_TENANT_IDS=ef8d389e-3f15-43f2-ae00-3660f69a1452 OPERATOR_EMAIL=conaugh@oasisai.work BRAVO_FORCE_DRY_RUN=1
export AUTH_SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")"
export BRAVO_FIELD_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
export EGRESS_LOG="$QA_DIR/logs/egress.log" GUARD="--require $PWD/scripts/qa/egress-guard.cjs"

node scripts/qa/build-db.mjs "$TURSO_DB_PATH"
NODE_OPTIONS="$GUARD --conditions=react-server" node --import tsx scripts/qa/seed.mjs "$TURSO_DB_PATH" "$QA_DIR/seed.json"
NODE_OPTIONS="$GUARD --max-old-space-size=4096" npm run build
NODE_OPTIONS="$GUARD" npx next start --port 3100 --hostname 127.0.0.1 > "$QA_DIR/logs/server.log" 2>&1 &
npm run qa:crawl -- --base http://127.0.0.1:3100 --db "$TURSO_DB_PATH" --seed "$QA_DIR/seed.json" --out "$QA_DIR/report" --egress-log "$EGRESS_LOG"
```

Never put a `.env*` file in the checkout for this: Next would load it, and the
point is that no production value is anywhere near the run. Add
`--screenshots "$QA_DIR/shots"` to keep a full-page screenshot of every visit
on your machine; screenshots are never uploaded or committed. `--match
'^/settings'` limits the routes, `--viewers client_owner` the viewers.

## Keeping the schema current

The local database is built from `scripts/qa/fixtures/production-schema.json`:
the CREATE statements of the production database's catalog, no rows. After a
migration lands, refresh it from a machine with Business-Empire-Agent
(read-only; `turso_tool.py` holds the credential and never prints it):

```
node scripts/qa/export-schema.mjs --turso-tool <path to Business-Empire-Agent>/scripts/integrations/turso_tool.py
```

It refuses to write a statement that is not a CREATE or that contains anything
shaped like a credential or a database address. `npm run test:qa` checks the
committed file the same way.

## What it does not do

- It does not fix anything. Findings go into the report and into work items.
- It does not click buttons or submit forms: it opens pages. A defect that
  needs a click to appear is not found.
- It runs `next start` (Node), not the Cloudflare Worker. Worker-only failures
  (bundle size, the one-byte source rule, a request held across requests) are
  covered by the tests in CI, not by this crawl.
- Features that need a third party (Stripe, Google, mail, the bridge) show
  their "not connected" state, because every outbound call is refused. The
  report lists which hosts the server tried to reach.
