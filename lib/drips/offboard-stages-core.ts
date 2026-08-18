/**
 * lib/drips/offboard-stages-core.ts — the stages that may still be dripped
 * after a lead leaves the Leads board.
 *
 * BACKGROUND, because this relaxes a guard Adon asked for. On 2026-08-11 he
 * set the rule that the drip audience is the Leads board's audience, after we
 * measured that the board showed 6 leads in Signed Application while the drip
 * query was mailing 312 — and that 64% of all drip mail ever sent had gone to
 * people the board does not show. That guard is right and stays.
 *
 * The exception it needs is DECLINED. A declined lead is stamped
 * `transferred_at` and drops off the board, which is correct for the board and
 * wrong for re-engagement: the whole point of a one-month check-back is to
 * reach someone whose file is closed. Measured 2026-08-18, all 57 emailable
 * declined leads are off-board, so the "Declined - 1-month check-back" sequence
 * was enabled and reaching exactly nobody.
 *
 * DELIBERATELY NOT signed_application. Adon, 2026-08-18: "there is no need for
 * them to keep on receiving drips if we've shopped out their application
 * because we received all the information that we need." The audit went
 * further: of the 331 emailable signed-application leads, 324 already have
 * their bank statements in `application_underwriting`. Re-opening that sequence
 * would email 324 merchants asking for documents sitting in our own database.
 * It stays closed.
 *
 * An allowlist rather than a flag, so adding a stage is a deliberate act with a
 * name attached rather than a boolean somebody flips.
 *
 * Pure and free of "server-only" so the rule that decides who can still be
 * mailed after their file closes is directly testable.
 */

const DEFAULT_OFFBOARD_STAGES = ["declined"];

/**
 * Stages exempt from the Leads-board filter.
 *
 * Env-overridable because the board's columns are operator-editable and a
 * renamed stage must not need a deploy. A malformed override falls back to the
 * default rather than to an empty list: an empty list silently re-closes
 * re-engagement, and a silent revert is how the declined sequence sat enabled
 * and unreachable in the first place.
 */
export function offboardStages(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.DRIP_OFFBOARD_STAGES || "").trim();
  if (raw.toLowerCase() === "none") return [];
  const parsed = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return parsed.length > 0 ? parsed : DEFAULT_OFFBOARD_STAGES;
}

/** May this stage be dripped even when the lead has left the Leads board? */
export function stageDripsOffBoard(
  stage: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const s = String(stage ?? "").trim().toLowerCase();
  if (!s) return false;
  return offboardStages(env).includes(s);
}
