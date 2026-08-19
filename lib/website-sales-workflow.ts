export const OASIS_WEBSITE_TENANT_SLUG = "oasis-webdev";

export type RepDisposition = "attempted" | "voicemail" | "connected" | "lost";

export function mayAgentQualify(stage: unknown): boolean {
  return stage === "connected";
}

export function mayAgentBookFounder(stage: unknown): boolean {
  return stage === "qualified";
}

export function dispositionPatch(
  disposition: RepDisposition,
  nextActionAt: string | null,
  occurredAt = new Date().toISOString(),
  lossReason = "",
): Record<string, unknown> {
  if ((disposition === "attempted" || disposition === "voicemail") && !nextActionAt) {
    throw new Error("next_action_required");
  }
  if (nextActionAt && (!Number.isFinite(Date.parse(nextActionAt)) || Date.parse(nextActionAt) <= Date.parse(occurredAt))) {
    throw new Error("next_action_must_be_in_future");
  }
  if (disposition === "lost" && !lossReason.trim()) throw new Error("loss_reason_required");
  const stage = disposition === "connected"
    ? "connected"
    : disposition === "lost"
      ? "lost"
      : "attempting_contact";
  return {
    stage,
    last_disposition: disposition,
    last_contact_at: occurredAt,
    next_action_at: nextActionAt,
    ...(disposition === "lost" ? { loss_reason: lossReason } : {}),
  };
}
