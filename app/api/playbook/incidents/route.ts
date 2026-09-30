/**
 * /api/playbook/incidents - the Law 25 s.3.8 register of confidentiality
 * incidents (privacy_incidents, bravo__194). Founders only.
 *
 * GET   every entry, newest first.
 * POST  append one entry (validated by lib/playbook/incidents.ts). There is
 *       deliberately NO update and NO delete route: the register is
 *       append-only (the table's triggers refuse both), and a correction is a
 *       new entry with `corrects_id` naming the one it corrects.
 *
 * Tenant: OASIS's documents tenant, from the session (lib/playbook/viewer.ts).
 * A non-founder, or anyone outside OASIS, gets the 404 the rest of the hub
 * gives: the register's existence is not confirmed to them.
 */
import { docsDb } from "@/lib/playbook/documents";
import { crossOrigin, json, notFoundJson, readJsonObject, requireDocsViewer, sameOrigin, STORAGE_NOT_READY } from "@/lib/playbook/http";
import { parseIncident } from "@/lib/playbook/incidents";
import { appendIncident, listIncidents } from "@/lib/playbook/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  if (!who.viewer.founder) return notFoundJson();
  const db = docsDb();
  if (!db) return json({ ok: false, error: "storage_unavailable" }, 503);
  const read = await listIncidents(db, who.viewer.tenantId);
  if (!read.ok) {
    return read.reason === "table_missing"
      ? json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503)
      : json({ ok: false, error: "storage_unavailable", message: "The register could not be read just now." }, 503);
  }
  return json({ ok: true, incidents: read.value });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return crossOrigin();
  const who = await requireDocsViewer();
  if (!who.ok) return who.response;
  if (!who.viewer.founder) return notFoundJson();
  const body = await readJsonObject(req, 64_000);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);
  const parsed = parseIncident(body);
  if (!parsed.ok) return json({ ok: false, error: "invalid_field", field: parsed.field }, 400);
  const db = docsDb();
  if (!db) return json({ ok: false, error: "storage_unavailable" }, 503);
  const result = await appendIncident(db, {
    tenantId: who.viewer.tenantId,
    entry: parsed.entry,
    actor: who.viewer.actor,
    now: new Date().toISOString(),
  });
  if (result.ok) return json({ ok: true, id: result.id }, 201);
  if (result.reason === "unknown_correction") return json({ ok: false, error: "invalid_field", field: "corrects_id" }, 400);
  return json({ ok: false, error: "storage_not_ready", message: STORAGE_NOT_READY }, 503);
}
