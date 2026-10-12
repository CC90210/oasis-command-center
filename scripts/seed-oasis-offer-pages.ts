#!/usr/bin/env node
/**
 * seed-oasis-offer-pages.ts - create OASIS's four offer pages (PROTOCOL,
 * COMMAND, COMMUNITY, FLEET) and the "Start here" router (/vsl) as DRAFTS in
 * OASIS's own workspace, from content/offers/oasis/*.json (HANDOVER
 * 2026-10-12 sections 4 and 6, slice 4 "Content").
 *
 * Not to be confused with scripts/seed-offer-pages.ts, which gives the two
 * older funnels (ai-audit, start) an empty draft. This script never touches
 * those forms.
 *
 * WHAT IT WRITES, AND WHAT IT NEVER DOES:
 *   - Each form is created SWITCHED OFF (forms.enabled = 0). Nobody can reach
 *     it, and the claims gate refuses to publish a page whose form is off, so
 *     going live is always a person pressing On and then Publish.
 *   - Each page is saved as a DRAFT through the existing store function
 *     (createOfferRow): live = 0, published = NULL. Nothing is ever published.
 *   - The workspace is resolved from the database by its slug. No id is
 *     written in this file.
 *
 * IDEMPOTENT. A second run changes nothing:
 *   - a form that already exists and is OFF with the same name is this
 *     script's own (a run that stopped half way): it gets its draft if it has
 *     none, and is otherwise left exactly as it is;
 *   - a form that already exists and is ON, or carries another name, belongs
 *     to someone: it is left alone and gets no page;
 *   - a page that already exists is never overwritten (someone may have
 *     edited the draft in the builder).
 *
 * EVERY FILE IS CHECKED BEFORE ANYTHING IS WRITTEN: the form through the same
 * parsers the forms API uses, the page through parseOfferPageDoc. One bad file
 * means nothing is written at all.
 *
 * Run from the repo root (credentials in the environment, never in argv):
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --dry-run
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --apply
 * --tenant-slug oasis-ai-cc and exactly one of --dry-run / --apply are required;
 * anything else is refused before the database is opened.
 *
 * REQUIRES migration bravo__203 (form_offer_pages) and Turso credentials
 * (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or TURSO_DB_PATH for a local file).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "../lib/turso";
import {
  parseFormBranding,
  parseFormSteps,
  parseStepOutcomes,
  type FormBranding,
  type FormStep,
} from "../lib/forms/types";
import { parseOfferPageDoc, type OfferPageDoc } from "../lib/offer-pages/types";
import { createOfferRow, isMissingOfferTable, readOfferRow } from "../lib/offer-pages/store";
import { lintDoc, type ClaimHit } from "../lib/offer-pages/claims";

/** The only workspace this content belongs to. */
export const OASIS_TENANT_SLUG = "oasis-ai-cc";

/** The files, in the order they are seeded and reported. */
export const OASIS_OFFER_SLUGS = ["vsl", "protocol", "command", "community", "fleet"] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const TOP_KEYS = ["slug", "pillar", "form", "community_link", "work_steps", "routing_rules", "offer_page"];
const FORM_KEYS = ["name", "slug", "description", "branding", "steps", "on_complete_stage", "step_outcomes"];

export type OfferContent = {
  slug: string;
  pillar: string;
  form: {
    name: string;
    slug: string;
    description: string | null;
    branding: FormBranding;
    steps: FormStep[];
    on_complete_stage: string | null;
    step_outcomes: Record<string, string>;
  };
  communityLink: { label: string; href: string };
  doc: OfferPageDoc;
};

/** The tracked community link a page carries (HANDOVER section 5.4). */
export function communityHref(slug: string): string {
  return `/go/community?form=${slug}&t=${OASIS_TENANT_SLUG}`;
}

export class ContentError extends Error {
  constructor(
    public file: string,
    reason: string,
  ) {
    super(`${file}: ${reason}`);
    this.name = "ContentError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One content file, checked with the same parsers the forms API and the page builder use. Throws ContentError. */
export function parseOfferContent(raw: unknown, file: string): OfferContent {
  if (!isRecord(raw)) throw new ContentError(file, "expected a JSON object");
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) throw new ContentError(file, `unknown key "${k}"`);
  const slug = raw.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new ContentError(file, "slug must match /^[a-z0-9][a-z0-9_-]{1,62}$/");
  if (typeof raw.pillar !== "string" || !raw.pillar.trim()) throw new ContentError(file, "pillar is required");

  const f = raw.form;
  if (!isRecord(f)) throw new ContentError(file, "form is required");
  for (const k of Object.keys(f)) if (!FORM_KEYS.includes(k)) throw new ContentError(file, `unknown form key "${k}"`);
  if (f.slug !== slug) throw new ContentError(file, `form.slug must be "${slug}"`);
  if (typeof f.name !== "string" || !f.name.trim() || f.name.length > 200) throw new ContentError(file, "form.name is required (at most 200 characters)");
  if (f.description != null && (typeof f.description !== "string" || f.description.length > 1000)) {
    throw new ContentError(file, "form.description must be text of at most 1000 characters");
  }
  if (f.on_complete_stage != null && (typeof f.on_complete_stage !== "string" || !f.on_complete_stage.trim())) {
    throw new ContentError(file, "form.on_complete_stage must be a stage name or null");
  }
  let steps: FormStep[];
  let branding: FormBranding;
  let stepOutcomes: Record<string, string>;
  try {
    steps = parseFormSteps(f.steps);
    branding = parseFormBranding(f.branding);
    stepOutcomes = parseStepOutcomes(f.step_outcomes);
  } catch (err) {
    throw new ContentError(file, `form: ${err instanceof Error ? err.message : String(err)}`);
  }

  const link = raw.community_link;
  if (!isRecord(link) || typeof link.label !== "string" || typeof link.href !== "string") {
    throw new ContentError(file, "community_link needs a label and an href");
  }
  if (link.href !== communityHref(slug)) throw new ContentError(file, `community_link.href must be ${communityHref(slug)}`);

  let doc: OfferPageDoc;
  try {
    doc = parseOfferPageDoc(raw.offer_page);
  } catch (err) {
    throw new ContentError(file, `offer_page: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    slug,
    pillar: raw.pillar,
    form: {
      name: f.name.trim(),
      slug,
      description: typeof f.description === "string" ? f.description : null,
      branding,
      steps,
      on_complete_stage: typeof f.on_complete_stage === "string" ? f.on_complete_stage : null,
      step_outcomes: stepOutcomes,
    },
    communityLink: { label: link.label, href: link.href },
    doc,
  };
}

/** Every content file, all parsed before any is used. Throws on the first bad one. */
export function loadOasisOfferContent(dir: string = resolve(process.cwd(), "content", "offers", "oasis")): OfferContent[] {
  return OASIS_OFFER_SLUGS.map((slug) => {
    const file = join(dir, `${slug}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new ContentError(file, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const content = parseOfferContent(raw, file);
    if (content.slug !== slug) throw new ContentError(file, `slug must be "${slug}" (the file name)`);
    return content;
  });
}

export type Args = { tenantSlug: string; apply: boolean };

/** The command line. Refuses unless --tenant-slug oasis-ai-cc and exactly one of --dry-run / --apply are given. */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  let tenantSlug: string | null = null;
  let dryRun = false;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--apply") apply = true;
    else if (a === "--tenant-slug") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: "--tenant-slug needs a value" };
      tenantSlug = v;
      i++;
    } else if (a.startsWith("--tenant-slug=")) tenantSlug = a.slice("--tenant-slug=".length);
    else return { ok: false, error: `unknown argument "${a}"` };
  }
  if (tenantSlug === null) return { ok: false, error: `--tenant-slug ${OASIS_TENANT_SLUG} is required` };
  if (tenantSlug !== OASIS_TENANT_SLUG) {
    return { ok: false, error: `this content belongs to the ${OASIS_TENANT_SLUG} workspace only, not "${tenantSlug}"` };
  }
  if (dryRun === apply) return { ok: false, error: "pass exactly one of --dry-run or --apply" };
  return { ok: true, args: { tenantSlug, apply } };
}

export type FormOutcome =
  | "created"
  | "would_create"
  | "resumed" // our own switched-off form from an earlier run
  | "skipped_live" // a switched-on form with this slug: not ours to repurpose
  | "skipped_foreign"; // a switched-off form with this slug but another name
export type PageOutcome = "created" | "would_create" | "exists_left" | "skipped";

export type PageReport = {
  slug: string;
  pillar: string;
  formId: string | null;
  form: FormOutcome;
  page: PageOutcome;
  hits: ClaimHit[];
};

export type SeedReport = { tenantId: string; apply: boolean; pages: PageReport[] };

function rowsOf(rs: { columns: string[]; rows: unknown[] }): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown[])[i];
    });
    return o;
  });
}

/** The workspace's id, by slug. Exactly one row, or it refuses. */
export async function resolveTenantId(db: Client, slug: string): Promise<string> {
  const rows = rowsOf(await db.execute({ sql: "SELECT id FROM tenants WHERE slug = ? LIMIT 2", args: [slug] }));
  if (rows.length !== 1 || !rows[0].id) {
    throw new Error(rows.length ? `more than one workspace has the slug "${slug}"` : `workspace "${slug}" not found`);
  }
  return String(rows[0].id);
}

async function findForm(db: Client, tenantId: string, slug: string): Promise<{ id: string; name: string; enabled: boolean } | null> {
  const r = rowsOf(
    await db.execute({ sql: "SELECT id, name, enabled FROM forms WHERE tenant_id = ? AND slug = ? LIMIT 1", args: [tenantId, slug] }),
  )[0];
  return r ? { id: String(r.id), name: String(r.name), enabled: Number(r.enabled) === 1 } : null;
}

/**
 * Create the forms (switched off) and their draft pages. With apply = false it
 * reads only and reports what it would do. Never publishes, never switches a
 * form on, never overwrites an existing form or page.
 */
export async function seedOasisOfferPages(
  db: Client,
  input: { tenantSlug: string; apply: boolean; content: OfferContent[]; now?: string },
): Promise<SeedReport> {
  if (input.tenantSlug !== OASIS_TENANT_SLUG) throw new Error(`refusing: this content belongs to ${OASIS_TENANT_SLUG} only`);
  const tenantId = await resolveTenantId(db, input.tenantSlug);
  const now = input.now ?? new Date().toISOString();

  try {
    await db.execute("SELECT 1 FROM form_offer_pages LIMIT 1");
  } catch (err) {
    if (isMissingOfferTable(err)) throw new Error("form_offer_pages is missing: apply migration bravo__203 first");
    throw err;
  }

  const pages: PageReport[] = [];
  for (const c of input.content) {
    const hits = lintDoc(c.doc, { fallbackHeadline: c.form.branding.headline ?? "" });
    const existing = await findForm(db, tenantId, c.slug);
    let formId: string | null = existing?.id ?? null;
    let form: FormOutcome;
    if (!existing) {
      form = input.apply ? "created" : "would_create";
      if (input.apply) {
        const id = randomUUID();
        // enabled = 0: the form is off until a person switches it on. The
        // NOT EXISTS keeps a concurrent run from making a second one.
        await db.execute({
          sql: `INSERT INTO forms (id, tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes, enabled, redirect_url, created_by)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL
                WHERE NOT EXISTS (SELECT 1 FROM forms WHERE tenant_id = ? AND slug = ?)`,
          args: [
            id,
            tenantId,
            c.slug,
            c.form.name,
            c.form.description,
            JSON.stringify(c.form.branding),
            JSON.stringify(c.form.steps),
            c.form.on_complete_stage,
            JSON.stringify(c.form.step_outcomes),
            tenantId,
            c.slug,
          ],
        });
        const made = await findForm(db, tenantId, c.slug);
        if (!made) throw new Error(`form "${c.slug}" was not written`);
        if (made.id !== id || made.enabled) {
          // Someone else's form landed first: treat it like any existing form.
          pages.push({ slug: c.slug, pillar: c.pillar, formId: made.id, form: "skipped_foreign", page: "skipped", hits });
          continue;
        }
        formId = id;
      }
    } else if (existing.enabled) {
      pages.push({ slug: c.slug, pillar: c.pillar, formId: existing.id, form: "skipped_live", page: "skipped", hits });
      continue;
    } else if (existing.name !== c.form.name) {
      pages.push({ slug: c.slug, pillar: c.pillar, formId: existing.id, form: "skipped_foreign", page: "skipped", hits });
      continue;
    } else {
      form = "resumed";
    }

    let page: PageOutcome;
    if (!formId) {
      page = "would_create";
    } else {
      const row = await readOfferRow(db, tenantId, formId);
      if (row.state === "unavailable") throw new Error("form_offer_pages is missing: apply migration bravo__203 first");
      if (row.state === "row") page = "exists_left";
      else if (!input.apply) page = "would_create";
      else {
        const made = await createOfferRow(db, { tenantId, formId, template: c.doc.template, draft: c.doc, actor: null, now });
        if (!made.ok) throw new Error(`draft for "${c.slug}" not written: ${made.error}`);
        page = made.created ? "created" : "exists_left";
      }
    }
    pages.push({ slug: c.slug, pillar: c.pillar, formId, form, page, hits });
  }
  return { tenantId, apply: input.apply, pages };
}

/** The report as printed lines. */
export function formatReport(report: SeedReport, content: OfferContent[]): string[] {
  const out: string[] = [];
  out.push(`workspace : ${OASIS_TENANT_SLUG} (${report.tenantId})`);
  out.push(`mode      : ${report.apply ? "APPLY (forms switched off, pages saved as drafts, nothing published)" : "DRY RUN (nothing written)"}`);
  for (const p of report.pages) {
    const c = content.find((x) => x.slug === p.slug);
    out.push("");
    out.push(`${p.pillar} (/f/${OASIS_TENANT_SLUG}/${p.slug})`);
    out.push(`  form : ${p.form}${p.formId ? ` (${p.formId})` : ""}, switched off`);
    out.push(`  page : ${p.page}, draft only`);
    if (c) {
      out.push(`  headline : ${c.doc.hero.headline ?? "(none)"}`);
      out.push(`  sections : ${c.doc.sections.map((s) => s.key).join(", ")}; book ${c.doc.book.mode}`);
    }
    out.push(`  claims the linter flags (each needs an owner's tick before publish): ${p.hits.length}`);
    for (const h of p.hits) out.push(`    - [${h.why.join(", ")}] ${h.where}: ${h.sentence}`);
  }
  return out;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`REFUSED: ${parsed.error}`);
    console.error(`usage: node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug ${OASIS_TENANT_SLUG} (--dry-run | --apply)`);
    process.exit(2);
  }
  const content = loadOasisOfferContent();
  if (!tursoConfigured()) {
    console.error("ERROR: Turso is not configured. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or TURSO_DB_PATH).");
    process.exit(2);
  }
  const report = await seedOasisOfferPages(getTursoClient(), { ...parsed.args, content });
  for (const line of formatReport(report, content)) console.log(line);
  if (!report.apply) console.log("\nDRY RUN. Re-run with --apply to write. Nothing is ever published by this script.");
}

const invoked = (process.argv[1] ?? "").replace(/\\/g, "/");
if (/\/seed-oasis-offer-pages\.ts$/.test(invoked)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
