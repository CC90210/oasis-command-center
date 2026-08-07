/**
 * GET+POST /api/cron/sync-sms-numbers — keeps SMS sending numbers current.
 *
 * TextTorrent numbers get carrier-burned and rotated. A hardcoded list rotted
 * within four days in July 2026 and produced 1,070 failed sends over three
 * weeks, every one recorded as 'sent'. This refreshes the live set so the send
 * path never picks a number the account no longer owns.
 *
 * Runs twice daily (vercel.json). Alerts on rotation and on any rep left with
 * no sendable number, because that is the exact condition behind the outage.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { sendTelegram } from "@/lib/notify/telegram";
import { syncSenderNumbers } from "@/lib/drips/sender-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const r = await syncSenderNumbers(SUNBIZ_TENANT_ID);

    // Rotation is normal and worth knowing about; a rep with NO number is an
    // outage in waiting and is the loud one.
    const lines: string[] = [];
    if (r.repsWithNoLiveNumbers.length > 0) {
      lines.push(
        `🔴 <b>No sendable number</b> for: ${esc(r.repsWithNoLiveNumbers.join(", "))}. ` +
          `Every SMS for these reps will fail until a number is assigned in TextTorrent.`,
      );
    }
    if (r.added.length || r.deactivated.length) {
      lines.push(
        `🔁 <b>SMS numbers rotated</b>\n` +
          (r.added.length ? `added: ${esc(r.added.join(", "))}\n` : "") +
          (r.deactivated.length ? `retired: ${esc(r.deactivated.join(", "))}\n` : "") +
          `<i>the send path updated automatically</i>`,
      );
    }
    if (r.errors.length) {
      lines.push(`⚪ <b>Number sync had errors</b>\n${esc(r.errors.join("; ")).slice(0, 400)}`);
    }
    for (const text of lines) {
      await sendTelegram(text, { lane: "sunbiz-ops" }).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[sync-sms-numbers] failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
