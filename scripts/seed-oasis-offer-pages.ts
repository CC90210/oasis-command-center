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
 * means nothing is written at all. A content file never carries an owner's
 * sign-off (a price's confirmation, a video's rights tick...): those are the
 * server's stamp when an owner ticks them in the builder.
 *
 * REFRESH (--refresh-drafts): loads NEW copy into drafts that already exist,
 * for the five pages above plus the page-only files (<slug>.page.json, a bare
 * page for a form this content must never redefine: OASIS_PAGE_ONLY_SLUGS).
 * It never creates, changes or switches on a form, never publishes, and
 * overwrites a draft only when the page is not live, was never published and
 * no person ever saved it ("refreshed"). A draft a person saved is reported
 * with what differs ("edited_left") unless its slug is named with
 * --include-edited <slug> ("refreshed_edited"); a live or once-published page
 * is never touched ("published_left"). Each write is the builder's own
 * saveDraft, compare-and-swap on the version just read (with the same
 * conditions in the statement), so a concurrent save or publish makes it a
 * "conflict", never an overwrite. The owner's claim ticks are cleared on a
 * refreshed draft: the copy they vouched for was replaced. So is every
 * confirmation inside the replaced draft (a price's, the guarantee's, a bonus
 * value's, a result's, a video's rights) that the content does not carry. Each
 * page's report states how many owner sign-offs that is, and which (who stamped
 * each, and when): "owner ticks that would be cleared: N" in a dry run, "owner
 * ticks cleared: N" after an apply. See signOffsCleared.
 *
 * Run from the repo root (credentials in the environment, never in argv):
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --dry-run
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --apply
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --refresh-drafts --dry-run
 *   node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug oasis-ai-cc --refresh-drafts --apply [--include-edited <slug>]...
 * --tenant-slug oasis-ai-cc and exactly one of --dry-run / --apply are required;
 * anything else is refused before the database is opened.
 *
 * REQUIRES migration bravo__203 (form_offer_pages) and Turso credentials
 * (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or TURSO_DB_PATH for a local file).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import { createOfferRow, isMissingOfferTable, readOfferRow, saveDraft } from "../lib/offer-pages/store";
import { confirmationsNotCarried, lintDoc, type ClaimHit, type ClaimTick } from "../lib/offer-pages/claims";

/** The only workspace this content belongs to. */
export const OASIS_TENANT_SLUG = "oasis-ai-cc";

/** The files, in the order they are seeded and reported. */
export const OASIS_OFFER_SLUGS = ["vsl", "protocol", "command", "community", "fleet"] as const;

/**
 * Pages with no form block: content/offers/oasis/<slug>.page.json holds ONLY
 * the page (an OfferPageDoc), for a form this content must never redefine. The
 * create path never reads them; only --refresh-drafts does. The AI Automation
 * Audit is live with real leads and keeps its own form and steps (owner
 * decision 2026-10-16).
 */
export const OASIS_PAGE_ONLY_SLUGS = ["ai-audit"] as const;

/** Every page a refresh can write, and so every value --include-edited accepts. */
export const OASIS_REFRESH_SLUGS: readonly string[] = [...OASIS_OFFER_SLUGS, ...OASIS_PAGE_ONLY_SLUGS];

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

/**
 * A content file never carries an owner's sign-off: a price's or the
 * guarantee's `confirmed`, a bonus value's or a result's (the parser requires
 * one on both), or a video's `rights`. The server stamps those when an owner
 * ticks them in the builder; one written into a copy file would go on record
 * as an owner's word, and stampConfirmations would keep it on every save.
 */
function assertNoSignOffs(doc: OfferPageDoc, file: string, root: string): void {
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "confirmed" || k === "rights") && x != null) {
          throw new ContentError(file, `${path}.${k}: a content file never carries an owner's sign-off (an owner ticks it in the builder)`);
        }
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(doc, root);
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
  assertNoSignOffs(doc, file, "offer_page");

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

/**
 * One content file as JSON. A file that cannot be read or is not JSON is a ContentError ("unreadable"); with
 * `missingIsNull` an absent file is null instead (a page-only file that has not been written yet).
 */
function readContentJson(file: string, opts: { missingIsNull?: boolean } = {}): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (opts.missingIsNull && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ContentError(file, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ContentError(file, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every content file, all parsed before any is used. Throws on the first bad one. */
export function loadOasisOfferContent(dir: string = resolve(process.cwd(), "content", "offers", "oasis")): OfferContent[] {
  return OASIS_OFFER_SLUGS.map((slug) => {
    const file = join(dir, `${slug}.json`);
    const content = parseOfferContent(readContentJson(file), file);
    if (content.slug !== slug) throw new ContentError(file, `slug must be "${slug}" (the file name)`);
    return content;
  });
}

/** A page-only file: the page, or null while there is no file yet (a refresh reports "no_content"). */
export type PageOnlyContent = { slug: string; file: string; doc: OfferPageDoc | null };

/** Every page-only file (<slug>.page.json), all parsed before any is used. An absent file is fine; a bad one throws. */
export function loadOasisPageOnlyContent(dir: string = resolve(process.cwd(), "content", "offers", "oasis")): PageOnlyContent[] {
  return OASIS_PAGE_ONLY_SLUGS.map((slug) => {
    const file = join(dir, `${slug}.page.json`);
    const raw = readContentJson(file, { missingIsNull: true });
    if (raw === null) return { slug, file, doc: null };
    let doc: OfferPageDoc;
    try {
      // The page alone: a form block, a slug or any other key is refused by the parser.
      doc = parseOfferPageDoc(raw);
    } catch (err) {
      throw new ContentError(file, err instanceof Error ? err.message : String(err));
    }
    assertNoSignOffs(doc, file, "$");
    return { slug, file, doc };
  });
}

export type Args = { tenantSlug: string; apply: boolean; refresh: boolean; includeEdited: string[] };

/**
 * The command line. Refuses unless --tenant-slug oasis-ai-cc and exactly one
 * of --dry-run / --apply are given. --include-edited <slug> (repeatable) only
 * goes with --refresh-drafts and only names a page a refresh can write.
 */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  let tenantSlug: string | null = null;
  let dryRun = false;
  let apply = false;
  let refresh = false;
  const includeEdited: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--apply") apply = true;
    else if (a === "--refresh-drafts") refresh = true;
    else if (a === "--include-edited" || a.startsWith("--include-edited=")) {
      let v: string | undefined;
      if (a === "--include-edited") {
        v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) return { ok: false, error: "--include-edited needs a page slug" };
        i++;
      } else v = a.slice("--include-edited=".length);
      if (!OASIS_REFRESH_SLUGS.includes(v)) {
        return { ok: false, error: `--include-edited "${v}" is not one of the pages: ${OASIS_REFRESH_SLUGS.join(", ")}` };
      }
      if (!includeEdited.includes(v)) includeEdited.push(v);
    } else if (a === "--tenant-slug") {
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
  if (includeEdited.length && !refresh) return { ok: false, error: "--include-edited only goes with --refresh-drafts" };
  return { ok: true, args: { tenantSlug, apply, refresh, includeEdited } };
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

async function assertOfferTable(db: Client): Promise<void> {
  try {
    await db.execute("SELECT 1 FROM form_offer_pages LIMIT 1");
  } catch (err) {
    if (isMissingOfferTable(err)) throw new Error("form_offer_pages is missing: apply migration bravo__203 first");
    throw err;
  }
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
  // A page-only slug's form belongs to someone else (the live AI Automation Audit): never create or resume it.
  const pageOnly = input.content.find((c) => (OASIS_PAGE_ONLY_SLUGS as readonly string[]).includes(c.slug));
  if (pageOnly) throw new Error(`refusing: "${pageOnly.slug}" is a page-only slug; its form is never created or changed`);
  const tenantId = await resolveTenantId(db, input.tenantSlug);
  const now = input.now ?? new Date().toISOString();
  await assertOfferTable(db);

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

// ---------------------------------------------------------------------------
// --refresh-drafts
// ---------------------------------------------------------------------------

export type RefreshOutcome =
  | "refreshed" // the draft now holds the content
  | "would_refresh" // dry run: it would
  | "refreshed_edited" // a person's saved draft replaced, because --include-edited named it
  | "would_refresh_edited" // dry run: it would
  | "unchanged" // the draft already equals the content
  | "edited_left" // a person saved it: never overwritten without --include-edited
  | "published_left" // live, or published at some point: never overwritten
  | "template_differs" // the page was made with another template, which a save never changes (the builder's rule)
  | "conflict" // the row changed between the read and the write: nothing written
  | "no_form" // no form with this slug in the workspace
  | "no_page" // the form has no offer page
  | "no_content"; // a page-only file not written yet

export type RefreshPageReport = {
  slug: string;
  pageOnly: boolean;
  formId: string | null;
  outcome: RefreshOutcome;
  /** The draft version read (null with no page). A refresh that writes makes it version + 1. */
  version: number | null;
  /** Who last saved the draft (a person's id) and when; null when no person did. */
  editedBy: string | null;
  editedAt: string | null;
  /** Top-level parts of the stored draft that differ from the content: what a refresh replaces, or what a person merges. */
  differences: string[];
  /** Owner sign-offs on the stored draft that writing this page's content over it removes (signOffsCleared); ticks is their count. */
  signOffs: SignOff[];
  ticks: number;
  /** The stored draft does not parse, so the confirmations inside it could not be listed: signOffs holds the claim ticks only. */
  draftUnreadable: boolean;
  /** Sentences in the content the claims linter flags (each needs an owner's tick before publish). */
  hits: number;
  detail: string | null;
};

export type RefreshReport = { tenantId: string; apply: boolean; includeEdited: string[]; pages: RefreshPageReport[] };

/** Plain JSON (undefined keys gone), so two docs compare by content, not by how they were built. */
function plain(v: unknown): unknown {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function sameContent(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(plain(a), plain(b));
}

/**
 * The claim ticks a refresh saves with: none. The write below passes this very
 * list to saveDraft, and signOffsCleared counts against it, so what is reported
 * and what is written cannot drift apart.
 */
const REFRESH_CLAIM_TICKS: readonly ClaimTick[] = Object.freeze([]);

/** One owner sign-off a refresh removes: who stamped it and when are the stored values. */
export type SignOff = {
  /** "claim" (a ticked sentence), or the confirmation's kind: price, guarantee, money, evidence, rights. */
  kind: string;
  /** What it vouches for, in words (a ticked claim's sentence, or where on the page the confirmation sits). */
  label: string;
  by: string;
  at: string;
};

/**
 * Every owner sign-off on the stored page that writing `written` over it
 * removes. Two kinds, each judged by the rule that decides what survives:
 *   - confirmations inside the draft (a price tier's, the guarantee's, a bonus
 *     value's, a result's evidence, a video's rights): those the written draft
 *     does not hold with the same content and the same stamp, as
 *     stampConfirmations decides (claims.ts confirmationsNotCarried). The
 *     refresh writes the content as it is, with no stamping, so none survive
 *     unless the content itself carried them;
 *   - claim ticks (row.claims, by the sentence's hash): those the written ticks
 *     do not carry. REFRESH_CLAIM_TICKS is empty, so all go.
 * An unreadable stored draft has no confirmations to list (the caller says so).
 */
export function signOffsCleared(
  stored: { draft: OfferPageDoc | null; claims: ClaimTick[] },
  written: { draft: OfferPageDoc; claims: readonly ClaimTick[] },
): SignOff[] {
  const out: SignOff[] = [];
  if (stored.draft) {
    for (const h of confirmationsNotCarried(stored.draft, written.draft)) out.push({ kind: h.kind, label: h.label, by: h.by, at: h.at });
  }
  const carried = new Set(written.claims.map((t) => t.hash));
  for (const t of stored.claims) {
    if (carried.has(t.hash)) continue;
    out.push({ kind: "claim", label: `${t.excerpt ? `"${t.excerpt}" ` : ""}[${t.hash.slice(0, 8)}]`, by: t.by, at: t.at });
  }
  return out;
}

/**
 * What differs between the stored draft and the content, at the top level:
 * the template, theme and menu, each hero field, each section (by key, and
 * their order), the Book section, search settings and the brief.
 */
export function topLevelDifferences(stored: OfferPageDoc | null, next: OfferPageDoc): string[] {
  if (!stored) return ["the whole draft (the stored copy no longer parses)"];
  const out: string[] = [];
  for (const k of ["template", "theme", "nav"] as const) if (!sameContent(stored[k], next[k])) out.push(k);
  const sh = stored.hero as Record<string, unknown>;
  const nh = next.hero as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(sh), ...Object.keys(nh)])].sort()) {
    if (!sameContent(sh[k], nh[k])) out.push(`hero.${k}`);
  }
  const storedKeys = stored.sections.map((s) => s.key as string);
  const nextKeys = next.sections.map((s) => s.key as string);
  for (const k of [...new Set([...storedKeys, ...nextKeys])]) {
    const a = stored.sections.find((s) => s.key === k);
    const b = next.sections.find((s) => s.key === k);
    if (!a) out.push(`sections.${k} (only in the content)`);
    else if (!b) out.push(`sections.${k} (only in the stored draft)`);
    else if (!sameContent(a, b)) out.push(`sections.${k}`);
  }
  if (!sameContent(storedKeys.filter((k) => nextKeys.includes(k)), nextKeys.filter((k) => storedKeys.includes(k)))) {
    out.push("sections (order)");
  }
  for (const k of ["book", "seo", "brief"] as const) if (!sameContent(stored[k], next[k])) out.push(k);
  return out;
}

/**
 * Load the content into the drafts that already exist (see the header,
 * REFRESH). With apply = false it reads only. Never creates or changes a form,
 * never publishes, never switches anything on; writes only through saveDraft,
 * compare-and-swap on the version just read.
 */
export async function refreshOasisOfferDrafts(
  db: Client,
  input: {
    tenantSlug: string;
    apply: boolean;
    content: OfferContent[];
    pageOnly: PageOnlyContent[];
    includeEdited?: string[];
    now?: string;
  },
): Promise<RefreshReport> {
  if (input.tenantSlug !== OASIS_TENANT_SLUG) throw new Error(`refusing: this content belongs to ${OASIS_TENANT_SLUG} only`);
  const targets = [
    ...input.content.map((c) => ({ slug: c.slug, pageOnly: false, doc: c.doc as OfferPageDoc | null, headline: c.form.branding.headline ?? "" })),
    ...input.pageOnly.map((p) => ({ slug: p.slug, pageOnly: true, doc: p.doc, headline: "" })),
  ];
  const slugs = targets.map((t) => t.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error("refusing: a page appears twice in the content");
  const includeEdited = [...new Set(input.includeEdited ?? [])];
  for (const s of includeEdited) {
    if (!slugs.includes(s)) throw new Error(`refusing: --include-edited "${s}" is not a page this run refreshes`);
  }
  const tenantId = await resolveTenantId(db, input.tenantSlug);
  const now = input.now ?? new Date().toISOString();
  await assertOfferTable(db);

  const pages: RefreshPageReport[] = [];
  for (const t of targets) {
    const base: RefreshPageReport = {
      slug: t.slug,
      pageOnly: t.pageOnly,
      formId: null,
      outcome: "no_content",
      version: null,
      editedBy: null,
      editedAt: null,
      differences: [],
      signOffs: [],
      ticks: 0,
      draftUnreadable: false,
      hits: t.doc ? lintDoc(t.doc, { fallbackHeadline: t.headline }).length : 0,
      detail: null,
    };
    if (!t.doc) {
      pages.push(base);
      continue;
    }
    const doc = t.doc;
    const form = await findForm(db, tenantId, t.slug);
    if (!form) {
      pages.push({ ...base, outcome: "no_form" });
      continue;
    }
    const read = await readOfferRow(db, tenantId, form.id);
    if (read.state === "unavailable") throw new Error("form_offer_pages is missing: apply migration bravo__203 first");
    if (read.state === "none") {
      pages.push({ ...base, formId: form.id, outcome: "no_page" });
      continue;
    }
    const row = read.row;
    const edited = row.draftUpdatedBy !== null;
    const signOffs = signOffsCleared({ draft: row.draft, claims: row.claims }, { draft: doc, claims: REFRESH_CLAIM_TICKS });
    const seen: RefreshPageReport = {
      ...base,
      formId: form.id,
      version: row.draftVersion,
      editedBy: row.draftUpdatedBy,
      editedAt: edited ? row.draftUpdatedAt : null,
      differences: topLevelDifferences(row.draft, doc),
      signOffs,
      ticks: signOffs.length,
      draftUnreadable: row.draft === null,
    };
    if (row.live || row.published !== null || row.publishedVersion !== 0 || row.publishedAt !== null) {
      pages.push({ ...seen, outcome: "published_left" });
      continue;
    }
    if (row.template !== doc.template) {
      pages.push({ ...seen, outcome: "template_differs", detail: `the page was made as ${row.template}, the content is ${doc.template}` });
      continue;
    }
    if (row.draft && sameContent(row.draft, doc)) {
      pages.push({ ...seen, outcome: "unchanged", differences: [] });
      continue;
    }
    if (edited && !includeEdited.includes(t.slug)) {
      pages.push({ ...seen, outcome: "edited_left" });
      continue;
    }
    if (!input.apply) {
      pages.push({ ...seen, outcome: edited ? "would_refresh_edited" : "would_refresh" });
      continue;
    }
    const saved = await saveDraft(db, {
      tenantId,
      formId: form.id,
      draft: doc,
      expectedVersion: row.draftVersion,
      claims: [...REFRESH_CLAIM_TICKS],
      actor: null,
      now,
      // The same conditions as the read, in the one statement: a page published
      // after it was read (Publish does not move the version), or saved by a
      // person when that was not asked for, is a conflict, never an overwrite.
      onlyIfUnpublished: true,
      onlyIfNoPersonSaved: !edited,
    });
    if (saved.ok) pages.push({ ...seen, outcome: edited ? "refreshed_edited" : "refreshed" });
    else if (saved.error === "conflict") {
      pages.push({
        ...seen,
        outcome: "conflict",
        detail: `the page changed after it was read (draft now version ${saved.currentVersion ?? "?"}, or it was published); nothing written`,
      });
    } else if (saved.error === "not_found") pages.push({ ...seen, outcome: "no_page" });
    else throw new Error("form_offer_pages is missing: apply migration bravo__203 first");
  }
  return { tenantId, apply: input.apply, includeEdited, pages };
}

/** The refresh report as printed lines. */
export function formatRefreshReport(report: RefreshReport): string[] {
  const out: string[] = [];
  out.push(`workspace : ${OASIS_TENANT_SLUG} (${report.tenantId})`);
  out.push(
    `mode      : ${report.apply ? "REFRESH DRAFTS, APPLY (drafts only: no form changed, nothing published or switched on)" : "REFRESH DRAFTS, DRY RUN (nothing written)"}`,
  );
  out.push(`edited pages it may replace (--include-edited): ${report.includeEdited.length ? report.includeEdited.join(", ") : "none"}`);
  for (const p of report.pages) {
    out.push("");
    out.push(`${p.slug} (/f/${OASIS_TENANT_SLUG}/${p.slug})${p.pageOnly ? ", page only: its form is never touched" : ""}`);
    out.push(`  page : ${p.outcome}${p.version !== null ? ` (draft version ${p.version} when read)` : ""}`);
    const writes = ["refreshed", "would_refresh", "refreshed_edited", "would_refresh_edited"].includes(p.outcome);
    switch (p.outcome) {
      case "no_content":
        out.push(`  no ${p.slug}.page.json yet: nothing to refresh`);
        break;
      case "no_form":
        out.push("  no form with this slug in the workspace: nothing to refresh");
        break;
      case "no_page":
        out.push("  the form has no offer page: nothing to refresh");
        break;
      case "published_left":
        out.push("  live, or published before: a refresh never overwrites it; change it in the builder");
        break;
      case "edited_left":
        out.push(`  saved by a person (${p.editedBy}, ${p.editedAt}): not overwritten`);
        out.push(`  merge by hand, or re-run with --include-edited ${p.slug} to replace it`);
        break;
      case "refreshed_edited":
      case "would_refresh_edited":
        out.push(`  saved by a person (${p.editedBy}, ${p.editedAt}): ${p.outcome === "refreshed_edited" ? "replaced" : "would be replaced"}, as --include-edited ${p.slug} asks`);
        break;
      case "unchanged":
        out.push("  the draft already holds this content");
        break;
      default:
        break;
    }
    if (p.detail) out.push(`  ${p.detail}`);
    if (p.differences.length) {
      const label =
        p.outcome === "refreshed" || p.outcome === "refreshed_edited"
          ? "replaced"
          : p.outcome === "would_refresh" || p.outcome === "would_refresh_edited"
            ? "would replace"
            : "differs from the content";
      out.push(`  ${label}: ${p.differences.join(", ")}`);
    }
    if (p.outcome === "refreshed" || p.outcome === "refreshed_edited") out.push(`  now  : draft version ${(p.version ?? 0) + 1}, still a draft`);
    out.push(...formatSignOffs(p, report.apply));
    if (writes) out.push(`  claims the linter flags (each needs an owner's tick before publish): ${p.hits}`);
  }
  return out;
}

/** A stored value as one plain ASCII line fragment: it came from a database, so anything may be in it. */
function plainText(s: string, max = 110): string {
  const t = s.replace(/[^\x20-\x7E]/g, "?");
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/**
 * The owner sign-offs a page loses, one count line for every page the report shows:
 *   apply                          "owner ticks cleared: N", N = what the write removed (0 when nothing was written)
 *   dry run, a page it would write "owner ticks that would be cleared: N"
 *   dry run, a person's edited page that --include-edited has not named
 *                                  N = what naming it would clear, with a note that this run leaves the page alone
 *   dry run, any other page        0 (nothing is written)
 * With N above 0 each sign-off is listed: what it vouches for, who stamped it, when.
 */
function formatSignOffs(p: RefreshPageReport, apply: boolean): string[] {
  const out: string[] = [];
  const wrote = p.outcome === "refreshed" || p.outcome === "refreshed_edited";
  const wouldWrite = p.outcome === "would_refresh" || p.outcome === "would_refresh_edited";
  const leftEdited = p.outcome === "edited_left";
  const n = p.signOffs.length;
  const shown = wrote || (!apply && (wouldWrite || leftEdited)) ? n : 0;
  out.push(`  ${apply ? "owner ticks cleared" : "owner ticks that would be cleared"}: ${shown}`);
  if (leftEdited && n > 0) {
    out.push(
      apply
        ? `    (the page was left alone; --include-edited ${p.slug} would have cleared ${n})`
        : `    (only if --include-edited ${p.slug} replaces this page; this run leaves it alone)`,
    );
  }
  if (shown > 0 || (leftEdited && n > 0)) {
    if (shown > 0 && !leftEdited) out.push("    (tick them again in the builder)");
    for (const s of p.signOffs) out.push(`    - ${s.kind}: ${plainText(s.label)} (stamped by ${plainText(s.by, 40)} at ${plainText(s.at, 40)})`);
  }
  if (p.draftUnreadable) out.push("    (the stored draft does not parse: confirmations inside it could not be counted)");
  return out;
}

const USAGE =
  `usage: node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug ${OASIS_TENANT_SLUG} (--dry-run | --apply)\n` +
  `       node --import tsx scripts/seed-oasis-offer-pages.ts --tenant-slug ${OASIS_TENANT_SLUG} --refresh-drafts (--dry-run | --apply) [--include-edited <slug>]...`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`REFUSED: ${parsed.error}`);
    console.error(USAGE);
    process.exit(2);
  }
  const { tenantSlug, apply, refresh, includeEdited } = parsed.args;
  // Every file is parsed before the database is opened: one bad file, nothing written.
  const content = loadOasisOfferContent();
  const pageOnly = refresh ? loadOasisPageOnlyContent() : [];
  if (!tursoConfigured()) {
    console.error("ERROR: Turso is not configured. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or TURSO_DB_PATH).");
    process.exit(2);
  }
  if (refresh) {
    const report = await refreshOasisOfferDrafts(getTursoClient(), { tenantSlug, apply, content, pageOnly, includeEdited });
    for (const line of formatRefreshReport(report)) console.log(line);
    if (!report.apply) console.log("\nDRY RUN. Re-run with --apply to write. Nothing is ever published by this script.");
    if (report.pages.some((p) => p.outcome === "conflict")) process.exitCode = 1;
    return;
  }
  const report = await seedOasisOfferPages(getTursoClient(), { tenantSlug, apply, content });
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
