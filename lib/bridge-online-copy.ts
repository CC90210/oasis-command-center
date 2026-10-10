/**
 * Plain-English wording for "is a paired computer connected", driven by the
 * LABELS of the pairings that are actually online — not a boolean. Pure and
 * dependency-free so it is unit-testable without a database.
 *
 * BUG (2026-10-10): the Automations and /sequences banners said "Your
 * computer is connected" whenever ANY non-revoked bridge_pairings row for
 * the tenant pinged within the freshness window (lib/queries.ts
 * getTenantBridgeStatus / getBridgeOnline). In the shared OASIS workspace
 * that pairing is always CC's PC, so Adon read a claim about HIS machine
 * that was false. The fix: name the pairing(s) that are actually online —
 * see lib/queries.ts:getOnlineBridgeComputerLabels, which this renders.
 *
 * The null ("could not check") and zero-online ("not connected yet") copy
 * is unchanged on purpose — both are pinned verbatim elsewhere
 * (tests/queries-fail-loud-callers.test.ts: "Couldn't check your computer" /
 * "Computer not connected yet"). Only the ONLINE sentence changes, because
 * only the online sentence was the false claim: nothing is lost by staying
 * silent about ownership when nothing is connected or the read itself failed.
 */

/** The label to show for one pairing — a real name, or a neutral fallback
 *  when the pairing was never given one. `lowerFirst` controls capitalization
 *  for the fallback mid-sentence ("...connected: CCPC, a paired computer.")
 *  versus sentence-initial ("A paired computer is connected."). */
function namedOrFallback(label: string | null | undefined, lowerFirst: boolean): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (trimmed) return trimmed;
  return lowerFirst ? "a paired computer" : "A paired computer";
}

/**
 * The bold lead-in sentence for the connection banner.
 *
 *   labels === null    → the heartbeat read itself failed ("Couldn't check").
 *   labels.length === 0 → no pairing is within the freshness window.
 *   labels.length === 1 → name it (or the neutral fallback if unnamed).
 *   labels.length >= 2  → count + name every one (fallback per unnamed entry).
 *
 * Never claims "your" computer: a shared workspace can have more than one
 * paired machine, and the viewer is not always the one who owns it.
 */
export function bridgeConnectionHeadline(labels: string[] | null): string {
  if (labels === null) return "Couldn't check your computer.";
  if (labels.length === 0) return "Computer not connected yet.";
  if (labels.length === 1) return `${namedOrFallback(labels[0], false)} is connected.`;
  const names = labels.map((label) => namedOrFallback(label, true));
  return `${labels.length} computers are connected: ${names.join(", ")}.`;
}
