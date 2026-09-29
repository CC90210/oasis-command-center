/**
 * lib/os/count.ts — the ONE rule for printing a count read from a list that
 * stops at a ceiling.
 *
 * A read that hit its ceiling gives a floor, so it prints "500+" — never a bare
 * number that reads as the total. Today, the Clients page and every department
 * tile call this, so the same queue cannot print as "≥500" on one screen and
 * "500+" on another (three hand-rolled copies had drifted exactly that way;
 * CodeRabbit, PR #468).
 *
 * PURE: no imports, safe in client code and in bare-node tests.
 */
export function floorCount(value: number, capped: boolean): string {
  const text = value.toLocaleString("en-US");
  return capped ? `${text}+` : text;
}
