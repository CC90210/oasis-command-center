/**
 * POST /api/inbox/post - the operator posts a note or directive to an agent. Operator-only.
 *
 * DATABASE ONLY (2026-10-28). This used to write a local JSON file as well, through
 * lib/agent-inbox-fs, which cannot work on the Cloudflare Worker (there is no disk:
 * tests/workers-no-runtime-fs.test.ts). A directive now reaches an agent's local inbox through the
 * agents owner's computer instead (app/api/bridge/inbox): a note to an agent with a local reader is
 * stored relay_eligible, and the computer delivers it within a minute.
 *
 * THE SENDER IS THE OPERATOR. `from` is always "cc", whatever the body says: a relayed note lands in
 * an agent's own inbox on CC's computer, so it must be what the signed-in operator wrote, never a note
 * that claims to come from another agent.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { COMPOSER_RECIPIENTS, VALID_PRIORITIES, type Priority } from "@/lib/agent-inbox-types";
import { isRelayRecipient, postMessageDb } from "@/lib/agent-inbox-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // Verified operator (alias AND owner/admin OASIS membership by auth id) —
  // the same rule the Agent ops page gates on. Fails closed.
  if (!(await isPlatformOperatorForAuthUser(user.id, user.email))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: {
    to?: string;
    subject?: string;
    body?: string;
    priority?: Priority;
    requires_response?: boolean;
    in_reply_to?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const to = String(body.to || "").trim().toLowerCase();
  if (!(COMPOSER_RECIPIENTS as readonly string[]).includes(to)) {
    return NextResponse.json({ ok: false, error: `unknown_recipient:${to}` }, { status: 400 });
  }
  const priority = body.priority ?? "normal";
  if (!(VALID_PRIORITIES as readonly string[]).includes(priority)) {
    return NextResponse.json({ ok: false, error: "invalid_priority" }, { status: 400 });
  }
  const subject = String(body.subject || "").slice(0, 200);
  const bodyText = String(body.body || "").slice(0, 8000);
  if (!bodyText.trim()) return NextResponse.json({ ok: false, error: "body_required" }, { status: 400 });

  const profileRes = await getServiceSupabase()
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profileRes.data as { tenant_id: string | null } | null)?.tenant_id;
  if (profileRes.error || !tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 409 });
  }

  const result = await postMessageDb({
    tenantId,
    from: "cc",
    to,
    subject,
    body: bodyText,
    priority,
    requires_response: Boolean(body.requires_response),
    in_reply_to: typeof body.in_reply_to === "string" && body.in_reply_to.trim() ? body.in_reply_to.trim() : null,
    relayEligible: isRelayRecipient(to),
  });
  if (!result.ok) {
    console.error("[inbox.post]", { tenantId, error: result.error });
    return NextResponse.json({ ok: false, error: "post_failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, message: result.message });
}
