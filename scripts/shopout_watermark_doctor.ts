#!/usr/bin/env node
/**
 * shopout_watermark_doctor.ts — say exactly WHY shop-out refuses to watermark.
 *
 * Shop-out prefers branded statements but falls back to verified clean originals
 * when branding fails. This doctor explains why a document degraded so an
 * operator can distinguish a bad upload from an encrypted PDF or broken deploy.
 *
 * This runs the SAME resolution the guard runs — same lookup, same doc_type
 * filter, same renderer — and prints a per-document verdict.
 *
 * READ-ONLY. It downloads and brands in memory to prove the render works; it
 * never uploads a copy, never stamps metadata, never touches a lender thread.
 * (Note the real guard DOES persist its copy; this deliberately does not, so
 * running the doctor can't mask a problem by fixing it half-way.)
 *
 * A tenant is REQUIRED. This runs under the service role, which bypasses RLS,
 * so every lookup here is explicitly tenant-scoped exactly like the app's own
 * queries — a diagnostic must not be the one thing that can read another
 * tenant's statements.
 *
 * Run from the REPO ROOT (--conditions is required by the server-only watermark
 * module; --env-file supplies the Supabase service credentials).
 *
 * Easiest: check the deals most recently shopped out, no UUID needed.
 *
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/shopout_watermark_doctor.ts --tenant-slug submissions --recent
 *
 * Target one specific thing (substitute a real UUID; note there are no angle
 * brackets — in PowerShell a bare `<` is a reserved redirection operator and
 * pasting a placeholder fails before node ever starts):
 *
 *   ... --tenant-slug submissions --application 1234abcd-...
 *   ... --tenant-slug submissions --lead 1234abcd-...
 *   ... --tenant-slug submissions --doc 1234abcd-...
 *
 * `--tenant <uuid>` works in place of `--tenant-slug`. `--recent 5` widens the
 * sweep (default 3, max 20).
 *
 * Prints no merchant names, no PII, no file contents — ids, types, sizes and
 * failure reasons only, so the output is safe to paste into chat.
 */
import { getServiceSupabase } from "../lib/supabase-server";
import { watermarkBankStatement } from "../lib/forms/watermark";

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const APPLICATION_ID = argOf("--application");
const LEAD_ID = argOf("--lead");
const DOC_ID = argOf("--doc");
const TENANT_ID = argOf("--tenant");
const TENANT_SLUG = argOf("--tenant-slug");
// --recent [n] checks the most recently shopped deals so nobody has to go
// hunting for a UUID first. Bare `--recent` defaults to 3.
const RECENT = process.argv.includes("--recent")
  ? Math.max(1, Math.min(20, Number(argOf("--recent")) || 3))
  : 0;

type DocRow = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  storage_path: string;
  doc_type: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown> | null;
};

const SELECT = "id, tenant_id, lead_id, storage_path, doc_type, mime_type, size_bytes, metadata";

/** Compact, PII-free label for a document. */
const label = (d: DocRow) =>
  `${d.id.slice(0, 8)} [${d.doc_type || "untyped"}] ${d.mime_type || "no-mime"} ${
    d.size_bytes ? `${Math.round(d.size_bytes / 1024)}KB` : "size?"
  }`;

type Db = ReturnType<typeof getServiceSupabase>;

/** Application -> its linked lead. Returns null (with a printed reason) if unresolvable. */
async function leadIdForApplication(
  db: Db,
  tenantId: string,
  applicationId: string,
): Promise<string | null> {
  const app = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (app.error) {
    console.error(`application lookup FAILED: ${app.error.message}`);
    return null;
  }
  if (!app.data) {
    console.error(`no application ${applicationId} in this tenant`);
    return null;
  }
  const appData = ((app.data as { data?: Record<string, unknown> }).data) || {};
  const linked = typeof appData.lead_id === "string" ? appData.lead_id : null;
  if (!linked) {
    console.error(
      `application ${applicationId} has no data.lead_id — its documents cannot be resolved. Pass --lead <uuid> directly.`,
    );
    return null;
  }
  return linked;
}

/**
 * The applications most recently shopped out, newest first. Driven off
 * application_lender_threads rather than the records table because "the deal I
 * just tried to send" is exactly what someone running this wants to inspect.
 */
async function recentlyShoppedApplications(
  db: Db,
  tenantId: string,
  limit: number,
): Promise<string[]> {
  const r = await db
    .from("application_lender_threads")
    .select("application_id, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit * 25); // many threads per shop-out; dedupe below
  if (r.error) {
    console.error(`recent-thread lookup FAILED: ${r.error.message}`);
    return [];
  }
  const seen: string[] = [];
  for (const row of (r.data || []) as Array<{ application_id: string | null }>) {
    const id = row.application_id;
    if (id && !seen.includes(id)) seen.push(id);
    if (seen.length >= limit) break;
  }
  return seen;
}

async function main() {
  if (!APPLICATION_ID && !LEAD_ID && !DOC_ID && !RECENT) {
    console.error(
      "Usage: --tenant-slug <slug>|--tenant <uuid>  (--recent [n] | --application <uuid> | --lead <uuid> | --doc <uuid>)",
    );
    process.exit(2);
  }
  if (!TENANT_ID && !TENANT_SLUG) {
    console.error("Refusing to run without a tenant: pass --tenant-slug <slug> or --tenant <uuid>.");
    console.error(
      "This runs under the service role, which bypasses RLS — an unscoped lookup could read another tenant's statements.",
    );
    process.exit(2);
  }
  const db = getServiceSupabase();

  // Resolve the tenant ONCE; every query below is filtered by it.
  let tenantId = TENANT_ID;
  if (!tenantId) {
    const t = await db.from("tenants").select("id").eq("slug", TENANT_SLUG!).maybeSingle();
    if (t.error) {
      console.error(`tenant lookup FAILED: ${t.error.message}`);
      process.exit(1);
    }
    if (!t.data) {
      console.error(`no tenant with slug "${TENANT_SLUG}"`);
      process.exit(1);
    }
    tenantId = (t.data as { id: string }).id;
  }

  // ── Resolve the document set the same way shop-out would.
  let docs: DocRow[] = [];
  if (DOC_ID) {
    const r = await db
      .from("lead_documents")
      .select(SELECT)
      .eq("id", DOC_ID)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (r.error) {
      console.error(`document lookup FAILED: ${r.error.message}`);
      process.exit(1);
    }
    if (!r.data) {
      console.error(`no lead_documents row with id ${DOC_ID} in this tenant`);
      process.exit(1);
    }
    docs = [r.data as DocRow];
  } else {
    // Documents hang off the LEAD. An application is a separate tenant_records
    // row that points at its lead via data.lead_id (see
    // lib/applications/create-from-lead.ts: "application_id -> lead_id ->
    // lead_documents"), so an application id must be dereferenced first —
    // querying lead_documents by the application's own id finds nothing and
    // would look exactly like "this deal has no statements".
    const leadIds: string[] = [];
    if (LEAD_ID) {
      leadIds.push(LEAD_ID);
    } else if (APPLICATION_ID) {
      const lid = await leadIdForApplication(db, tenantId, APPLICATION_ID);
      if (!lid) process.exit(1);
      console.log(`application ${APPLICATION_ID.slice(0, 8)} -> lead ${lid.slice(0, 8)}`);
      leadIds.push(lid);
    } else {
      const apps = await recentlyShoppedApplications(db, tenantId, RECENT);
      if (apps.length === 0) {
        console.log("No shopped applications found for this tenant — nothing recent to check.");
        console.log("Pass --application <uuid> or --lead <uuid> to target one directly.");
        return;
      }
      console.log(`${apps.length} most recently shopped application(s):\n`);
      for (const appId of apps) {
        const lid = await leadIdForApplication(db, tenantId, appId);
        if (!lid) continue;
        console.log(`application ${appId.slice(0, 8)} -> lead ${lid.slice(0, 8)}`);
        leadIds.push(lid);
      }
      if (leadIds.length === 0) process.exit(1);
    }

    const r = await db
      .from("lead_documents")
      .select(SELECT)
      .eq("tenant_id", tenantId)
      .in("lead_id", leadIds)
      .is("metadata->>deleted_at", null);
    if (r.error) {
      console.error(`document lookup FAILED: ${r.error.message}`);
      console.error("  ^ this is a DATABASE problem, not a document problem.");
      process.exit(1);
    }
    docs = (r.data || []) as DocRow[];
  }

  if (docs.length === 0) {
    console.log("No documents found for that id.");
    console.log("If shop-out reported 'unresolved_attachment_no_lead_document', this is why:");
    console.log("the attachment isn't backed by a lead_documents row this tenant owns.");
    return;
  }

  const statements = docs.filter((d) => d.doc_type === "bank_statements_3mo");
  console.log(`${docs.length} document(s); ${statements.length} classified as bank statements.`);
  console.log(
    "Only bank_statements_3mo are watermarked — anything else passes through clean.\n",
  );

  // A statement misclassified as another doc_type is silently NOT branded, and a
  // non-statement misclassified AS one gets pushed through the renderer. Both
  // are worth seeing.
  for (const d of docs.filter((x) => x.doc_type !== "bank_statements_3mo")) {
    console.log(`SKIP  ${label(d)} — not a bank statement, sent as-is`);
  }

  let failed = 0;
  for (const d of statements) {
    const meta = d.metadata || {};
    const stamped = meta.shopout_wm_path
      ? `wm_copy=v${String(meta.shopout_wm_version)}${meta.shopout_wm_raster ? " raster" : " overlay"}`
      : "no wm_copy yet";

    const dl = await db.storage.from("lead-documents").download(d.storage_path);
    if (dl.error || !dl.data) {
      failed++;
      console.log(`FAIL  ${label(d)} — download_failed: ${dl.error?.message || "no data"}`);
      console.log(`        the stored object is missing/unreadable; re-upload the statement.`);
      continue;
    }
    const bytes = Buffer.from(await dl.data.arrayBuffer());

    const t0 = Date.now();
    const wm = await watermarkBankStatement({
      bytes,
      mimeType: d.mime_type || "application/pdf",
      // Provenance text does not affect success/failure; keep merchant data out.
      provenance: { businessName: null, leadId: d.lead_id, date: null },
    });
    const ms = Date.now() - t0;

    if (wm.ok) {
      console.log(
        `OK    ${label(d)} — branded in ${ms}ms, ${wm.pages ?? "?"} page(s), ${
          wm.raster ? "RASTER (flattened)" : "overlay (lossless)"
        }, ${stamped}`,
      );
    } else {
      failed++;
      console.log(`FAIL  ${label(d)} — ${wm.error}`);
      console.log(`        ${explain(wm.error)}`);
    }
  }

  console.log("");
  if (failed === 0) {
    console.log("All statements brand cleanly here. If shop-out still refuses, the failure is");
    console.log("environmental (the deployed function is missing pdfjs assets / the logo) rather");
    console.log("than the documents — compare against the same check run on Vercel.");
  } else {
    console.log(`${failed} statement(s) cannot be branded. Shop-out will refuse until each is fixed.`);
    process.exitCode = 1;
  }
}

/** Operator-facing next step for a raw renderer error. */
function explain(error: string): string {
  const s = error.toLowerCase();
  if (s.includes("encrypted"))
    return "password/permission-protected PDF the overlay can't touch AND the raster fallback couldn't decrypt — re-save it as a plain PDF and re-upload.";
  if (s.includes("too_many_pages"))
    return "over the 50-page cap; split the statement and re-upload (it is never silently truncated).";
  if (s.includes("page_too_large")) return "a page exceeds the pixel ceiling; re-export it at a lower resolution.";
  if (s.includes("dommatrix") || s.includes("canvas_unavailable"))
    return "the canvas/pdfjs runtime is unavailable — a DEPLOY problem. Check next.config.js outputFileTracingIncludes covers this route.";
  if (s.includes("unsupported_type")) return "file type can't be branded; re-upload as PDF or a standard image.";
  if (s.includes("empty_file")) return "the stored object is 0 bytes; re-upload.";
  if (s.includes("image_dims_unknown")) return "the image is unreadable/corrupt; re-upload.";
  return "unexpected renderer failure — capture this line and the doc id.";
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
