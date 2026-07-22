/**
 * lib/integrations/kixie-automations.ts — pipeline side effects driven by
 * Kixie call outcomes. Runs in the webhook receiver AFTER the fail-closed
 * lead_interactions persist:
 *
 *   voicemail (outbound, lead-linked) → schedule the "just left you a
 *     voicemail" SMS via scheduled_sends (the 5-min dispatcher = the one
 *     send gate: per-rep TT sender, suppression, live/dry-run).
 *   missed/voicemail INBOUND → known lead: callback appointment + feed
 *     alert; unknown caller: auto-create a lead (source kixie_inbound).
 *   dispositioncall → config-mapped pipeline actions (pause drips /
 *     callback appointment / flag). Conservative defaults; unmapped
 *     dispositions are logged, never guessed into an action.
 *
 * Every handler is BEST-EFFORT and never throws: the webhook must not 5xx
 * (making Kixie re-deliver an already-persisted event) because a follow-on
 * automation failed. Failures are returned + logged, not swallowed.
 *
 * Config: tenants.custom_fields.kixie_automations
 *   { voicemail_followup?: bool, missed_inbound_capture?: bool,
 *     disposition_actions?: bool, excluded_stage_substrings?: string[],
 *     disposition_map?: { [lowercased disposition]: "callback" |
 *       "pause_drips" | "flag" | "none" } }
 * If the config READ fails, all automations disable for that event
 * (fail closed — a DB blip must not fire sends an operator switched off).
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import type { ResolvedRep } from "./kixie-attribution";

type Db = ReturnType<typeof getServiceSupabase>;

export type AutomationResult = {
  action: string;
  ok: boolean;
  detail?: string;
};

export type KixieAutomationConfig = {
  voicemailFollowup: boolean;
  missedInboundCapture: boolean;
  dispositionActions: boolean;
  excludedStageSubstrings: string[];
  dispositionMap: Record<string, "callback" | "pause_drips" | "flag" | "none">;
};

const DEFAULT_CONFIG: KixieAutomationConfig = {
  voicemailFollowup: true,
  missedInboundCapture: true,
  dispositionActions: true,
  // Stages where automated merchant contact must NOT fire (file is with
  // funders / dead) — substring-matched against data.stage.
  excludedStageSubstrings: ["submit", "fund", "declin", "dead", "uw_sheet", "lost", "archived"],
  dispositionMap: {},
};

export async function getAutomationConfig(
  db: Db,
  tenantId: string,
): Promise<KixieAutomationConfig> {
  try {
    const t = await db
      .from("tenants")
      .select("custom_fields")
      .eq("id", tenantId)
      .maybeSingle();
    if (t.error) throw new Error(t.error.message);
    const cf =
      ((t.data as { custom_fields?: Record<string, unknown> } | null)?.custom_fields) || {};
    const raw = (cf.kixie_automations || {}) as {
      voicemail_followup?: unknown;
      missed_inbound_capture?: unknown;
      disposition_actions?: unknown;
      excluded_stage_substrings?: unknown;
      disposition_map?: unknown;
    };
    return {
      voicemailFollowup: raw.voicemail_followup !== false,
      missedInboundCapture: raw.missed_inbound_capture !== false,
      dispositionActions: raw.disposition_actions !== false,
      excludedStageSubstrings: Array.isArray(raw.excluded_stage_substrings)
        ? (raw.excluded_stage_substrings as string[]).map((s) => String(s).toLowerCase())
        : DEFAULT_CONFIG.excludedStageSubstrings,
      dispositionMap:
        raw.disposition_map && typeof raw.disposition_map === "object"
          ? (raw.disposition_map as KixieAutomationConfig["dispositionMap"])
          : {},
    };
  } catch (err) {
    console.error("[kixie-automations] config read failed — automations off for this event", err);
    return {
      ...DEFAULT_CONFIG,
      voicemailFollowup: false,
      missedInboundCapture: false,
      dispositionActions: false,
    };
  }
}

async function leadStage(
  db: Db,
  tenantId: string,
  leadId: string,
  leadData: Record<string, unknown> | null,
): Promise<string> {
  if (leadData && typeof leadData.stage === "string") return leadData.stage.toLowerCase();
  const r = await db
    .from("tenant_records")
    .select("data")
    .eq("id", leadId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const data = (r.data as { data?: Record<string, unknown> } | null)?.data;
  return String(data?.stage || "").toLowerCase();
}

/**
 * Outbound voicemail on a known lead → schedule the follow-up SMS (+3 min).
 * Dedupe: skip when another voicemail landed for this lead in the last 24h,
 * or a pending scheduled SMS already exists for it. Both checks FAIL CLOSED
 * (check error → no send).
 */
export async function handleVoicemailFollowup(
  db: Db,
  args: {
    tenantId: string;
    leadId: string | null;
    leadData: Record<string, unknown> | null;
    rep: ResolvedRep | null;
    merchantPhone: string;
    isInbound: boolean;
    callId: string;
    cfg: KixieAutomationConfig;
  },
): Promise<AutomationResult | null> {
  const { tenantId, leadId, leadData, rep, merchantPhone, isInbound, callId, cfg } = args;
  const action = "voicemail_followup";
  if (isInbound || !cfg.voicemailFollowup || !leadId) return null;
  try {
    if (!rep) return { action, ok: false, detail: "no_rep_resolved" };
    const stage = await leadStage(db, tenantId, leadId, leadData);
    if (cfg.excludedStageSubstrings.some((s) => s && stage.includes(s))) {
      return { action, ok: false, detail: `stage_excluded:${stage}` };
    }
    const toPhone = normalizePhoneE164(merchantPhone);
    if (!toPhone) return { action, ok: false, detail: "no_valid_merchant_phone" };

    const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
    const priorVm = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("type", "call_voicemail")
      .gte("created_at", dayAgo)
      .neq("kixie_call_id", callId)
      .limit(1);
    if (priorVm.error) return { action, ok: false, detail: "dedupe_check_failed" };
    if ((priorVm.data || []).length > 0) return { action, ok: false, detail: "deduped_24h" };

    const pending = await db
      .from("scheduled_sends")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("channel", "sms")
      .eq("status", "pending")
      .limit(1);
    if (pending.error) return { action, ok: false, detail: "pending_check_failed" };
    if ((pending.data || []).length > 0) return { action, ok: false, detail: "pending_send_exists" };

    const sender = await resolveTextTorrentSenderId({ tenantId, userId: rep.userId }).catch(
      () => null,
    );
    if (!sender) return { action, ok: false, detail: "no_sender_number" };

    const firstName =
      String((leadData?.contact_name as string) || "")
        .trim()
        .split(/\s+/)[0] || "";
    // Compliance: direct-lender voice, no lender mentions, rep-attributed.
    const body = `Hi${firstName ? ` ${firstName}` : ""}, it's ${rep.displayName} with SunBiz Funding. Just left you a voicemail about your file. Text or call me back here when you have a minute.`;

    const ins = await db.from("scheduled_sends").insert({
      tenant_id: tenantId,
      lead_id: leadId,
      thread_key: `lead:${leadId}`,
      channel: "sms",
      to_phone: toPhone,
      body,
      actor_user_id: rep.userId,
      from_identity: sender,
      scheduled_for: new Date(Date.now() + 3 * 60e3).toISOString(),
      status: "pending",
    });
    if (ins.error) return { action, ok: false, detail: `insert_failed:${ins.error.message}` };
    return { action, ok: true, detail: "sms_scheduled_plus_3m" };
  } catch (err) {
    console.error("[kixie-automations] voicemail followup failed", err);
    return { action, ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * Inbound miss handling. Known lead → callback appointment (30 min out,
 * assigned to the resolved rep) + warn event. Unknown caller who left a VM
 * or talked ≥10s → auto-create a lead.
 *
 * The unknown-caller insert deliberately does NOT go through createRecord:
 * createRecord fires BRAVO_RECORD_STATUS_CHANGED, which the drip enroller
 * consumes — auto-enrolling someone who CALLED US into an outbound drip is
 * a human decision, not an automation's. Direct insert = lead exists, no
 * marketing fires until a rep touches it.
 */
export async function handleMissedInbound(
  db: Db,
  args: {
    tenantId: string;
    eventname: string;
    evt: {
      duration?: number;
      callstatus?: string;
      fname?: string;
      lname?: string;
      email?: string;
    };
    leadId: string | null;
    leadData: Record<string, unknown> | null;
    rep: ResolvedRep | null;
    merchantPhone: string;
    isInbound: boolean;
    callId: string;
    cfg: KixieAutomationConfig;
  },
): Promise<AutomationResult | null> {
  const { tenantId, eventname, evt, leadId, rep, merchantPhone, isInbound, callId, cfg } = args;
  const action = "missed_inbound";
  if (!isInbound || !cfg.missedInboundCapture) return null;

  const status = String(evt.callstatus || "").toLowerCase();
  const duration = typeof evt.duration === "number" ? evt.duration : null;
  const isVoicemail = eventname === "voicemail";
  const isMissedEnd =
    eventname === "endcall" && (status.includes("miss") || status.includes("no answer") || duration === 0);
  const answeredTalk = eventname === "endcall" && duration !== null && duration >= 10;

  try {
    if (leadId) {
      // Known lead, missed or voicemail → callback signal.
      if (!isVoicemail && !isMissedEnd) return null;
      // Idempotency (Codex P1 2026-07-21): Kixie retries deliveries, and a
      // single missed call can fire BOTH voicemail and endcall. The
      // BRAVO_KIXIE_MISSED_INBOUND event row doubles as the dedupe marker —
      // one per call_id, checked BEFORE creating an appointment. Fail closed:
      // a dedupe-check error skips the automation rather than double-booking.
      const dup = await db
        .from("agent_events")
        .select("id")
        .eq("event_type", "BRAVO_KIXIE_MISSED_INBOUND")
        .eq("payload->>call_id", callId)
        .limit(1);
      if (dup.error) return { action, ok: false, detail: "dedupe_check_failed" };
      if ((dup.data || []).length > 0) return { action, ok: true, detail: "deduped_call_id" };
      let apptDetail = "no_rep_for_appointment";
      if (rep) {
        const ins = await db.from("call_appointments").insert({
          tenant_id: tenantId,
          lead_id: leadId,
          entity_type: "lead",
          scheduled_for: new Date(Date.now() + 30 * 60e3).toISOString(),
          assigned_to: rep.userId,
          pre_call_note: `Missed inbound call${isVoicemail ? " (voicemail left)" : ""} — call back.`,
          created_by: rep.userId,
        });
        apptDetail = ins.error ? `appointment_failed:${ins.error.message}` : "callback_appointment_30m";
      }
      const ev = await db.from("agent_events").insert({
        event_type: "BRAVO_KIXIE_MISSED_INBOUND",
        publisher_agent: "kixie",
        severity: "warn",
        payload: { tenant_id: tenantId, lead_id: leadId, call_id: callId, voicemail: isVoicemail },
        correlation_id: tenantId,
      });
      return {
        action,
        ok: !ev.error,
        detail: apptDetail,
      };
    }

    // Unknown caller — only create a lead on a real signal (VM or ≥10s talk).
    if (!isVoicemail && !answeredTalk) return null;
    const ten = merchantPhone.replace(/\D+/g, "").replace(/^1(\d{10})$/, "$1");
    if (ten.length !== 10) return { action, ok: false, detail: "non_nanp_caller_skipped" };
    const callerName = [evt.fname, evt.lname].filter(Boolean).join(" ").trim();
    const ins = await db
      .from("tenant_records")
      .insert({
        tenant_id: tenantId,
        entity_type: "lead",
        data: {
          business_name: callerName || `Inbound caller (…${ten.slice(-4)})`,
          ...(callerName ? { contact_name: callerName } : {}),
          phone: ten,
          stage: "imported",
          source: "kixie_inbound",
          kixie_first_call_id: callId,
        },
      })
      .select("id")
      .single();
    if (ins.error) return { action, ok: false, detail: `lead_create_failed:${ins.error.message}` };
    const newLeadId = (ins.data as { id: string }).id;

    // Backfill the call row (persist skipped it — there was no lead yet).
    // Duration rides along (Codex P2 2026-07-21) so metrics count this as a
    // connected call; an answered talk backfills as call_ended, not incoming.
    await db.from("lead_interactions").upsert(
      {
        tenant_id: tenantId,
        lead_id: newLeadId,
        channel: "phone",
        agent_source: "kixie",
        kixie_call_id: callId,
        direction: "inbound",
        from_phone: merchantPhone || null,
        type: isVoicemail ? "call_voicemail" : "call_ended",
        ...(duration !== null ? { call_duration_sec: duration } : {}),
        ...(isVoicemail ? { call_outcome: "voicemail" } : {}),
        content_preview: "Inbound call from new caller (lead auto-created)",
        metadata: { kixie_agent_email: evt.email || null, auto_created_lead: true },
      },
      { onConflict: "kixie_call_id" },
    );
    await db.from("agent_events").insert({
      event_type: "BRAVO_KIXIE_NEW_INBOUND_LEAD",
      publisher_agent: "kixie",
      severity: "warn",
      payload: { tenant_id: tenantId, lead_id: newLeadId, call_id: callId, phone_last4: ten.slice(-4) },
      correlation_id: tenantId,
    });
    return { action, ok: true, detail: `lead_created:${newLeadId}` };
  } catch (err) {
    console.error("[kixie-automations] missed inbound failed", err);
    return { action, ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * Disposition → pipeline action. Explicit tenant map wins; built-in
 * defaults are conservative: negative dispositions PAUSE drips (never
 * auto-decline), positive ones book a callback + pause drips (a human took
 * over). Unmapped strings are logged so the map can grow from real usage.
 */
export async function handleDispositionActions(
  db: Db,
  args: {
    tenantId: string;
    leadId: string | null;
    rep: ResolvedRep | null;
    disposition: string | null | undefined;
    cfg: KixieAutomationConfig;
  },
): Promise<AutomationResult | null> {
  const { tenantId, leadId, rep, disposition, cfg } = args;
  const action = "disposition_action";
  if (!cfg.dispositionActions || !leadId) return null;
  const d = String(disposition || "").toLowerCase().trim();
  if (!d) return null;

  let mapped = cfg.dispositionMap[d];
  if (!mapped) {
    if (/(not\s+interested|do\s+not\s+call|\bdnc\b|remove|wrong\s+number)/.test(d)) {
      mapped = "pause_drips";
    } else if (/(interested|call\s?back|follow\s?.?up|\bhot\b|appointment)/.test(d)) {
      mapped = "callback";
    } else {
      console.warn(`[kixie-automations] unmapped disposition "${d}" — no action`);
      return { action, ok: true, detail: `unmapped:${d}` };
    }
  }
  if (mapped === "none") return { action, ok: true, detail: `mapped_none:${d}` };

  try {
    // Both callback + pause stop the machine — a human owns the lead now.
    const paused = await db
      .from("drip_runs")
      .update({ status: "cancelled", last_error: `kixie_disposition:${d.slice(0, 80)}` })
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .eq("status", "scheduled")
      .select("id");
    const pausedCount = paused.error ? -1 : (paused.data || []).length;

    if (mapped === "callback" && rep) {
      await db.from("call_appointments").insert({
        tenant_id: tenantId,
        lead_id: leadId,
        entity_type: "lead",
        scheduled_for: new Date(Date.now() + 60 * 60e3).toISOString(),
        assigned_to: rep.userId,
        pre_call_note: `Kixie disposition "${d.slice(0, 120)}" — follow up.`,
        created_by: rep.userId,
      });
    }
    await db.from("agent_events").insert({
      event_type: "BRAVO_KIXIE_DISPOSITION_ACTION",
      publisher_agent: "kixie",
      severity: mapped === "pause_drips" ? "warn" : "info",
      payload: {
        tenant_id: tenantId,
        lead_id: leadId,
        disposition: d,
        mapped_action: mapped,
        drips_paused: pausedCount,
      },
      correlation_id: tenantId,
    });
    return { action, ok: true, detail: `${mapped}:drips_paused=${pausedCount}` };
  } catch (err) {
    console.error("[kixie-automations] disposition action failed", err);
    return { action, ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }
}
