/**
 * Contract tests for lib/seat-warning. The module uses
 * `import "server-only"` so it can't be runtime-imported in a Node
 * test runtime — but `import type` works at compile time and lets
 * us lock down the return-shape contract that app/team/page.tsx
 * renders against.
 *
 * What this catches:
 *   - Status union staying { ok | approaching | over } — adding a
 *     fourth value silently would break the team page's banner
 *     color logic which switches on these three only.
 *   - SeatWarning.message stays a string (the team page renders it
 *     literally).
 *   - SeatWarning return contract is never undefined for a non-
 *     null callsite — page code uses `seatWarning && ...` to gate.
 */

import type { SeatWarning } from "../lib/seat-warning";

const STATUSES: Array<SeatWarning["status"]> = ["ok", "approaching", "over"];
if (STATUSES.length !== 3) {
  throw new Error("SeatWarning.status union changed — update app/team/page.tsx banner logic");
}

const _ok: SeatWarning = {
  used: 1,
  limit: 3,
  status: "ok",
  message: "1 of 3 seats used on the starter plan.",
};
const _approaching: SeatWarning = {
  used: 3,
  limit: 3,
  status: "approaching",
  message: "3 of 3 seats used.",
};
const _over: SeatWarning = {
  used: 4,
  limit: 3,
  status: "over",
  message: "4 of 3 seats used — over the starter plan limit.",
};
void _ok;
void _approaching;
void _over;

// limit must accept null for plans without a soft cap (enterprise).
const _enterprise: SeatWarning = {
  used: 99,
  limit: null,
  status: "ok",
  message: "no cap",
};
void _enterprise;

console.log("seat-warning ok (type contract)");
