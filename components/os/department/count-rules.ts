/**
 * components/os/department/count-rules.ts — how a department tile prints a
 * count read from a list that stops at a ceiling.
 *
 * PURE, so tests/os-departments.test.ts runs it in bare node (./numbers.ts is
 * server-only and reads the database).
 */

/**
 * The count as a tile prints it. A read that hit its ceiling gives a floor, so
 * it prints "500+" — never a bare number that reads as the total. Every tile
 * showing the same count calls this, so two tabs cannot disagree about it (the
 * Chief of Staff tile once printed as exact what Client Success printed as a
 * floor; CodeRabbit, PR #468).
 */
export function tileCount(value: number, capped: boolean): string {
  const text = value.toLocaleString("en-US");
  return capped ? `${text}+` : text;
}
