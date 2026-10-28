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
 *
 * ONLY THE AGENTS OWNER DISPATCHES (Codex review of #768). A directive is carried to the agents owner's
 * computer and lands in its agents' inboxes as "cc", so another operator of the workspace is refused
 * (403 agents_owner_only) rather than having their note ride along as the owner's. A reply must name a
 * real note of this workspace (in_reply_to): free text there would reach a model-readable inbox.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { COMPOSER_RECIPIENTS, VALID_PRIORITIES, isMessageId, type Priority } from "@/lib/agent-inbox-types";
import { isRelayRecipient, postMessageDb } from "@/lib/agent-inbox-db";
import { readAgentsOwner } from "@/lib/agents-owner";

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

  const owner = await readAgentsOwner(tenantId);
  if (owner.state === "unavailable") {
    return NextResponse.json({ ok: false, error: "owner_check_unavailable" }, { status: 503 });
  }
  if (owner.state !== "set" || owner.authUserId !== user.id) {
    return NextResponse.json({ ok: false, error: "agents_owner_only" }, { status: 403 });
  }

  const inReplyTo = typeof body.in_reply_to === "string" ? body.in_reply_to.trim() : "";
  if (inReplyTo) {
    const parent = isMessageId(inReplyTo)
      ? await getServiceSupabase().from("agent_messages").select("id").eq("tenant_id", tenantId).eq("message_id", inReplyTo).limit(1)
      : { data: [], error: null };
    if (parent.error) {
      console.error("[inbox.post.reply_check]", { tenantId, error: parent.error.message });
      return NextResponse.json({ ok: false, error: "reply_check_unavailable" }, { status: 503 });
    }
    if (!parent.data || parent.data.length === 0) {
      return NextResponse.json({ ok: false, error: "unknown_in_reply_to" }, { status: 400 });
    }
  }

  const result = await postMessageDb({
    tenantId,
    from: "cc",
    to,
    subject,
    body: bodyText,
    priority,
    requires_response: Boolean(body.requires_response),
    in_reply_to: inReplyTo || null,
    relayEligible: isRelayRecipient(to),
  });
  if (!result.ok) {
    console.error("[inbox.post]", { tenantId, error: result.error });
    return NextResponse.json({ ok: false, error: "post_failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, message: result.message });
}
