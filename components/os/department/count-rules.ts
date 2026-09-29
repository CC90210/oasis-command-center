/**
 * components/os/department/count-rules.ts — how a department tile prints a
 * count read from a list that stops at a ceiling.
 *
 * PURE, so tests/os-departments.test.ts runs it in bare node (./numbers.ts is
 * server-only and reads the database). The rule itself lives once, in
 * lib/os/count.ts, shared with Today and the Clients page.
 */
export { floorCount as tileCount } from "@/lib/os/count";
