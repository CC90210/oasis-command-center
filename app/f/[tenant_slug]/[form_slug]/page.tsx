/**
 * /f/[tenant_slug]/[form_slug] — anonymous share-link form page.
 *
 * Sibling of /f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx (the
 * Solara-minted personalized flow). This route is the one operators
 * copy from the Forms dashboard and paste into Slack / SMS / etc —
 * anyone with the URL can fill the form, and the server creates a
 * fresh lead on submit (NOT on page-load, to avoid bot-driven row
 * inflation). The first call to /api/forms/submit goes out with
 * anonymous_init = { tenant_slug, form_slug } and no token; the
 * server replies with a signed token the client uses for subsequent
 * steps in the same session.
 *
 * No HMAC verification on this route — auth is bound to the form's
 * `enabled` flag and the (tenant_slug, form_slug) uniqueness check in
 * the submit route.
 *
 * OFFER PAGES (2026-10-08). When the form has an offer page that is LIVE
 * (form_offer_pages, bravo__203), this URL draws that page, with this same form
 * inside its Book section. Otherwise (no row, a draft nobody published, the
 * table not there yet, or any error in the page layer) it renders exactly what
 * it always has: the FormPublicClient element below, unchanged.
 * tests/offer-pages-public.test.ts holds that byte for byte.
 *
 * ?offer_preview=1 shows the DRAFT, but only to a signed-in owner or admin of
 * the form's own workspace (the builder's Preview tab). Everyone else gets the
 * public page, and a preview never mounts a live form.
 *
 * AN OFFER'S NAME IS INTERNAL (the New offer dialog says so). A form with an
 * offer page and no headline of its own is titled with the workspace's name on
 * its plain form and in its tab, and a live page whose headline is missing
 * falls back to the form's own headline, then the workspace's name: never the
 * form's name. A form with its own headline, and every intake form, renders
 * exactly as before.
 */

import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { getServiceSupabase } from "@/lib/supabase-server";
import { FormPublicClient } from "@/components/forms/FormPublicClient";
import { OfferPage } from "@/components/offer-pages/OfferPage";
import { consentBrandForTenant } from "@/lib/consent/brand-for-tenant";
import {
  parseFormSteps,
  parseFormBranding,
  type FormStep,
  type FormBranding,
} from "@/lib/forms/types";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { publicMarkForTenant, faviconForTenant, publicIdentityForTenant } from "@/lib/tenant/public-identity";
import { displayLogoUrl } from "@/lib/tenant/logo-url";
import { offerPagesDb, readOfferRow, readPublicOfferState, type PublicOfferState } from "@/lib/offer-pages/store";
import { fallbackHeadline } from "@/lib/offer-pages/operator";
import { prepareOfferRender, type PreparedOffer } from "@/lib/offer-pages/render";
import type { OfferPageDoc } from "@/lib/offer-pages/types";
import { signMediaUrls } from "@/lib/founders/marketing-queries";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { resolveBookingUrl } from "@/lib/booking-link";
import { CONTACT_EMAIL } from "@/lib/marketing/routes";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolvePersona } from "@/lib/role-surfaces";
import { formsEditRefusal } from "@/lib/forms/access";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Per-form metadata so the browser tab shows the tenant brand instead of
 * the dashboard's default "OASIS AI · Agent Command Center". A prospect
 * opening a SunBiz application form sees the form's headline in their
 * tab — not the operator-side product name. noindex,nofollow keeps
 * per-tenant intake forms out of Google search results.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const resolved = await params;
  const db = getServiceSupabase();
  const lookup = await resolvePublicForm(db, resolved.tenant_slug, resolved.form_slug);
  if (!lookup.ok) {
    return { title: "Form", robots: { index: false, follow: false } };
  }
  const offer = await offerState(lookup.form.tenant_id, lookup.form.id);
  let title = lookup.form.name || "Application";
  let headline = "";
  try {
    headline = parseFormBranding(lookup.form.branding).headline || "";
  } catch {
    // Fall through to form name on parse failure.
  }
  if (headline) title = headline;
  // An offer's name is internal: with no headline of its own, its tab says the
  // workspace's name, never the form's.
  else if (offer.hasRow) title = (await workspaceDisplayName(lookup.form.tenant_id)) || "Application";
  // The TAB belongs to the tenant too. app/layout.tsx sets one global icon —
  // OASIS AI's — so a SunBiz merchant uploading three months of bank statements
  // saw another company's mark in the browser tab on the most sensitive page in
  // the flow. Resolved per tenant here; an unmapped tenant keeps the platform
  // default rather than borrowing anyone's.
  const icon = faviconForTenant({
    tenantId: lookup.form.tenant_id,
    tenantSlug: resolved.tenant_slug,
  });
  // A live offer page names the tab and the link preview from its own words.
  // noindex either way (D8): offer pages stay out of search results.
  const live = offer.live;
  const description = live ? live.seo.description || live.hero.subheadline : undefined;
  if (live) title = live.seo.title || live.hero.headline || title;
  return {
    title,
    ...(description ? { description } : {}),
    robots: { index: false, follow: false },
    ...(icon ? { icons: { icon } } : {}),
  };
}

/** A form's offer page state, read once per request (metadata and page share it). */
const offerState = cache(async (tenantId: string, formId: string): Promise<PublicOfferState> => {
  const db = offerPagesDb();
  return db ? readPublicOfferState(db, tenantId, formId) : { hasRow: false, live: null };
});

/**
 * The workspace's public name: its brand's display name, else its own name;
 * "" only when it has neither. What an offer falls back to where it would
 * otherwise show the form's name, which is internal.
 */
const workspaceDisplayName = cache(async (tenantId: string): Promise<string> => {
  const known = publicIdentityForTenant({ tenantId })?.displayName ?? "";
  if (known) return known;
  const db = offerPagesDb();
  if (!db) return "";
  try {
    const t = await db.execute({ sql: "SELECT name FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
    return String((t.rows[0] as unknown as { name?: unknown } | undefined)?.name ?? "").trim();
  } catch {
    return "";
  }
});

type RouteParams = {
  tenant_slug: string;
  form_slug: string;
};

type LoadResult =
  | {
      ok: true;
      form: {
        id: string;
        tenant_id: string;
        slug: string;
        name: string;
        branding: FormBranding;
        steps: FormStep[];
        redirect_url: string | null;
      };
      tenant_slug: string;
    }
  | {
      ok: false;
      reason: "not_found" | "form_corrupt";
      detail?: string;
    };

async function loadForm(params: RouteParams): Promise<LoadResult> {
  const db = getServiceSupabase();
  const resolved = await resolvePublicForm(db, params.tenant_slug, params.form_slug);
  if (!resolved.ok) {
    return { ok: false, reason: "not_found" };
  }

  let steps: FormStep[];
  let branding: FormBranding;
  try {
    steps = parseFormSteps(resolved.form.steps);
    branding = parseFormBranding(resolved.form.branding);
  } catch (err) {
    return {
      ok: false,
      reason: "form_corrupt",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  // Logo fallback chain, most specific first. Resolved HERE, server-side,
  // because the mark comes from lib/email/brands.ts which reads server env.
  //
  //   1. the form's own branding.logo_url   (an operator set it on this form)
  //   2. the tenant's logo_url               (an operator set it on the tenant)
  //   3. the tenant -> brand registry        (the company this tenant IS)
  //   4. nothing                             (render a neutral header)
  //
  // Rung 3 is new and rung 4 is the point. Before 2026-09-18 the chain stopped
  // at rung 2 and the RENDER then substituted <SunMark/> — "Gold SunBiz sun
  // glyph" by its own doc comment — for anyone who fell through. Both OASIS
  // forms and both tenants carry a NULL logo_url, so every OASIS prospect was
  // asked for their name and mobile under a lending client's mark. All four
  // SunBiz forms set branding.logo_url, so they win at rung 1 and never saw it:
  // the fallback was only ever visible to the tenants it did not belong to.
  //
  // publicMarkForTenant fails closed. An unmapped tenant gets null and a
  // brandless header, never another company's glyph.
  if (branding.logo_url == null && resolved.tenant_logo_url) {
    branding = { ...branding, logo_url: resolved.tenant_logo_url };
  }
  if (branding.logo_url == null) {
    const mark = publicMarkForTenant({
      tenantId: resolved.form.tenant_id,
      tenantSlug: resolved.tenant_slug,
    });
    if (mark) branding = { ...branding, logo_url: mark };
  }
  // The address the logo is DRAWN from (lib/tenant/logo-url.ts): an uploaded
  // logo stored as an R2 address (which answered 404 on 2026-10-11) is served
  // through our own route; an unusable value draws no logo at all.
  if (branding.logo_url != null) {
    branding = { ...branding, logo_url: displayLogoUrl(branding.logo_url) ?? undefined };
  }

  return {
    ok: true,
    form: {
      id: resolved.form.id,
      tenant_id: resolved.form.tenant_id,
      slug: resolved.form.slug,
      name: resolved.form.name,
      branding,
      steps,
      redirect_url: resolved.form.redirect_url,
    },
    tenant_slug: resolved.tenant_slug,
  };
}

export default async function AnonymousFormPage({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>;
  // ?rep=<jordan|alex|matt> — per-agent routing. Each agent shares this same
  // interest form with their own rep param; the submit route resolves it to
  // assigned_to so the lead lands under that agent. Spoofing only reassigns
  // among real tenant members (resolved server-side), never an outsider.
  //
  // ?source=<text|dial> — origination attribution. Orthogonal to ?rep: the same
  // agent blasts texts AND dials, so both params travel together on a link.
  // Passed through raw; lib/forms/lead-source.ts normalizes it server-side on
  // submit, where a bad value becomes "unknown" instead of rejecting the lead.
  searchParams?: Promise<{ rep?: string; source?: string; offer_preview?: string }>;
}) {
  const resolved = await params;
  const sp = (await searchParams) || {};
  const rep = typeof sp.rep === "string" && sp.rep.trim() ? sp.rep.trim().toLowerCase() : undefined;
  const source = typeof sp.source === "string" && sp.source.trim() ? sp.source.trim() : undefined;
  const result = await loadForm(resolved);

  if (!result.ok) {
    if (result.reason === "form_corrupt") {
      return <FormErrorPage reason={result.reason} detail={result.detail} />;
    }
    notFound();
  }

  const offer = await loadOfferView(result, sp.offer_preview === "1");
  if (offer) {
    const tenantId = result.form.tenant_id;
    const oasis = isOasisInternalTenant(tenantId);
    return (
      <OfferPage
        prepared={offer.prepared}
        workspaceName={offer.workspaceName}
        logoUrl={offer.doc.theme.logo === "none" ? null : (result.form.branding.logo_url ?? null)}
        legalLinks={oasis}
        // A client workspace has no booking link of its own yet; OASIS's link
        // must never appear on another company's page.
        bookingUrl={oasis ? resolveBookingUrl() || null : null}
        contactEmail={oasis ? CONTACT_EMAIL : null}
        preview={offer.preview ? { steps: result.form.steps.map((s) => s.title) } : null}
        form={
          offer.preview
            ? null
            : {
                formId: result.form.id,
                // Not drawn inside the Book section, but a client component's
                // props travel to the browser: the page's own headline, never
                // the form's internal name.
                formName: offer.prepared.page.hero.headline,
                // One accent on the page: the form's buttons follow it.
                branding: { ...result.form.branding, primary_color: offer.prepared.accent },
                steps: result.form.steps,
                redirectUrl: result.form.redirect_url,
                token: null,
                brand: consentBrandForTenant(result.tenant_slug, result.form.slug),
                submissionSource: source,
                submissionPath: `/f/${result.tenant_slug}/${result.form.slug}`,
                anonymousInit: {
                  tenant_slug: result.tenant_slug,
                  form_slug: result.form.slug,
                  ...(rep ? { rep } : {}),
                  ...(source ? { source } : {}),
                },
              }
        }
      />
    );
  }

  return (
    <FormPublicClient
      formId={result.form.id}
      formName={await plainFormName(result)}
      branding={result.form.branding}
      steps={result.form.steps}
      redirectUrl={result.form.redirect_url}
      token={null}
      // Sealed consent must name the brand whose disclosure the visitor was
      // actually shown. No Bluerise-hosted form exists yet, so this resolves to
      // SunBiz today; the slug check means standing one up needs no code change.
      brand={consentBrandForTenant(result.tenant_slug, result.form.slug)}
      // Channel on EVERY submit, not only inside anonymous_init.
      //
      // Codex review 2026-08-24 (P2, confirmed): a form whose step 0 is a
      // direct-to-storage upload calls ensureTokenForUpload() first, which
      // POSTs initialize_only:true. That request carries anonymous_init.source
      // but RETURNS at the token mint, before the submission row (and the
      // channel record) exists. Every later submit then has a token, so it
      // omits anonymous_init entirely — and the channel was lost, leaving the
      // completion email reporting Unknown for exactly the bank-statement
      // upload flow.
      //
      // Passing it here as well makes the anonymous page symmetric with the
      // token page: submission_source rides on every request regardless of
      // which auth shape that request uses. anonymousInit.source stays because
      // it feeds a DIFFERENT thing — lead_source origination at lead creation.
      submissionSource={source}
      submissionPath={`/f/${result.tenant_slug}/${result.form.slug}`}
      anonymousInit={{
        tenant_slug: result.tenant_slug,
        form_slug: result.form.slug,
        ...(rep ? { rep } : {}),
        ...(source ? { source } : {}),
      }}
    />
  );
}

type OfferView = { doc: OfferPageDoc; prepared: PreparedOffer; workspaceName: string; preview: boolean };

/**
 * The name the plain form falls back to when it has no headline of its own
 * (FormPublicClient: headline = branding.headline || formName). An offer's
 * name is internal, so an offer's plain form gets the workspace's name. Every
 * other form passes its own name, exactly as it always has.
 */
async function plainFormName(result: Extract<LoadResult, { ok: true }>): Promise<string> {
  if (result.form.branding.headline) return result.form.name;
  const { hasRow } = await offerState(result.form.tenant_id, result.form.id);
  return hasRow ? await workspaceDisplayName(result.form.tenant_id) : result.form.name;
}

/**
 * May this session see this form's DRAFT? A signed-in owner or admin of the
 * form's own workspace, by the rule every forms write uses. Anyone else,
 * including a signed-in member of another workspace, is an ordinary visitor.
 */
async function canPreview(tenantId: string): Promise<boolean> {
  try {
    const session = await resolveSessionContext();
    if (!session.ok || session.tenantId !== tenantId) return false;
    return formsEditRefusal({ persona: resolvePersona(session), tenantId }) === null;
  } catch {
    return false;
  }
}

/**
 * The offer page to draw instead of the plain form, or null for the plain form.
 * Never throws: whatever goes wrong in the page layer, the visitor gets the
 * form they came for, never a 500.
 */
async function loadOfferView(
  result: Extract<LoadResult, { ok: true }>,
  previewRequested: boolean,
): Promise<OfferView | null> {
  const db = offerPagesDb();
  if (!db) return null;
  const { id: formId, tenant_id: tenantId } = result.form;
  try {
    let doc: OfferPageDoc | null = null;
    let preview = false;
    if (previewRequested && (await canPreview(tenantId))) {
      const row = await readOfferRow(db, tenantId, formId);
      if (row.state === "row" && row.row.draft) {
        doc = row.row.draft;
        preview = true;
      }
    }
    if (!doc) doc = (await offerState(tenantId, formId)).live;
    if (!doc) return null;
    const workspaceName = await workspaceDisplayName(tenantId);
    const prepared = await prepareOfferRender({
      db,
      tenantId,
      formId,
      doc,
      // The form's own headline, read as the Publish gate reads it, then the
      // workspace's name: never the form's name, which is internal. (The gate
      // blocks a page with neither; this covers a headline removed later.)
      fallbackHeadline: fallbackHeadline({ branding: result.form.branding }) || workspaceName,
      sign: signMediaUrls,
      // The owner's preview signs its Library videos through the builder's own
      // route, which reads the draft; the public route reads only what is live.
      preview,
      // Read lazily: without an object store a link video simply has no poster.
      publicUrl: (path) => getServiceSupabase().storage.from("tenant-assets").getPublicUrl(path).data.publicUrl || null,
    });
    return { doc, prepared, workspaceName, preview };
  } catch (err) {
    console.error("[offer-pages] page layer failed; rendering the form", {
      form_id: formId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function FormErrorPage({
  detail,
}: {
  reason: "form_corrupt";
  detail?: string;
}) {
  const copy = {
    title: "Form configuration error",
    body: "The form's definition is malformed. Operators: open the form in /forms/[id]/edit to fix.",
  };
  return (
    <main className="min-h-screen bg-bg-deep text-fg flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full rounded-2xl border border-bg-border bg-bg-elev/50 p-8 text-center space-y-3">
        <h1 className="text-xl font-bold">{copy.title}</h1>
        <p className="text-sm text-fg-muted leading-relaxed">{copy.body}</p>
        {detail && (
          <pre className="text-[10px] font-mono text-fg-dim text-left bg-bg-deep border border-bg-border rounded p-2 overflow-x-auto">
            {detail}
          </pre>
        )}
      </div>
    </main>
  );
}
