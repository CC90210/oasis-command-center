# Portals — separating the software that shares this deployment

**Status:** live. Enforced by `tests/portal-boundaries.test.ts` in the `test:sunbiz` chain.
**Registry:** `lib/portals/registry.ts`

---

## The problem this solves

This repo deploys several distinct pieces of software from one Vercel project.
Adon, 2026-08-03:

> "Those are two very separate pieces of software that we're going to be building
> basically synonymously. I want to be able to tell you, 'Okay push this to the
> Sun Biz funding software' / 'pushes to the Oasis AI portal.' ... It's about
> separation. We need to ensure that there's no data leakage. We're going to be
> hosting different industries on this command center but within the command
> center itself there are going to be different applications for different
> industries ... going forward when we add real estate there's a different portal."

Without a declaration, "push this to SunBiz" is a vibe. With one it is checkable.

## The portals

| Portal | What it is | Route prefix | Tenant slugs | Owns |
|---|---|---|---|---|
| **founders** | OASIS's own tooling. Not a tenant, not sold, gated by `FOUNDERS_TENANT_IDS`. | `/founders` | *(none)* | `app/founders/`, `lib/founders/`, `lib/founders-marketing-core.ts`, `components/founders/` |
| **oasis** | OASIS AI's own product surface: the public site, agency lead lifecycle, empire observability. | *(shared routes + `/t/oasis/` + `app/(marketing)/`)* | `oasis`, `oasis-ai-cc` | `app/(marketing)/`, `components/marketing/`, `components/landing/`, `lib/marketing/`, `lib/oasis-*` |
| **sunbiz** | Sun Biz Funding, the lending CRM. A tenant of the platform. | *(shared routes + `/t/sun/`)* | `sun`, `sunbiz`, `submissions` | `lib/{lenders,underwriting,drips,renewals,applications,esign,clair,background-check,cold-outreach,import}/`, `lib/sunbiz-*`, `components/{sunbiz,lenders,underwriting,shop-out,shopping-out,offers,renewals,drips,applications,esign,import}/` |
| **shared** | Auth, tenancy, manifests, Supabase, the shell, UI primitives. | — | — | `SHARED_PREFIXES` in the registry |

The founders portal serves **no tenant slug**, deliberately. It is the platform
owner's own surface. If it ever gains one it has become a customer product,
which is the opposite of its purpose — there is a test asserting this.

## The rule

```
<portal> → same portal    ok
<portal> → shared         ok

founders → sunbiz         REFUSED
sunbiz   → founders       REFUSED   (both directions)
founders → oasis          REFUSED
oasis    → sunbiz         REFUSED
shared   → any portal     REFUSED
```

`shared → any portal` is the subtle and important one. **Shared infrastructure
that reaches into one portal is no longer shared.** It is how a platform file
quietly becomes SunBiz-only, and how the next industry inherits lending
behaviour nobody asked for. The known debt below is exactly that shape.

### The trap: there are two different "marketing"

| Path | Owner | What it is |
|---|---|---|
| `lib/marketing/`, `components/marketing/`, `app/(marketing)/` | **oasis** | the PUBLIC website — `/home`, `/work`, `/fleet`, plus `car-geometry.ts`, `fleet.ts` |
| `lib/founders-marketing-core.ts`, `app/founders/marketing/` | **founders** | the private internal marketing studio |

Same word, opposite owners. The boundary test asserts both classifications and
that one may not import the other, because this is the single most likely place
to wire up the wrong module.

## What "push this to SunBiz" means

A change belongs to a portal when **every path it touches is owned by that
portal or is shared**. That is now a fact you can check, not a judgement call:

```bash
# what a branch touches
git diff --name-only origin/main...HEAD

# is the boundary intact?
npx tsx tests/portal-boundaries.test.ts
```

Branch naming follows it: `apex/sunbiz-<topic>`, `apex/founders-<topic>`,
`apex/<topic>` for shared work.

**Honest limitation:** every portal ships from ONE Vercel project
(`agent-dashboard`) on one push to `main`. "Push to SunBiz" is a statement about
*scope*, not a separate deploy target. Nothing here changes what deploys.

If you want true deploy isolation — separate Vercel projects per portal, or
Vercel microfrontends — that is a much larger change and a separate decision.
It buys real blast-radius isolation and costs shared code becoming a published
package or duplicated. Not made here.

## Enforcement

`tests/portal-boundaries.test.ts` walks `app/`, `lib/`, `components/`, reads
every `@/…` import, and fails the build on a cross-portal edge. It is a **static
test over the whole tree**, the same mechanism as
`tests/clair-manual-only.test.ts`, and for the same reason: the property being
defended ("no file in one portal reaches into another") belongs to the tree, not
to any function, so it cannot be established by exercising one.

Current scan: **918 files, 2038 imports, 3 portals, 0 new cross-portal dependencies.**

### Known debt

Found by this test on its first run, 2026-08-03:

```
lib/manifest/data.ts  →  @/lib/drips/stage-cancel
```

`lib/manifest/data.ts` is the generic multi-tenant record layer behind every
`/t/<slug>/` surface. It calls SunBiz's drip cancellation on a stage transition,
so **every tenant — including a future real-estate portal — routes through the
lending drip engine.**

Recorded in `KNOWN_BOUNDARY_DEBT`, not fixed, on purpose: `data.ts` is
load-bearing shared production code and `stage-cancel` is what stops a merchant
being texted after they convert. The correct fix is an event/hook seam so each
portal registers its own stage-transition handler. That is a change to shared
production code and belongs to Adon's call, not to a founders-portal PR.

The list cannot rot: the test asserts every entry is **still** a real edge, so
fixing one forces deleting it, rather than leaving a stale allowlist that
silently re-permits the import later.

## Adding a portal (e.g. real estate)

1. Add an entry to `PORTALS` in `lib/portals/registry.ts` with its own
   `routePrefix`, `tenantSlugs` and `owns` paths.
2. Create `app/<prefix>/` and `lib/<id>/`. Follow `app/founders/` as the model:
   a `layout.tsx` giving the portal its own chrome, and pages that gate
   themselves.
3. Run `npm run test:sunbiz`. The boundary test picks the new portal up
   automatically and will refuse any import that crosses into another.

Two invariants the test enforces for free: no two portals may claim overlapping
paths, and no owned path may also be listed as shared.

## Visual separation

The multi-tenant CRM uses the neutral platform blue (`accent`, `#3b82f6`). The
founders portal uses **OASIS cyan `#1FE3F0`** — the real brand colour from
`brain/brand-assets/oasis-ai/BRAND_SYSTEM.md` in the CMO repo — plus its own
header band and sub-nav (`app/founders/layout.tsx`).

So it does not merely look different; it looks *more* like OASIS, while tenant
shells stay brand-neutral platform surfaces. A future real-estate portal gets
its own treatment the same way.
