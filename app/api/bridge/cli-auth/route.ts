/**
 * Queue one allowlisted vendor sign-in on one exact paired computer.
 *
 * This route deliberately accepts no command or free-form input. The selected
 * connector pulls the structured `auth` job and maps its provider to a
 * hard-coded login flow locally.
 */
import { NextResponse } from "next/server";
import { CLI_SIGN_IN, isSignInProvider } from "@/lib/bridge-cli-status";
import { enqueueRuntimeJob, hasOnlyKeys, isPlainObject, validRequestId } from "@/lib/bridge/runtime-jobs";
import { pairingCanClaim, type PairedVia } from "@/lib/bridge/pairing-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSessionContext } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";

type PairingRow = {
  id: string;
  label: string | null;
  claim_enabled_at: string | null;
  paired_via: PairedVia;
  claim_protocols: unknown;
};

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, message, ...extra }, { status });

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return stringList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function POST(req: Request) {
  const session = await getSessionContext();
  if (!session?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  if (!isPlainObject(raw)) return fail(400, "invalid_request", "Choose an AI app and computer.");
  if (!hasOnlyKeys(raw, ["provider", "pairing_id"])) {
    return fail(400, "unexpected_field", "Only an AI app and paired computer can be sent here.");
  }
  if (!isSignInProvider(raw.provider)) {
    return fail(400, "invalid_provider", "Pick Claude Code, Codex, or the supported Google API alternative.");
  }
  if (!validRequestId(raw.pairing_id)) {
    return fail(400, "invalid_pairing_id", "Choose the computer where this AI app should sign in.");
  }

  try {
    const { data, error } = await getServiceSupabase()
      .from("bridge_pairings")
      .select("id, label, claim_enabled_at, paired_via, claim_protocols")
      .eq("tenant_id", session.tenantId)
      .eq("user_id", session.authUserId)
      .eq("id", raw.pairing_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw new Error(`cli auth pairing read failed: ${error.message}`);
    const pairing = data as PairingRow | null;
    if (!pairing) {
      return fail(404, "pairing_not_found", "That computer is not paired to your account. Choose one of your computers.");
    }
    if (!pairingCanClaim({ claimEnabledAt: pairing.claim_enabled_at, pairedVia: pairing.paired_via })) {
      return fail(409, "pairing_not_approved", "Approve that computer in Devices before starting sign-in.");
    }
    if (!stringList(pairing.claim_protocols).includes("runtime_action_v1")) {
      return fail(409, "connector_update_required", "Update and restart the connector on that computer, then try again.");
    }

    if (raw.provider === "gemini") {
      return fail(
        409,
        "unsupported_personal_sign_in",
        "Gemini CLI personal sign-in is unsupported. Connect a Google Gemini API key instead.",
        { alternative: { mode: "api", provider: "google" } },
      );
    }

    const signIn = CLI_SIGN_IN[raw.provider];
    const queued = await enqueueRuntimeJob({
      tenantId: session.tenantId,
      userId: session.authUserId,
      pairingId: pairing.id,
      action: "auth",
      engine: { kind: "cli", name: raw.provider },
    });
    if (!queued.ok) {
      if (queued.code === "pairing_unavailable") {
        return fail(409, "pairing_unavailable", "That computer was disconnected or revoked. Choose another computer.");
      }
      if (queued.code === "queue_full" || queued.code === "rate_limited") {
        return fail(429, queued.code, "That computer already has several setup actions waiting. Let one finish, then try again.");
      }
      console.error("[bridge.cli-auth] runtime auth enqueue refused", queued.code);
      return fail(500, "auth_job_not_queued", "The sign-in could not be queued. Try again.");
    }

    const label = pairing.label?.trim() || "the selected computer";
    return NextResponse.json(
      {
        ok: true,
        job_id: queued.job.id,
        command: signIn.command,
        instructions: `${signIn.instructions} Complete it on the selected computer (${label}); this page will update automatically.`,
        message: `Sign-in was queued for ${label}.`,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[bridge.cli-auth] failed", error);
    return fail(500, "cli_auth_unavailable", "The selected computer could not be checked. Try again.");
  }
}
