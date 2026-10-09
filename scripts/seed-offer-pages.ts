#!/usr/bin/env node
/**
 * seed-offer-pages.ts - give OASIS's two live funnels a DRAFT offer page.
 *
 *   /f/oasis-ai-cc/ai-audit  -> Free audit template; after the contact step the
 *                              visitor is offered a time to book (the booking link)
 *   /f/oasis-ai-cc/start     -> Book a call template, booking off (the questions only)
 *
 * DRAFTS ONLY. Nothing is published: until CC presses Publish in the builder,
 * every public URL serves exactly today's form. The only words a draft carries
 * are the ones the form already shows (its branding headline and subheadline),
 * copied into the hero. Every other section starts empty, and an empty section
 * is never drawn. NOTE: ai-audit's subheadline says "Four questions"; adding a
 * booking step changes that claim, so it is revised before publishing.
 *
 * DRY RUN BY DEFAULT. --apply writes. Never run by CI or a deploy. A form that
 * already has an offer page is left exactly as it is (the insert is
 * ON CONFLICT DO NOTHING), so re-running is safe.
 *
 * REQUIRES migration bravo__203 (form_offer_pages) applied, and Turso
 * credentials in the environment (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or
 * TURSO_DB_PATH for a local file).
 *
 * Run (credentials injected by the BEA wrapper, or already in the environment):
 *   node --import tsx scripts/seed-offer-pages.ts            # dry run
 *   node --import tsx scripts/seed-offer-pages.ts --apply    # write the two drafts
 */
import { getTursoClient, tursoConfigured } from "../lib/turso";
import { parseFormBranding } from "../lib/forms/types";
import { emptyDocForTemplate } from "../lib/offer-pages/templates";
import { parseOfferPageDoc, type BookMode, type TemplateKey } from "../lib/offer-pages/types";
import { createOfferRow, readOfferRow } from "../lib/offer-pages/store";

const apply = process.argv.includes("--apply");
const TENANT_SLUG = "oasis-ai-cc";
const PLAN: Array<{ slug: string; template: TemplateKey; mode: BookMode }> = [
  { slug: "ai-audit", template: "free_audit", mode: "form_then_link" },
  { slug: "start", template: "book_call", mode: "form" },
];

async function main() {
  if (!tursoConfigured()) {
    console.error("ERROR: Turso is not configured. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or TURSO_DB_PATH).");
    process.exit(2);
  }
  const db = getTursoClient();
  const t = await db.execute({ sql: "SELECT id FROM tenants WHERE slug = ? LIMIT 1", args: [TENANT_SLUG] });
  const tenantId = t.rows[0] ? String((t.rows[0] as unknown as { id: unknown }).id) : "";
  if (!tenantId) {
    console.error(`ERROR: workspace "${TENANT_SLUG}" not found.`);
    process.exit(3);
  }
  console.log(`workspace : ${TENANT_SLUG} (${tenantId})`);
  console.log(`mode      : ${apply ? "APPLY (drafts only, nothing published)" : "DRY RUN"}\n`);

  for (const item of PLAN) {
    const f = await db.execute({
      sql: "SELECT id, name, branding FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1",
      args: [tenantId, item.slug],
    });
    const row = f.rows[0] as unknown as { id: unknown; name: unknown; branding: unknown } | undefined;
    if (!row) {
      console.log(`${item.slug.padEnd(9)} : form not found, skipped`);
      continue;
    }
    const formId = String(row.id);
    const existing = await readOfferRow(db, tenantId, formId);
    if (existing.state === "unavailable") {
      console.error("ERROR: form_offer_pages is missing. Apply migration bravo__203 first.");
      process.exit(4);
    }
    if (existing.state === "row") {
      console.log(`${item.slug.padEnd(9)} : already has an offer page (${existing.row.live ? "live" : "draft"}), left as it is`);
      continue;
    }
    const branding = parseFormBranding(typeof row.branding === "string" ? JSON.parse(row.branding) : row.branding);
    const draft = emptyDocForTemplate(item.template, { headline: branding.headline, subheadline: branding.subheadline });
    draft.book = { ...draft.book, mode: item.mode };
    parseOfferPageDoc(JSON.stringify(draft)); // the same parser the builder and the page use
    console.log(`${item.slug.padEnd(9)} : form ${formId} "${String(row.name)}"`);
    console.log(`            template ${item.template}, book ${item.mode}, sections ${draft.sections.map((s) => s.key).join(", ")}`);
    console.log(`            hero headline    : ${draft.hero.headline ?? "(none: the builder asks for one)"}`);
    console.log(`            hero subheadline : ${draft.hero.subheadline ?? "(none)"}`);
    if (!apply) continue;
    const made = await createOfferRow(db, {
      tenantId,
      formId,
      template: item.template,
      draft,
      actor: null,
      now: new Date().toISOString(),
    });
    console.log(`            -> ${made.ok ? (made.created ? "DRAFT CREATED" : "already there, unchanged") : `NOT WRITTEN (${made.error})`}`);
  }
  if (!apply) console.log("\nDRY RUN - re-run with --apply to write the drafts. Nothing is ever published by this script.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
