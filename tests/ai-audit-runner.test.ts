/**
 * tests/ai-audit-runner.test.ts — the Mac's side of a Free AI Audit's PDF
 * (system runner tool ai_audit_pdf), through the REAL signed runner routes
 * (lib/tools/runner-handlers.ts) against bravo__206, bravo__237 and bravo__238.
 *
 * Pins (review of PR #732: these routes had no test):
 *   - the Mac signs as producer "mac" with its own key; the claim hands it a
 *     render address signed for fifteen minutes, which verifies, and the job
 *     row never holds a usable address;
 *   - without AI_AUDIT_LINK_SECRET the claim ends the job "not_configured"
 *     instead of handing out an address nobody can open;
 *   - complete stores the PDF and stamps the version only for a real PDF whose
 *     bytes match the reported hash; a mismatch is refused (422) and nothing
 *     is stamped.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-runner.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerOf, check, finish, setupToolsDatabase, signedRequest } from "./_tools-harness";
import { OASIS } from "./_delivery-harness";

const MAC_SECRET = "mac-runner-test-secret-0123456789abcdefghij";
const LINK_SECRET = "link-secret-for-tests-0123456789abcdefghij";
const BASE = "https://oasisai.work";

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

async function main() {
  console.log("ai-audit runner:");
  const db = await setupToolsDatabase();
  for (const f of ["bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(process.cwd(), "database", "turso", f), "utf8"))) await db.execute(stmt);
  }
  const h = await import("../lib/tools/runner-handlers");
  const pdf = await import("../lib/ai-audit/pdf");
  const link = await import("../lib/ai-audit/link");

  const now = new Date();
  const at = now.toISOString();
  await db.execute({
    sql: "INSERT INTO ai_audit_engagements (id, tenant_id, lead_id, stage, created_at, updated_at) VALUES ('eng-r', ?, 'lead-r', 'final_review', ?, ?)",
    args: [OASIS, at, at],
  });
  const contentSha = "d".repeat(64);
  await db.execute({
    sql: "INSERT INTO ai_audit_versions (id, tenant_id, engagement_id, version_no, status, content, content_sha256, created_at, updated_at) VALUES ('ver-r', ?, 'eng-r', 1, 'awaiting_approval', '{}', ?, ?, ?)",
    args: [OASIS, contentSha, at, at],
  });

  const env = { TOOLS_RUNNER_SECRET_MAC: MAC_SECRET };
  const store = new Map<string, Uint8Array>();
  const storage = { upload: async (p: string, b: Uint8Array) => (store.set(p, b), { ok: true as const }), download: async (p: string) => store.get(p) ?? null };
  const deps = (over: Record<string, unknown> = {}) => ({ db, env, now, storage: null, aiAuditPdfStorage: storage, aiAuditLinkSecret: LINK_SECRET, aiAuditBaseUrl: BASE, ...over });
  const claimBody = { runner_id: "oasis-mac-audit", label: "CC's Mac", version: "1.0.0", tools: ["ai_audit_pdf"] };
  const claim = (over: Record<string, unknown> = {}) => h.handleToolsClaim(signedRequest("claim", claimBody, now, { producer: "mac", secret: MAC_SECRET }), deps(over) as never);

  await check("the claim hands the Mac a fifteen-minute signed print address; the job row holds none", async () => {
    assert.ok(await pdf.queuePdfJob(db, { tenantId: OASIS, engagementId: "eng-r", auditVersionId: "ver-r", contentSha256: contentSha, now }));
    const { status, body } = await answerOf(await claim());
    assert.equal(status, 200);
    const job = body.job as { job_id: string; lease_id: string; tool_key: string; input: { render_url: string; audit_version_id: string } };
    assert.equal(job.tool_key, "ai_audit_pdf");
    const url = new URL(job.input.render_url);
    assert.equal(url.origin, BASE);
    assert.equal(url.pathname, "/audit-print/ver-r");
    assert.ok(link.verifyRenderSignature(LINK_SECRET, { tenantId: url.searchParams.get("t"), versionId: "ver-r", exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") }, now));
    assert.ok(!link.verifyRenderSignature(LINK_SECRET, { tenantId: url.searchParams.get("t"), versionId: "ver-r", exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") }, new Date(now.getTime() + 16 * 60_000)), "expired after fifteen minutes");
    const row = await db.execute({ sql: "SELECT input_json FROM tool_jobs WHERE id = ?", args: [job.job_id] });
    assert.ok(!String(row.rows[0].input_json).includes("sig="));

    // complete: a PDF that is not the reported bytes is refused, and nothing is stamped.
    const bytes = Buffer.from("%PDF-1.7\n" + "x".repeat(600) + "\n%%EOF");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const report = { job_id: job.job_id, lease_id: job.lease_id, runner_id: "oasis-mac-audit", tool_key: "ai_audit_pdf", pdf_base64: bytes.toString("base64"), sha256: sha, bytes: bytes.length, pages: 4 };
    const bad = await answerOf(await h.handleToolsComplete(signedRequest("complete", { ...report, sha256: "0".repeat(64) }, now, { producer: "mac", secret: MAC_SECRET }), deps() as never));
    assert.equal(bad.status, 422);
    assert.equal(String((await db.execute("SELECT COALESCE(pdf_sha256, '') AS s FROM ai_audit_versions WHERE id = 'ver-r'")).rows[0].s), "");
    // The real PDF is stored and stamped.
    const good = await answerOf(await h.handleToolsComplete(signedRequest("complete", report, now, { producer: "mac", secret: MAC_SECRET }), deps() as never));
    assert.equal(good.status, 200);
    assert.equal(good.body.stored, true);
    const v = (await db.execute("SELECT pdf_sha256, pdf_pages, pdf_path FROM ai_audit_versions WHERE id = 'ver-r'")).rows[0];
    assert.equal(String(v.pdf_sha256), sha);
    assert.equal(Number(v.pdf_pages), 4);
    assert.ok(store.has(String(v.pdf_path)), "the bytes are in the private store");
  });

  await check("without the link secret the claim ends the job instead of handing out an address nobody can open", async () => {
    await db.execute({
      sql: "INSERT INTO ai_audit_versions (id, tenant_id, engagement_id, version_no, status, content, content_sha256, created_at, updated_at) VALUES ('ver-s', ?, 'eng-r', 2, 'awaiting_approval', '{}', ?, ?, ?)",
      args: [OASIS, "e".repeat(64), at, at],
    });
    assert.ok(await pdf.queuePdfJob(db, { tenantId: OASIS, engagementId: "eng-r", auditVersionId: "ver-s", contentSha256: "e".repeat(64), now }));
    const { status, body } = await answerOf(await claim({ aiAuditLinkSecret: null }));
    assert.equal(status, 200);
    assert.equal(body.job, null);
    const row = (await db.execute("SELECT status, error_code FROM tool_jobs WHERE dedupe_key = 'ai_audit_pdf:ver-s'")).rows[0];
    assert.deepEqual([String(row.status), String(row.error_code)], ["failed", "not_configured"]);
  });

  await check("a request signed with the PC's key cannot claim as the Mac", async () => {
    const res = await h.handleToolsClaim(signedRequest("claim", claimBody, now, { producer: "mac", secret: "tools-runner-test-secret-0123456789abcdef" }), deps() as never);
    assert.equal(res.status, 401);
  });

  finish("ai-audit-runner");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
