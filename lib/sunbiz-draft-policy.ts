export type SunbizDraftAction = "approve" | "edit_send" | "reject" | "pause" | "resume" | "handoff";
const WRITE_ROLES = new Set(["owner", "admin", "member", "loan_officer", "processor"]);
export function canManageSunbizDraft(role: string | null | undefined): boolean {
  return WRITE_ROLES.has((role || "").trim().toLowerCase());
}
export function isSunbizDraftAction(value: unknown): value is SunbizDraftAction {
  return ["approve", "edit_send", "reject", "pause", "resume", "handoff"].includes(String(value));
}
export function normalizeDraftText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= 1600 ? text : null;
}
export function isWithinSmsHours(timezone: string, now = new Date()): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", hour12: false,
    }).format(now));
    return Number.isFinite(hour) && hour >= 8 && hour < 20;
  } catch {
    return false;
  }
}
