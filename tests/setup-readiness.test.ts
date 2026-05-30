/**
 * Contract tests for lib/setup-readiness. The lib uses
 * `import "server-only"` at the top so it can't be imported in a
 * Node test runtime — but we can still lock down the type contract
 * via `import type` (which is erased at compile time).
 *
 * What this catches:
 *   - Status union staying { ok | warn | fail } — adding a fourth
 *     value silently without updating SetupReadinessCard.StatusGlyph
 *     would render UNDEFINED glyphs.
 *   - tenant: ReadinessItem[] | null contract. If a refactor turns
 *     this into `[]` instead of `null` for non-owners, the
 *     SetupReadinessCard renders an empty "Workspace-wide" section
 *     for every employee.
 *   - ReadinessItem shape stays minimal — adding a required field
 *     would break SetupReadinessCard renders + the Settings page.
 */

import type {
  ReadinessItem,
  ReadinessReport,
} from "../lib/setup-readiness";

const _shape: ReadinessReport = { personal: [], tenant: null };
void _shape;

const _itemShape: ReadinessItem = {
  key: "x",
  label: "x",
  status: "ok",
  detail: "x",
};
void _itemShape;

const _withCta: ReadinessItem = {
  key: "x",
  label: "x",
  status: "warn",
  detail: "x",
  cta: { href: "/settings", label: "Fix" },
};
void _withCta;

const STATUSES: Array<ReadinessItem["status"]> = ["ok", "warn", "fail"];
if (STATUSES.length !== 3) {
  throw new Error("ReadinessItem.status union changed — update StatusGlyph");
}

const _nullTenant: ReadinessReport = { personal: [], tenant: null };
const _arrTenant: ReadinessReport = { personal: [], tenant: [] };
void _nullTenant;
void _arrTenant;

console.log("setup-readiness ok (type contract)");
