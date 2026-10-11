/**
 * POST /api/automations/draft
 *
 * Phase 10.3 — operator types a plain-English description of an
 * automation, Claude returns a draft Python script + cron config. The
 * draft is REVIEWABLE — nothing writes to disk or to cron_jobs here.
 * The next step (save-draft) is what persists.
 *
 * Body: { description: string }
 * Response 200: { ok: true, draft: AutomationDraft }
 * Response 4xx: { ok: false, error, message? }
 */

import { NextRequest, NextResponse } from "next/server";
import { draftAutomation } from "@/lib/ai-automation-drafter";
import { CRON_RULE_SENTENCE } from "@/lib/automations/cron-grammar";
import { gateScriptAutomationCreate } from "@/lib/automations/script-access";

const BAD_SCHEDULE = "automation_draft_bad_schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Drafting a script automation is the first step of creating one, so it has
  // the create gate: a verified platform operator who manages this workspace
  // (lib/automations/script-access.ts). Checked before the body is read, so a
  // refused caller never reaches the model.
  const gate = await gateScriptAutomationCreate("Only owners/admins can create automations.");
  if (!gate.ok) return gate.response;
  const ctx = gate.ctx;

  let body: { description?: unknown };
  try {
    body = (await req.json()) as { description?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length < 10) {
    return NextResponse.json(
      { ok: false, error: "description_too_short", message: "Describe in at least one sentence what the automation should do." },
      { status: 400 },
    );
  }
  if (description.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "description_too_long", message: "Keep the description under 2000 characters." },
      { status: 400 },
    );
  }

  try {
    const draft = await draftAutomation(description, { tenantId: ctx.tenantId });
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "anthropic_key_missing") {
      return NextResponse.json(
        { ok: false, error: "ai_unavailable", message: "BRAVO_ANTHROPIC_API_KEY not set on the dashboard" },
        { status: 503 },
      );
    }
    // A schedule the runner cannot run is refused here, before review, where it
    // is read-only text beside a Save that would refuse it. The sentence names
    // what the AI wrote and the way forward (the UI shows `message` first).
    if (message.startsWith(BAD_SCHEDULE)) {
      const written = message.slice(BAD_SCHEDULE.length).replace(/^:\s*/, "");
      return NextResponse.json(
        {
          ok: false,
          error: "draft_invalid",
          message: `The AI wrote a schedule that can't run ("${written}"). ${CRON_RULE_SENTENCE} Click Draft with AI to write it again.`,
        },
        { status: 502 },
      );
    }
    if (message.startsWith("automation_draft_parse_failed") || message.startsWith("automation_draft_missing_field") || message.startsWith("automation_draft_bad_filename")) {
      return NextResponse.json(
        { ok: false, error: "draft_invalid", message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "ai_failed", message },
      { status: 500 },
    );
  }
}
