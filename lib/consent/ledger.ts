/**
 * lib/consent/ledger.ts — the insert-only consent ledger (`consent_events`,
 * database/turso/bravo__214_consent_events.sql): recording a decision, and
 * the one gate every marketing send must pass.
 *
 * WHY A SEPARATE LEDGER FROM OPT-IN VAULT. lib/consent/optinvault.ts seals
 * evidence for SunBiz and Bluerise only (lib/consent/brand-for-tenant.ts: a
 * tenant not on that list captures NOTHING). Every other workspace's public
 * form — including OASIS's own /ai-audit — asked for a mobile number with no
 * consent record at all. This table is first-party (no external vault call,
 * no site key), scoped to every workspace, and additive: SunBiz and Bluerise
 * keep the vault exactly as it is.
 *
 * SERVER OWNS THE TRUTH. recordConsentEvents takes the CHANNELS the caller
 * (the submit route) has already determined this form step actually
 * rendered — derived from the form's OWN field definitions, never from
 * anything the client claims — and the IDENTITY the server resolved
 * (lib/consent/ledger-identity.ts). It renders the disclosure text itself and
 * hashes that. A client cannot add a channel that was not on the step, and
 * cannot alter the text or the hash: nothing it sends is read for either.
 *
 * FAIL CLOSED, BOTH DIRECTIONS.
 *   - A ledger WRITE failure does not fail the submission (the enquiry is
 *     still answered and the lead still created — the house rule this
 *     mirrors is lib/consent/optinvault.ts's "a rejected capture must never
 *     be recorded locally as consent"). It simply means no ticked row exists,
 *     which is exactly the state hasTickedConsent reads as "refuse" — so a
 *     write failure costs nothing on the compliance side; it costs only the
 *     ability to market to that lead on that channel until they try again.
 *   - A ledger READ failure (hasTickedConsent) returns false: no proof of
 *     consent, so no send. The one case this function must never do is turn
 *     "I could not check" into "they said yes".
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbBool } from "@/lib/db-bool";
import {
  CONSENT_DISCLOSURE_VERSION,
  consentDisclosureText,
  type ConsentChannel,
  type ConsentIdentity,
} from "./ledger-disclosure";
import type { ConsentIdentitySource } from "./ledger-identity";

export type ConsentDecision = {
  channel: ConsentChannel;
  /** Whether THIS box was ticked. Recorded either way — a recorded decline is
   *  itself the evidence that unticks a channel for marketing. */
  ticked: boolean;
};

export type RecordConsentEventsInput = {
  tenantId: string;
  leadId: string;
  formId: string;
  /** Only channels the SERVER determined this step actually rendered — see
   *  the module doc. Never derived from client input. */
  decisions: ConsentDecision[];
  identity: ConsentIdentity;
  identitySource: ConsentIdentitySource;
  /** From Cloudflare's cf-connecting-ip header. Never from the request body —
   *  a client can set any value it likes in a JSON field, which would make
   *  this evidence worthless against the one party it exists to bind. */
  ipAddress: string | null;
  userAgent: string | null;
  pageUrl: string | null;
};

export type RecordConsentEventsResult = {
  ok: boolean;
  /** Channels that recorded successfully. */
  recorded: ConsentChannel[];
  /** Channels that were asked for but failed to write, with why. */
  failed: Array<{ channel: ConsentChannel; reason: string }>;
};

/** sha256 of the exact rendered text, hex-encoded. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Insert one row per decision. Never throws — a ledger outage must not break
 * the enquiry it is recording consent for. Each row is attempted
 * independently so one failure does not lose a sibling channel's record.
 */
export async function recordConsentEvents(
  db: SupabaseClient,
  input: RecordConsentEventsInput,
): Promise<RecordConsentEventsResult> {
  const recorded: ConsentChannel[] = [];
  const failed: Array<{ channel: ConsentChannel; reason: string }> = [];
  const now = new Date().toISOString();

  for (const decision of input.decisions) {
    const text = consentDisclosureText(decision.channel, input.identity);
    const hash = sha256Hex(text);
    try {
      const ins = await db.from("consent_events").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        lead_id: input.leadId,
        form_id: input.formId,
        channel: decision.channel,
        ticked: decision.ticked ? 1 : 0,
        disclosure_hash: hash,
        disclosure_version: CONSENT_DISCLOSURE_VERSION,
        disclosure_text: text,
        ip_address: input.ipAddress,
        user_agent: input.userAgent,
        page_url: input.pageUrl,
        identity_source: input.identitySource,
        created_at: now,
      });
      if (ins.error) {
        failed.push({ channel: decision.channel, reason: ins.error.message });
        console.error("[consent.ledger] insert failed", {
          tenant_id: input.tenantId,
          lead_id: input.leadId,
          channel: decision.channel,
          error: ins.error.message,
        });
      } else {
        recorded.push(decision.channel);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ channel: decision.channel, reason });
      console.error("[consent.ledger] insert threw", {
        tenant_id: input.tenantId,
        lead_id: input.leadId,
        channel: decision.channel,
        error: reason,
      });
    }
  }

  return { ok: failed.length === 0, recorded, failed };
}

/**
 * May this channel be used for a MARKETING send to this lead?
 *
 * Reads the MOST RECENT decision for (tenant, lead, channel) — the ledger is
 * append-only, so "the current answer" is whichever row was written last,
 * exactly like re-ticking or un-ticking a preference. No row at all (never
 * asked, or the ask failed to record) answers false, same as an explicit
 * decline: there is no evidence of consent either way, and the absence of
 * evidence is not evidence of consent.
 *
 * FAIL CLOSED: any read error — a bad tenant/lead id, the table unreachable,
 * a malformed response — returns false. This is the one function in this
 * module where returning true on an error would be the defect: a send that
 * cannot prove consent is exactly the TCPA/CASL failure mode this ledger
 * exists to prevent.
 */
export async function hasTickedConsent(
  db: SupabaseClient,
  args: { tenantId: string; leadId: string; channel: ConsentChannel },
): Promise<boolean> {
  try {
    const res = await db
      .from("consent_events")
      .select("ticked")
      .eq("tenant_id", args.tenantId)
      .eq("lead_id", args.leadId)
      .eq("channel", args.channel)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) {
      console.error("[consent.ledger] hasTickedConsent read failed, refusing", {
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        channel: args.channel,
        error: res.error.message,
      });
      return false;
    }
    const row = res.data as { ticked?: unknown } | null;
    if (!row) return false;
    return dbBool(row.ticked);
  } catch (err) {
    console.error("[consent.ledger] hasTickedConsent threw, refusing", {
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      channel: args.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
