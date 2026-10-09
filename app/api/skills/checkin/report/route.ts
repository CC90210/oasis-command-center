/** POST /api/skills/checkin/report - per-change outcomes, prunes and the live labels mirror. No prompt text. */
import { json } from "@/lib/playbook/http";
import { parseReport } from "@/lib/skills/contract";
import { authenticateComputer, readBoundedJson } from "@/lib/skills/machine-auth";
import { recordReport, skillsDb } from "@/lib/skills/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const db = skillsDb();
  if (!db) return json({ ok: false, error: "storage_not_ready" }, 503);
  const auth = await authenticateComputer(req, db);
  if (!auth.ok) return auth.response;
  const body = await readBoundedJson(req);
  if (!body.ok) return body.response;
  const report = parseReport(body.body);
  if (!report.ok) return json({ ok: false, error: "bad_request", message: report.error }, 400);
  return json({ ok: true, ...(await recordReport(db, auth.computer.id, report.value)) });
}
