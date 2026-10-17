# AI Auto Leasing — backend handover

**From:** APEX (Adon's agent, machine ECHELON)
**To:** Bravo (CC's agent, machine CCPC)
**Date:** 2026-09-19
**Subject:** The marketing site is live and static. It captures nothing. This is what exists, what does not, and the fences on building the part that does.

---

## 0. Which paths in here you can actually open

This document lives in `oasis-command-center` because that is the repo we share.
Paths it mentions do not all live here, and two of them you cannot read at all from
CCPC today:

| Path prefix | Repo | Readable from CCPC? |
|---|---|---|
| `docs/coordination/…` | oasis-command-center | **yes** — you are reading one |
| `src/…`, `scripts/check-live-build.mjs`, `wrangler.jsonc` | `echelonxaisolutions-alt/ai-auto-leasing` | **no** — private, see §2 |
| `scripts/turso_*.mjs`, `scripts/wrangler_with_token.mjs`, `.rules/…`, `docs/BUILD_ACCEPTANCE_STANDARD.md` | APEX's JARVIS repo | **no** — Adon's private repo, not shared |

Where a JARVIS script is named, treat it as a description of a capability APEX holds,
not an instruction you can run. If you need one of those steps taken, post a `blocked`
row and APEX will run it.

The parts you can act on without any new access are §4 (what the forms do, which is
reasoning about a design, not a file read), §5.2-§5.5 (architecture, fences,
acceptance) and §6-§7 (traps). Those are the substance.

---

## 1. Read this first: the site is NOT broken, it is UNFINISHED

The phrase "get the website up and running" has been used about this project, and it
is misleading. The website is up. It has been up since 2026-09-18.

| Thing | State |
|---|---|
| Static marketing site, 33 pages | **LIVE**, current build |
| Cloudflare deployment | **ONE**, pinned, verified |
| Lead capture | **DOES NOT EXIST** |
| Database | **EXISTS, EMPTY** — `ai-auto-leasing`, minted 2026-09-19, 0 tables |
| Client's own domain | **NOT POINTED AT US** |

Do not spend time debugging the deployment. Spend it on §5.

---

## 2. Where everything is

| Asset | Location |
|---|---|
| Repo (canonical) | `echelonxaisolutions-alt/ai-auto-leasing`, **PRIVATE**, default branch `master` |
| Repo (stale copy) | `CC90210/ai-auto-leasing` — master `4082d3b`, superseded, kept as backup only |
| Local checkout | `C:/Users/echel/ai-auto-leasing` (ECHELON) |
| Live URL | `https://ai-auto-leasing.oasisaisolutions.workers.dev` |
| Cloudflare account | Oasis business — `e371c0f2dfde76e329b351a54bc738fe` |
| Stack | Astro 5 static + Tailwind 4 + GSAP + three.js. No SSR, no adapter. |

### 🚨 ACCESS: you probably cannot see the canonical repo

The repo moved on 2026-09-18 from CC's GitHub account to **Adon's own**
(`echelonxaisolutions-alt`). If you are authenticated as `CC90210` you will get a
**404**, not a permission error — GitHub serves 404 for private repos you cannot see.

**Do not conclude the repo is missing or that the move failed.** Ask Adon to add
your account as a collaborator. Until then, `CC90210/ai-auto-leasing` is a valid
read of the ARCHITECTURE but its master is two merges behind; do not build against
it without diffing first.

---

## 3. Deployment — one account, pinned, and the trap that made it two

Deploy: `node scripts/wrangler_with_token.mjs C:/Users/echel/ai-auto-leasing deploy`
(from JARVIS; the API token is loaded internally and never reaches a command line).

🚨 **`wrangler.jsonc` pins `account_id` on purpose. Do not remove it.**

The single `CLOUDFLARE_API_TOKEN` belongs to `konamak@icloud.com` and can reach TWO
accounts. Injecting the token **overrides** wrangler's account selection, so a deploy
lands on whichever account the token lists first and reports success without naming
it. That is how this site ran on two accounts at once, serving two different builds,
with every health check returning HTTP 200 on both for weeks. Removing the pin does
not make a deploy fail — it makes it silently ambiguous again, which is worse.

The duplicate Worker on the personal account was deleted 2026-09-18 and confirmed 404.

**Verify a deploy by CONTENT, not status code:**
`node scripts/check-live-build.mjs` (in the site repo) matches strings that only exist
in a known build. A 200 proves a host answers; it says nothing about what it answered
with, and a byte count is a guess dressed up as a measurement.

⚠️ **A deleted Worker keeps serving from edge cache for a few minutes.** The first
probe after the delete returned 200 with the OLD build and looked exactly like a failed
delete. The API already showed it gone. Re-probe before concluding anything.

---

## 4. What the forms do today

All four forms — quote (`/free-quote`), credit application, contact, accessibility
barrier — share one implementation: `src/scripts/forms.ts`.

There is **no `data-endpoint` set on any form in the repo.** Grep it and confirm; do
not take this document's word for it. Every form therefore takes the fallback path:
it validates client-side, composes a structured email, hands it to the visitor's mail
client, and shows a receipt that states plainly that the message was handed off rather
than delivered.

That receipt copy is deliberate and **must not be softened into a delivery claim** while
the fallback is what runs. The site cannot know the message arrived.

The seam for making it real already exists and is documented in the header comment of
`forms.ts`: set `data-endpoint` on the `<form>`, and `postTo()` POSTs JSON and only shows
the receipt on a 2xx.

**Commercial reality to hold in mind:** a leasing site whose "Get my free quote" button
opens the visitor's email client loses the large majority of its leads. This is the
single highest-value thing left to build on this project.

---

## 5. The build: lead capture on Turso + Cloudflare

### 5.1 The database now EXISTS (minted 2026-09-19)

| | |
|---|---|
| Database | `ai-auto-leasing`, org `cc90210`, group `cc90210` |
| Hostname | `ai-auto-leasing-cc90210.aws-us-west-2.turso.io` |
| Credential names | `AIAUTO_TURSO_DATABASE_URL`, `AIAUTO_TURSO_AUTH_TOKEN` |
| Roster entry | registered in `scripts/turso_sql.mjs` as `ai-auto-leasing` |
| Schema | **empty, 0 tables** — the schema is yours to design |

Reach it with `node scripts/turso_sql.mjs --db ai-auto-leasing "SELECT 1"`
(read-only unless you pass `--write`).

Verified on mint, not assumed: `SELECT 1` returned a row. A success line from the
minting tool only proves a file was written; opening the database is what proves the
token works.

🚨 **Adon runs any future mint**, not you and not me:
`node scripts/turso_mint_token.mjs <name> --prefix <PREFIX>_TURSO --create`.
It writes into the agent-protected credential file, and the token must not pass through
a model context. Treat this as a hard human dependency, not a step to work around.

### 5.2 Architecture — DECIDED 2026-09-19: option A

Adon chose **A**: this site gets its own Worker route and its own Turso database.
Recorded here with the alternative, so the reasoning survives.

**A. Its own Worker + its own Turso database (recommended).**
Add an `/api/lead` Worker route to this repo, talking to a dedicated `ai-auto` Turso
database over libSQL HTTP. Client data stays in the client's own database. Revocable
independently. No coupling to the Oasis platform's schema or its release cadence.

**B. Route through the existing oasis `/api/pg` bridge.**
Reuses `services/_shared/turso-bridge.js` and needs no new credential in a Worker. But
it puts one client's leads inside the empire data plane, couples this site's uptime to
oasis, and means a client project authenticating with an APEX credential. I do not
recommend it for third-party client work.

### 5.3 🚨 Adding an API changes the deployment model — know what you are giving up

`wrangler.jsonc` currently declares **assets only, with no Worker script entrypoint,
on purpose.** The whole site prerenders, so nothing runs in workerd at request time,
which makes the "Node `fs` read reached the Worker" failure class *impossible* here.
That class of failure is real on this estate and cost a full day on 2026-09-15.

An `/api/lead` route reintroduces it. That is an acceptable trade for working lead
capture, but make it deliberately: keep the Worker's surface to the API routes only,
never let a runtime `fs` read into that path, and do not let the static pages start
being served by script.

### 5.4 Fences — non-negotiable, these are load-bearing

These come from the estate's standing rules. A green test run is not permission to skip one.

1. **Fail closed.** The endpoint denies on error. A lead-capture route that swallows a
   database failure and returns 200 is a silent lead leak, and it will look healthy.
2. **Verify contribution, not presence.** Assert that a row LANDED, not that the call
   did not raise. Never let a `catch` around the write return success.
3. **Consent evidence at ingest.** Timestamp + IP + the exact consent text shown, stored
   with the lead. Public or volunteered contact data is not consent.
4. **Server-side validation is mandatory** — the client-side rules in `forms.ts` are a
   convenience, not a control. Re-validate everything, including the phone digit count
   (`hasEnoughDigits`, which exists because `"()--- --- --"` passed a character-class
   check with zero digits).
5. **Spam controls and documented retention** before the form handles real customer data.
   This is `.rules/09-web-accessibility.md`'s requirement, not an optional hardening step.
6. **PII discipline.** Redact in logs. Never log the raw payload. If SSN/EIN ever enters
   a credit application path, tokenize at ingest (`last4` + salted hash) — do not store it.
7. **One send gate.** Any email this generates routes through the single send gate. A
   sibling `sendMail` call is a finding, not a shortcut.
8. **argv, never shell strings** for anything touching lead data.
9. **Row-level access in the same migration** as any table holding PII.
10. **AI governance register** if any model touches the lead flow (scoring, routing,
    drafting replies): `.rules/08-ai-governance.md` + `npm run governance:check`.

### 5.5 Definition of done

`docs/BUILD_ACCEPTANCE_STANDARD.md` — ten checks, including a production-shaped canary
against a permanent synthetic fixture, and verification of the provider receipt or state
transition. **Never use a real customer to test this.** Unit tests and a clean build are
not completion.

---

## 6. Traps already paid for on this codebase

Do not re-learn these. Each one cost real time.

| Trap | What happens |
|---|---|
| Re-parented pivots | `attach()` preserves world transforms, so a wrong pivot is invisible until the object ROTATES. Refresh `matrixWorld` first, then prove the pivot by animating it once and measuring. This buried 24 wheel meshes 6m under the road while frame one looked perfect. |
| `Vector3.project` behind the camera | `w` is negative; results come back mirrored and enormous. Reads as "off-frame" rather than as nonsense. Drop and count those corners. |
| Symmetric characters | `A I U T O` are all symmetric left-to-right, so upside-down and back-to-front are indistinguishable in a render. Photograph before and after; do not reason about UV conventions. |
| Masking an emissive | Multiplying emissive by a mask removes the mask's mean. Restore the gain or the scene just gets darker. |
| Software WebGL timing | The render loop clamps `dt` and swiftshader renders about once a second. **Poll for progress, never wait a fixed wall-clock window** — a 2.5s wait sampled 1 degree of a 15 deg/s turn and failed a working feature. |
| Playwright screenshot default | 30s assumes a GPU. Every InstancedMesh added pushes the software path closer to a timeout that reads like a broken page. |
| Scroll checks at `scrollY 0` | A downward swipe at the top asks for a scroll the browser clamps. Two checks could not fail and reported clean passes on the exact defect they were written for. |
| Credential ownership | See §7. |

---

## 7. 🚨 Credential ownership — the one that caused the most damage

**Ask a credential who it is before you use it to create anything.**

The GitHub PAT in the agents credential file belongs to **CC90210**, not to Adon. Every
repo built "for Adon" therefore landed on CC's account, and Adon got a 404 on every link
for months — because GitHub serves 404, not 403, for a private repo you cannot see, so
it read as a broken link rather than an access problem.

The same class of error produced the two-account Cloudflare split in §3.

**Rule:** run the whoami (`gh api user`, `wrangler whoami`) and say the answer out loud
before creating anything someone else will need to open. A token that works is not
evidence that it is the right token. And when a human reports a 404 on a private
resource, treat it as an access question first and a broken-link question second.

---

## 8. Open decisions that need Adon, not us

1. **Architecture A or B** (§5.2). I recommend A.
2. **Minting the Turso database** (§5.1) — only he can run it.
3. **Repo access for Bravo** (§2) — his account, his call.
4. **The domain.** `aiautoleasingusa.com` is still the client's original site and no
   custom domain is bound to the Worker. Binding it is the switch that puts this in
   front of the client's actual customers. **Do not bind it** on your own initiative.

---

## 9. Coordination

Contract: `oasis-command-center/docs/coordination/COORDINATION_CONTRACT.md` — **the files
win** over any chat snapshot, including this document.

- Take a lease before editing shared paths: `node scripts/coord_claim.mjs acquire …`
- Status IS escalation: a credential, quota, auth or dependency failure must be posted
  as `blocked`, or the poller never wakes.
- Coherence-gate this handover. It is archived context the moment it is written.
  Re-verify against `origin/master` and the live API before acting on any claim in it,
  including the claim that no form has an endpoint.
