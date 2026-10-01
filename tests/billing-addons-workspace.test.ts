/**
 * tests/billing-addons-workspace.test.ts — Settings › Billing & add-ons
 * knows whose workspace it is (S1-A2).
 *
 * On OASIS's own workspace the vendor is not a customer: the plan section says
 * nothing is billed here, and each app card says "Built by OASIS" and links
 * the app's install guide. On a client's workspace the request path stays:
 * "Ask OASIS about your plan" and "Ask OASIS to add this" through the support
 * form. Before this the OASIS owner's "Ask OASIS" filed a ticket into OASIS's
 * own desk.
 *
 * The page is rendered for real, both branches, with the Settings viewer
 * stubbed (the only read it makes).
 *
 * Run: node --conditions=react-server --import tsx tests/billing-addons-workspace.test.ts
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import * as ReactNS from "react";

const ROOT = join(__dirname, "..");
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
stub("next/image", {
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => ReactNS.createElement("img", { src, alt }),
});

let oasisWorkspace = false;
const viewer = () => ({
  ok: true as const,
  persona: "founder",
  userId: "user-1",
  tenantId: "tenant-1",
  tenantSlug: oasisWorkspace ? "oasis-ai-cc" : "client-co",
  access: { canManage: true, isOperator: false, canSeeTeamPerformance: true, oasisWorkspace },
  viewerAccess: { persona: "founder", canSeePersonalSettings: true, canSeeTeamPerformance: true, canSeeSystemSurfaces: true, degraded: false },
});
stub(join(ROOT, "components", "settings", "settings-viewer.ts"), {
  requireSettingsSection: async () => viewer(),
  loadSettingsViewer: async () => viewer(),
  isVerifiedOperator: async () => false,
});

type El = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
type Rendered = { text: string[]; links: string[] };
/** Render a server page's tree: call every function component, collect its text and its anchors' hrefs. */
async function render(node: unknown, out: Rendered = { text: [], links: [] }): Promise<Rendered> {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) await render(n, out);
    return out;
  }
  const el = node as El;
  if (!el.$$typeof || !el.props) return out;
  if (typeof el.type === "function") return render(await (el.type as (p: unknown) => unknown)(el.props), out);
  if (el.type === "a" && typeof el.props.href === "string") out.links.push(el.props.href);
  return render(el.props.children, out);
}

async function main() {
  const { default: SettingsBillingPage } = await import("../app/settings/billing/page");
  const { SUPPORT_FORM_PATH } = await import("../lib/delivery/support-form");
  const { OASIS_ADDONS } = await import("../components/settings/addons");
  const count = (r: Rendered, needle: string) => r.text.filter((t) => t.includes(needle)).length;

  // ── OASIS's own workspace: the vendor, not a customer ─────────────────────
  oasisWorkspace = true;
  const oasis = await render(await SettingsBillingPage());
  const oasisText = oasis.text.join(" ");
  assert.match(oasisText, /This is OASIS's own workspace\. Nothing is billed here\./, "the plan section says nothing is billed");
  assert.doesNotMatch(oasisText, /Ask OASIS about your plan|handled directly with OASIS|coming in a later release/, "no customer copy for the vendor");
  assert.equal(count(oasis, "Built by OASIS"), OASIS_ADDONS.length, "every card says Built by OASIS");
  assert.equal(count(oasis, "Ask OASIS to add this"), 0, "OASIS never asks itself to add its own app");
  assert.equal(count(oasis, "Added by OASIS on request"), 0);
  for (const addon of OASIS_ADDONS) {
    assert.ok(oasis.links.includes(addon.installGuide.href), `${addon.name}: the install guide is linked (${addon.installGuide.href})`);
  }
  assert.ok(!oasis.links.includes(SUPPORT_FORM_PATH), "the support form is not offered to OASIS");
  assert.equal(count(oasis, "Install guide"), OASIS_ADDONS.length);

  // ── A client's workspace: the request path, unchanged ─────────────────────
  oasisWorkspace = false;
  const client = await render(await SettingsBillingPage());
  const clientText = client.text.join(" ");
  assert.match(clientText, /handled directly with OASIS/, "the plan section names who handles billing");
  assert.doesNotMatch(clientText, /Nothing is billed here|Built by OASIS|Install guide/, "no vendor copy for a client");
  assert.equal(count(client, "Ask OASIS to add this"), OASIS_ADDONS.length, "every card can be requested");
  assert.equal(count(client, "Added by OASIS on request"), OASIS_ADDONS.length);
  assert.ok(client.links.includes(SUPPORT_FORM_PATH), "the request goes through the support form");
  for (const addon of OASIS_ADDONS) {
    assert.ok(!client.links.includes(addon.installGuide.href), `${addon.name}: a client is not sent to OASIS's repo`);
  }
  // Both branches describe the same apps the same way.
  for (const addon of OASIS_ADDONS) {
    for (const r of [oasis, client]) {
      assert.equal(count(r, addon.summary), 1, `${addon.name}: summary`);
      // Both apps run on macOS and Windows, so the platforms line repeats.
      assert.ok(count(r, addon.platforms) >= 1, `${addon.name}: platforms`);
      assert.equal(count(r, addon.privacy), 1, `${addon.name}: privacy`);
    }
  }
  // Nothing sells or ships an add-on, on either branch.
  assert.doesNotMatch(oasisText + clientText, /\$\s?\d|price|buy now|download/i);

  console.log(`billing-addons-workspace: ok (${OASIS_ADDONS.length} add-ons, both branches rendered)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
