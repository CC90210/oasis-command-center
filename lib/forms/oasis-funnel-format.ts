/**
 * oasis-funnel-format.ts — pure builder for CC's Telegram lead alert.
 *
 * No `server-only`, no network/secret code → unit-testable. The orchestrator
 * (oasis-funnel-notify.ts) imports this and hands the string to sendTelegram.
 */
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";

const INTEREST_LABELS: Record<string, string> = {
  ai: "⚡ AI Audit",
  music: "🎧 DJ Booking",
  brand: "🔥 Brand Session",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : str(v) ? [str(v)] : [];
}

/** Build CC's Telegram alert. All user-supplied substrings are HTML-escaped. */
export function buildOasisFunnelAlert(a: Record<string, unknown>): string {
  const e = escapeTelegramHtml;
  const name = str(a.name) || str(a.contact_name) || "New lead";
  const email = str(a.email);
  const phone = str(a.phone);
  const ig = str(a.instagram).replace(/^@/, "");
  const interests = asArray(a.interests);
  const interestText =
    interests.map((i) => INTEREST_LABELS[i] || e(i)).join(", ") || "—";

  let details = "";
  if (interests.includes("ai")) {
    const bn = str(a.business_name);
    if (bn) details += `\nBusiness: ${e(bn)} (${e(str(a.business_type) || "?")})`;
    const bp = asArray(a.biggest_pain).join(", ");
    if (bp) details += `\nPain: ${e(bp)}`;
  }
  if (interests.includes("music")) {
    const et = str(a.event_type);
    if (et) details += `\nEvent: ${e(et)}`;
    const ed = str(a.event_date);
    if (ed) details += ` — ${e(ed)}`;
    const mv = str(a.music_vibe);
    if (mv) details += `\nVibe: ${e(mv)}`;
  }
  if (interests.includes("brand")) {
    const bg = str(a.brand_goal);
    if (bg) details += `\nGoal: ${e(bg)}`;
    const aud = asArray(a.audience).join(", ");
    if (aud) details += `\nAudience: ${e(aud)}`;
    const cf = str(a.current_following);
    if (cf) details += ` (${e(cf)})`;
  }

  return (
    `🚀 <b>New Funnel Lead</b>\n\n` +
    `<b>${e(name)}</b>\n` +
    (email ? `📧 ${e(email)}\n` : "") +
    (phone ? `📱 ${e(phone)}\n` : "") +
    (ig ? `📸 @${e(ig)}\n` : "") +
    `\nInterested in: ${interestText}` +
    details
  );
}

const INTEREST_NAMES: Record<string, string> = {
  ai: "AI & Automation",
  music: "DJing & Music",
  brand: "Personal Brand",
};

/** Human-readable summary of the funnel answers → lead.notes. */
export function buildFunnelNotes(a: Record<string, unknown>): string {
  const interests = asArray(a.interests);
  const lines: string[] = [];
  if (interests.length) {
    lines.push(`Interested in: ${interests.map((i) => INTEREST_NAMES[i] || i).join(", ")}`);
  }
  if (interests.includes("ai")) {
    const bits = [str(a.business_name), str(a.business_type), asArray(a.biggest_pain).join(", ")]
      .filter(Boolean)
      .join(" · ");
    if (bits) lines.push(`AI: ${bits}`);
  }
  if (interests.includes("music")) {
    const bits = [str(a.event_type), str(a.event_date), str(a.music_vibe)].filter(Boolean).join(" · ");
    if (bits) lines.push(`Music: ${bits}`);
  }
  if (interests.includes("brand")) {
    const bits = [str(a.brand_goal), asArray(a.audience).join(", "), str(a.current_following)]
      .filter(Boolean)
      .join(" · ");
    if (bits) lines.push(`Brand: ${bits}`);
  }
  return lines.join("\n");
}

/**
 * Map funnel answers → the canonical OASIS lead fields the pipeline reads
 * (data.name / company / email / phone / notes). The form collects contact on
 * the LAST step and stores contact_name/business_name, so without this an OASIS
 * funnel lead would render blank in the pipeline. Returns only the keys present.
 */
export function buildOasisLeadPatch(a: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const name = str(a.name) || str(a.contact_name);
  if (name) patch.name = name;
  const email = str(a.email).trim().toLowerCase();
  if (email) patch.email = email;
  const phone = str(a.phone);
  if (phone) patch.phone = phone;
  const company = str(a.business_name) || str(a.company);
  if (company) patch.company = company;
  const ig = str(a.instagram).replace(/^@/, "");
  if (ig) patch.instagram = ig;
  const notes = buildFunnelNotes(a);
  if (notes) patch.notes = notes;
  return patch;
}
