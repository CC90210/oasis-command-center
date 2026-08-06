/**
 * n8n automation-log ingest — the Turso repoint target for client automations.
 *
 * WHY THIS EXISTS. Four active n8n workflows (Shopify Automation, Oasis Voice
 * Agent, GrapeVine Cottage Automations, + Content Agent X) write through six
 * Supabase "Create a row" nodes, and every one targets the SAME table:
 * automation_logs in the oasis project. Rather than embedding a Turso token in
 * n8n credentials, each node becomes an HTTP Request to this endpoint — one
 * shared secret, server-side credentials, and an auditable write path.
 *
 * Migration status: automation_logs is the LAST live Supabase writer for the
 * oasis project (the SPA itself is dormant — no human login since 2026-05-22),
 * so switching these six nodes is what stops oasis drifting.
 *
 * Auth: X-Ingest-Secret must equal N8N_INGEST_SECRET. Constant-time compare.
 * The endpoint accepts ONLY automation_logs inserts — it is not a generic SQL
 * surface, and adding tables here is a deliberate edit, not a parameter.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createClient, type Client } from "@libsql/client";

export const runtime = "nodejs";

let _oasis: Client | null = null;
function oasisDb(): Client {
  if (_oasis) return _oasis;
  const url = process.env.OASIS_TURSO_DATABASE_URL;
  const token = process.env.OASIS_TURSO_AUTH_TOKEN;
  if (!url || !token) {
    throw new Error("OASIS_TURSO_DATABASE_URL / OASIS_TURSO_AUTH_TOKEN not set");
  }
  _oasis = createClient({ url, authToken: token });
  return _oasis;
}

function secretOk(provided: string | null): boolean {
  const expected = process.env.N8N_INGEST_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!secretOk(req.headers.get("x-ingest-secret"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // Required by the schema's NOT NULL columns — reject early with a message
  // n8n surfaces, rather than letting SQLite throw a constraint error.
  const required = ["automation_id", "user_id", "event_type", "event_name"] as const;
  const missing = required.filter((k) => !body[k]);
  if (missing.length) {
    return NextResponse.json(
      { ok: false, error: `missing required field(s): ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const meta = body.metadata;
  const metadata =
    meta == null ? "{}" : typeof meta === "string" ? meta : JSON.stringify(meta);

  try {
    const res = await oasisDb().execute({
      sql: `INSERT INTO "automation_logs"
              (automation_id, user_id, event_type, event_name, description,
               metadata, status, error_message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id`,
      args: [
        String(body.automation_id),
        String(body.user_id),
        String(body.event_type),
        String(body.event_name),
        body.description == null ? null : String(body.description),
        metadata,
        body.status == null ? "success" : String(body.status),
        body.error_message == null ? null : String(body.error_message),
        body.created_at == null ? new Date().toISOString() : String(body.created_at),
      ],
    });
    const id = (res.rows[0] as { id?: unknown } | undefined)?.id ?? null;
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    // Fail loud: a swallowed error here would silently lose client automation
    // history, which is the entire reason this endpoint exists.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[ingest/automation-log] insert failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
