export type EmployeeMember = {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  display_name: string | null;
};

export type EmployeeInteractionMetric = {
  channel: string | null;
  direction: string | null;
  actor_user_id: string | null;
  metadata: { requested_by_email?: string } | null;
};

export type EmployeeAuditMetric = {
  actor_email: string | null;
  actor_user_id: string | null;
};

export type EmployeeRollup = {
  profileId: string;
  label: string;
  email: string;
  email_sends: number;
  sms_sends: number;
  call_actions: number;
  recent_actions: number;
};

/**
 * Build tenant-member metrics. Metadata identities count only when they match a
 * real member supplied by the tenant-scoped caller.
 */
export function buildEmployeeActivityRollup(
  members: EmployeeMember[],
  interactions: EmployeeInteractionMetric[],
  auditRows: EmployeeAuditMetric[],
): EmployeeRollup[] {
  const byProfileId = new Map<string, EmployeeRollup>();
  const profileByAuthId = new Map<string, string>();
  const profileByEmail = new Map<string, string>();

  for (const member of members) {
    const rollup: EmployeeRollup = {
      profileId: member.id,
      label: (member.display_name || member.full_name || member.email || "Team member").trim(),
      email: member.email,
      email_sends: 0,
      sms_sends: 0,
      call_actions: 0,
      recent_actions: 0,
    };
    byProfileId.set(member.id, rollup);
    if (member.auth_user_id) profileByAuthId.set(member.auth_user_id, member.id);
    if (member.email) profileByEmail.set(member.email.trim().toLowerCase(), member.id);
  }

  const resolveProfile = (userId?: string | null, email?: string | null): string | null =>
    (userId && profileByAuthId.get(userId)) ||
    (email && profileByEmail.get(email.trim().toLowerCase())) ||
    null;

  for (const row of interactions) {
    const profileId = resolveProfile(
      row.actor_user_id,
      row.metadata?.requested_by_email || null,
    );
    if (!profileId) continue;
    const rollup = byProfileId.get(profileId);
    if (!rollup) continue;
    rollup.recent_actions += 1;
    const channel = (row.channel || "").toLowerCase();
    const outbound = (row.direction || "").toLowerCase() !== "inbound";
    if (outbound && channel === "email") rollup.email_sends += 1;
    if (outbound && channel === "sms") rollup.sms_sends += 1;
    if (channel === "call" || channel === "phone") rollup.call_actions += 1;
  }

  for (const row of auditRows) {
    const profileId = resolveProfile(row.actor_user_id, row.actor_email);
    if (!profileId) continue;
    const rollup = byProfileId.get(profileId);
    if (rollup) rollup.recent_actions += 1;
  }

  return Array.from(byProfileId.values()).sort(
    (left, right) =>
      right.recent_actions - left.recent_actions || left.label.localeCompare(right.label),
  );
}
