/**
 * oasis-funnel-email.ts — Claude-personalized welcome email for CC's funnel.
 *
 * Ported from the retired cc-funnel app: when a lead submits CC's funnel, send
 * ONE warm, personalized email from his Gmail referencing their specific
 * answers (business + pain point, event, brand goal…), signed "— CC".
 *
 * Why a NEW module instead of reusing next-steps-email.ts: that path is
 * bridge-bound (resolveBridgeTarget) and fails closed for every tenant except
 * SunBiz. OASIS sends directly via nodemailer + Gmail app password — the exact
 * transport cc-funnel used.
 *
 * Idempotent per lead (one welcome), suppression-checked fail-closed, and fully
 * soft-fail: every error is caught + logged; the submission is never affected.
 */
import "server-only";
import { inferText } from "@/lib/subscription-infer";
import nodemailer from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Distinct agent_source tag → clean idempotency + lead-timeline audit. */
const WELCOME_SOURCE = "oasis_funnel_welcome";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : str(v) ? [str(v)] : [];
}

type Composed = { subject: string; body: string };

/** Build the per-interest context lines fed to Claude (or the fallback). */
function buildContext(interests: string[], d: Record<string, string>): string[] {
  const parts: string[] = [];
  if (interests.includes("ai")) {
    parts.push("They're interested in AI automation for their business.");
    if (d.businessName) parts.push(`Business name: ${d.businessName}`);
    if (d.businessType) parts.push(`Business type: ${d.businessType}`);
    if (d.biggestPain) parts.push(`Their biggest pain point: "${d.biggestPain}"`);
  }
  if (interests.includes("music")) {
    parts.push("They want to book a DJ.");
    if (d.eventType) parts.push(`Event type: ${d.eventType}`);
    if (d.eventDate) parts.push(`Date: ${d.eventDate}`);
    if (d.musicVibe) parts.push(`Vibe they want: "${d.musicVibe}"`);
  }
  if (interests.includes("brand")) {
    parts.push("They want help building their personal brand.");
    if (d.brandGoal) parts.push(`Their goal: ${d.brandGoal}`);
    if (d.audience) parts.push(`Target audience: ${d.audience}`);
    if (d.currentFollowing) parts.push(`Current following: ${d.currentFollowing}`);
  }
  return parts;
}

async function compose(
  name: string,
  interests: string[],
  details: Record<string, string>,
  tenantId?: string | null,
): Promise<Composed> {

  const firstName = name.split(" ")[0] || "there";
  const context = buildContext(interests, details).join("\n");

  const prompt = `You are Conaugh McKenna (CC), a 22-year-old entrepreneur who runs OASIS AI Solutions (an AI automation agency), DJs events, and coaches people on personal branding. You're authentic, warm, direct, and never salesy. You talk like you're texting a friend — casual but sharp.

Someone named ${firstName} just filled out your funnel form. Here's what they told you:
${context}

Write a SHORT, personalized email to ${firstName}. Rules:
- Sound like YOU, not a corporation. No "Dear" or "Thank you for your interest."
- Reference their SPECIFIC details (business name, pain point, event type, etc.)
- Tell them exactly what you're going to do for them and when
- If AI interest: tell them you'll send a personalized AI audit within 48 hours
- If music interest: tell them you'll reach out to discuss their event
- If brand interest: tell them you'll DM them on Instagram to book a 15-min strategy session
- Keep it under 150 words
- End with "— CC"
- No emojis in the body text

Return ONLY a JSON object with "subject" and "body" keys. The body should be plain text (not HTML). No markdown, no code fences, just the JSON.`;

  try {
    /*
     * Subscription, not the paid API. This one fires on a PUBLIC form
     * submission, so it was the only remaining paid call with no human in the
     * loop at all — a prospect filling in the funnel spent money directly.
     * See lib/subscription-infer.ts.
     */
    const inf = await inferText({
      source: "oasis-funnel-email",
      system: "",
      prompt,
      maxTokens: 400,
      tenantId,
      modelTier: "smart",
    });
    // Fallback copy is a complete, sendable email — a slow or unavailable queue
    // must not delay the prospect's confirmation.
    if (!inf.ok) return fallback(name, interests, details);
    const text = inf.text;
    // Strip code fences if Claude wrapped the JSON (mirrors ai-checkin-compose).
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(cleaned) as { subject?: unknown; body?: unknown };
    if (typeof parsed.subject === "string" && typeof parsed.body === "string") {
      return { subject: parsed.subject, body: parsed.body };
    }
    return fallback(name, interests, details);
  } catch {
    return fallback(name, interests, details);
  }
}

function fallback(
  name: string,
  interests: string[],
  d: Record<string, string>,
): Composed {
  const firstName = name.split(" ")[0] || "there";
  if (interests.includes("ai")) {
    return {
      subject: `${firstName}, your AI audit is coming`,
      body: `Hey ${firstName},\n\nGot your info — I'm reviewing ${d.businessName || "your business"} right now. You'll have a full breakdown of what I'd automate first in your inbox within 48 hours.\n\n${d.biggestPain ? `You mentioned "${d.biggestPain}" — that's the first thing I'm looking at.\n\n` : ""}Talk soon,\n— CC`,
    };
  }
  if (interests.includes("music")) {
    return {
      subject: `${firstName}, let's talk about your event`,
      body: `Hey ${firstName},\n\nGot your details${d.eventType ? ` for your ${d.eventType}` : ""}${d.eventDate ? ` around ${d.eventDate}` : ""}. I'll reach out within 24 hours to talk availability and vibe.\n\n${d.musicVibe ? `"${d.musicVibe}" — I already have some ideas.\n\n` : ""}— CC`,
    };
  }
  return {
    subject: `${firstName}, let's book your strategy session`,
    body: `Hey ${firstName},\n\nI'm reaching out about your free brand strategy session. ${d.brandGoal ? `You said your goal is to ${d.brandGoal}` : "I've got some ideas"} — I'll DM you on Instagram to find a time this week.\n\n15 minutes, zero pitch, and you'll walk away with something you can use immediately.\n\n— CC`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** OASIS-branded HTML wrap (gold/black/cream), ported from cc-funnel. The body
 *  is HTML-escaped first — it's built from user answers (fallback path) and
 *  LLM output seeded with user answers (Claude path), so a crafted name /
 *  business name / model response must not inject markup into the email HTML.
 *  (Codex audit 2026-06-18 [high].) The plain-text part stays raw. */
function wrapInHtml(body: string): string {
  const htmlBody = escapeHtml(body)
    .split("\n\n")
    .map(
      (p) =>
        `<p style="color:#ccc;line-height:1.7;margin:0 0 16px">${p.replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `
    <div style="background:#0a0a0a;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
      <div style="background:#111;padding:20px 24px;text-align:center;border-bottom:2px solid #e8c547">
        <span style="color:#faf9f5;font-size:20px;font-weight:700;letter-spacing:1px">OASIS</span>
        <span style="color:#e8c547;font-size:20px;font-weight:700;letter-spacing:1px"> AI</span>
        <p style="color:#666;font-size:11px;margin:4px 0 0;text-transform:uppercase;letter-spacing:2px">Automation That Works For You</p>
      </div>
      <div style="padding:32px 24px"><div style="max-width:520px;margin:0 auto">${htmlBody}</div></div>
      <div style="background:#111;padding:20px 24px;text-align:center;border-top:1px solid #222">
        <p style="color:#888;font-size:13px;margin:0 0 4px"><strong>Conaugh McKenna</strong> | Founder, OASIS AI Solutions</p>
        <p style="color:#555;font-size:11px;margin:0">International &middot; <a href="https://www.instagram.com/oasisaisolutions/" style="color:#e8c547;text-decoration:none">@oasisaisolutions</a></p>
      </div>
    </div>`;
}

/** Map the funnel's snake_case answers → the camelCase detail keys the
 *  prompt/fallback expect; arrays joined for readability. */
function extractDetails(a: Record<string, unknown>): Record<string, string> {
  const d: Record<string, string> = {};
  if (str(a.business_name)) d.businessName = str(a.business_name);
  if (str(a.business_type)) d.businessType = str(a.business_type);
  const bp = asArray(a.biggest_pain).join(", ");
  if (bp) d.biggestPain = bp;
  if (str(a.event_type)) d.eventType = str(a.event_type);
  if (str(a.event_date)) d.eventDate = str(a.event_date);
  if (str(a.music_vibe)) d.musicVibe = str(a.music_vibe);
  if (str(a.brand_goal)) d.brandGoal = str(a.brand_goal);
  const aud = asArray(a.audience).join(", ");
  if (aud) d.audience = aud;
  if (str(a.current_following)) d.currentFollowing = str(a.current_following);
  return d;
}

export type OasisFunnelWelcomeInput = {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  /** Merged form answers across all steps (interests, branch details, contact). */
  answers: Record<string, unknown>;
};

export type DeliverResult = { sent: boolean; reason?: string };

/**
 * Send ONE transactional email to a lead and record it — the shared core.
 *
 * Extracted 2026-07-30 so the AI-audit funnel inherits this instead of growing
 * a parallel copy. Everything valuable here is the stuff a second
 * implementation forgets: idempotency per (lead, source), a FAIL-CLOSED
 * suppression check, the Gmail-credential guard, and the lead_interactions row
 * that makes the send auditable. Callers supply only what differs — the
 * composed subject/body and the source tag.
 *
 * Returns a result instead of void: the previous caller discarded it, so a
 * failed welcome email was invisible to the orchestrator (only a console line).
 */
export async function deliverWelcomeEmail(args: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  toEmail: string;
  source: string;
  subject: string;
  body: string;
}): Promise<DeliverResult> {
  const { db, tenantId, leadId, toEmail, source, subject, body } = args;

  if (!EMAIL_RE.test(toEmail)) return { sent: false, reason: "no_usable_email" };

  // Idempotency — one email per (lead, source). A returning, smart-matched lead
  // that re-submits is not re-emailed. Scoped BY SOURCE so an ai-audit
  // confirmation and a funnel welcome do not suppress each other.
  const prior = await db
    .from("lead_interactions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("agent_source", source)
    .limit(1);
  if (prior.error) {
    // FAIL CLOSED: an unreadable idempotency state must not authorise a
    // second transactional email to the same lead.
    console.error("[funnel.welcome] idempotency check errored — skipping (fail-closed)", {
      lead_id: leadId,
      source,
      error: prior.error.message,
    });
    return { sent: false, reason: "idempotency_check_failed" };
  }
  if ((prior.data?.length ?? 0) > 0) {
    return { sent: false, reason: "already_sent" };
  }

  // Suppression — a public form must never re-email someone who opted out.
  // Match literally (escape LIKE wildcards); FAIL CLOSED on lookup error.
  const suppPattern = toEmail.replace(/[%_\\]/g, "\\$&");
  const supp = await db
    .from("email_suppressions")
    .select("email")
    .eq("tenant_id", tenantId)
    .ilike("email", suppPattern)
    .limit(1);
  if (supp.error) {
    console.error("[funnel.welcome] suppression check errored — skipping (fail-closed)", {
      lead_id: leadId,
      source,
      error: supp.error.message,
    });
    return { sent: false, reason: "suppression_check_failed" };
  }
  if ((supp.data?.length ?? 0) > 0) return { sent: false, reason: "suppressed" };

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.error("[funnel.welcome] GMAIL_USER/GMAIL_APP_PASSWORD not set — skipping", { source });
    return { sent: false, reason: "gmail_not_configured" };
  }

  let sentOk = false;
  let reason: string | null = null;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `"Conaugh McKenna" <${gmailUser}>`,
      to: toEmail,
      subject,
      text: body,
      html: wrapInHtml(body),
    });
    sentOk = true;
  } catch (e) {
    reason = e instanceof Error ? e.message : "send_failed";
  }

  await db.from("lead_interactions").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    type: sentOk ? "email_sent" : "email_queued",
    channel: "email",
    direction: "outbound",
    agent_source: source,
    subject: subject.slice(0, 200),
    content: body,
    content_preview: body.slice(0, 1024),
    to_email: toEmail,
    metadata: {
      status: sentOk ? "sent" : "failed",
      sent_at: sentOk ? new Date().toISOString() : null,
      send_error: reason,
      welcome: true,
      intent: "transactional",
    },
  });

  if (!sentOk) {
    console.error("[funnel.welcome] send did not fire", { lead_id: leadId, source, reason });
  }
  return { sent: sentOk, reason: reason || undefined };
}


export async function sendOasisFunnelWelcome(
  input: OasisFunnelWelcomeInput,
): Promise<DeliverResult> {
  const { db, tenantId, leadId, answers } = input;
  try {
    const toEmail = str(answers.email).trim().toLowerCase();
    if (!EMAIL_RE.test(toEmail)) return { sent: false, reason: "no_usable_email" };

    const interests = asArray(answers.interests);
    const details = extractDetails(answers);
    const name = str(answers.name) || str(answers.contact_name) || "there";
    const { subject, body } = await compose(name, interests, details, tenantId);

    return await deliverWelcomeEmail({
      db, tenantId, leadId, toEmail, source: WELCOME_SOURCE, subject, body,
    });
  } catch (err) {
    console.error("[oasis-funnel.welcome] threw", {
      lead_id: leadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: err instanceof Error ? err.message : "threw" };
  }
}
