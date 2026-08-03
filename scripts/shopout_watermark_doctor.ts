#!/usr/bin/env node
/**
 * shopout_watermark_doctor.ts — say exactly WHY shop-out refuses to watermark.
 *
 * The shop-out door guard fails closed: if any bank statement can't be branded,
 * the whole send is refused with `bank_statement_watermark_failed`. That is the
 * correct behaviour, but the reason lived only in the API response body, so the
 * operator-visible symptom collapsed to "it can't watermark it" with no way to
 * tell an un-uploaded file from an encrypted PDF from a broken deploy.
 *
 * This runs the SAME resolution the guard runs — same lookup, same doc_type
 * filter, same renderer — and prints a per-document verdict.
 *
 * READ-ONLY. It downloads and brands in memory to prove the render works; it
 * never uploads a copy, never stamps metadata, never touches a lender thread.
 * (Note the real guard DOES persist its copy; this deliberately does not, so
 * running the doctor can't mask a problem by fixing it half-way.)
 *
 * Run (from the repo root; --conditions is required by the server-only module):
 *   node --conditions=react-server --env-file=.env.local --import tsx \
 *     scripts/shopout_watermark_doctor.ts --application <application-uuid>
 *
 *   # or sweep every statement on a lead
 *   node --conditions=react-server --env-file=.env.local --import tsx \
 *     scripts/shopout_watermark_doctor.ts --lead <lead-uuid>
 *
 *   # or check one document directly
 *   node --conditions=react-server --env-file=.env.local --import tsx \
 *     scripts/shopout_watermark_doctor.ts --doc <lead-document-uuid>
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

async function main() {
  if (!APPLICATION_ID && !LEAD_ID && !DOC_ID) {
    console.error("Usage: --application <uuid> | --lead <uuid> | --doc <uuid>");
    process.exit(2);
  }
  const db = getServiceSupabase();

  // ── Resolve the document set the same way shop-out would.
  let docs: DocRow[] = [];
  if (DOC_ID) {
    const r = await db.from("lead_documents").select(SELECT).eq("id", DOC_ID).maybeSingle();
    if (r.error) {
      console.error(`document lookup FAILED: ${r.error.message}`);
      process.exit(1);
    }
    if (!r.data) {
      console.error(`no lead_documents row with id ${DOC_ID}`);
      process.exit(1);
    }
    docs = [r.data as DocRow];
  } else {
    // An application's statements hang off its lead_id. Applications are
    // tenant_records rows; the documents are keyed by the same record id.
    const parentId = LEAD_ID || APPLICATION_ID!;
    const r = await db
      .from("lead_documents")
      .select(SELECT)
      .eq("lead_id", parentId)
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
