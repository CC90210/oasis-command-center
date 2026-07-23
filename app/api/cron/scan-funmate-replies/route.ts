import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getFunmateMailCredentials } from "@/lib/integrations/funmate-mail";
import { getServiceSupabase } from "@/lib/supabase-server";
import { classifyLenderReply } from "@/lib/lenders/classify-reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest) {
  const supplied = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const suppliedBuffer = Buffer.from(supplied);
  return [process.env.CRON_SECRET, process.env.SCAN_TRIGGER_SECRET]
    .filter((value): value is string => Boolean(value))
    .some((expected) => {
      const expectedBuffer = Buffer.from(expected);
      return (
        expectedBuffer.length === suppliedBuffer.length &&
        timingSafeEqual(expectedBuffer, suppliedBuffer)
      );
    });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const write = new URL(req.url).searchParams.get("write") === "1";
  let creds;
  try { creds = getFunmateMailCredentials(); }
  catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "funmate_creds_failed" }, { status: 500 });
  }

  const db = getServiceSupabase();
  const threadsResult = await db
    .from("application_lender_threads")
    .select("id,lender_id,subject,last_response_at")
    .eq("email_identity", "funmate")
    .order("created_at", { ascending: false })
    .limit(500);
  if (threadsResult.error) return NextResponse.json({ ok: false, error: "funmate_thread_lookup_failed" }, { status: 500 });
  const threads = (threadsResult.data || []) as Array<{
    id: string;
    lender_id: string;
    subject: string | null;
    last_response_at: string | null;
  }>;
  const lenderIds = [...new Set(threads.map((thread) => thread.lender_id).filter(Boolean))];
  const lendersResult = lenderIds.length
    ? await db
        .from("tenant_records")
        .select("id,data")
        .eq("entity_type", "lender")
        .in("id", lenderIds)
    : { data: [], error: null };
  if (lendersResult.error) {
    return NextResponse.json(
      { ok: false, error: "funmate_lender_lookup_failed" },
      { status: 500 },
    );
  }
  const addressesByLender = new Map<string, Set<string>>();
  for (const row of lendersResult.data || []) {
    const data = (row as { id: string; data?: Record<string, unknown> }).data || {};
    const addresses = [
      ...(Array.isArray(data.submission_emails) ? data.submission_emails : []),
      data.contact,
    ]
      .filter((value): value is string => typeof value === "string" && value.includes("@"))
      .map((value) => value.trim().toLowerCase());
    addressesByLender.set(String(row.id), new Set(addresses));
  }

  const client = new ImapFlow({
    host: creds.imapHost,
    port: creds.imapPort,
    secure: creds.imapSecure,
    auth: { user: creds.email, pass: creds.appPassword },
    logger: false,
    greetingTimeout: 12_000,
    socketTimeout: 25_000,
  });
  const results: Array<Record<string, unknown>> = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since: new Date(Date.now() - 7 * 86400_000) });
      for await (const message of client.fetch((uids || []).slice(-20), { envelope: true, source: true })) {
        const subject = message.envelope?.subject || "";
        const senders = (message.envelope?.from || [])
          .map((address) => address.address?.trim().toLowerCase())
          .filter((address): address is string => Boolean(address));
        const subjectMatches = threads.filter(
          (candidate) =>
            candidate.subject &&
            subject.toLowerCase().includes(candidate.subject.toLowerCase()),
        );
        const thread =
          subjectMatches.find((candidate) =>
            senders.some((sender) => addressesByLender.get(candidate.lender_id)?.has(sender)),
          ) || (subjectMatches.length === 1 ? subjectMatches[0] : undefined);
        if (!thread) continue;
        const date = message.envelope?.date instanceof Date ? message.envelope.date : new Date();
        if (thread.last_response_at && date.getTime() <= Date.parse(thread.last_response_at)) continue;
        const parsed = await simpleParser(message.source as Buffer);
        const classification = await classifyLenderReply(subject, String(parsed.text || parsed.html || ""));
        const status =
          classification.category === "approved" ? "approved" :
          classification.category === "declined" ? "declined" :
          classification.category === "info_needed" || classification.category === "counter_offer" ? "info_requested" :
          "responded";
        if (write) {
          await db.from("application_lender_threads").update({
            status,
            last_response_at: date.toISOString(),
            last_response_summary: `${classification.category}${classification.amount ? ` $${classification.amount}` : ""}`.slice(0, 480),
          }).eq("id", thread.id).eq("email_identity", "funmate");
        }
        results.push({ thread_id: thread.id, subject, status, classification });
      }
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: "funmate_imap_failed", detail: error instanceof Error ? error.message : "unknown" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, mode: write ? "write" : "dry", inbox: creds.email, matched: results.length, results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}

