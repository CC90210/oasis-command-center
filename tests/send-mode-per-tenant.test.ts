/**
 * tests/send-mode-per-tenant.test.ts — each company's live-send switches are
 * its own.
 *
 * The dry-run flags are Vercel env, one set for the whole deployment, and OASIS
 * and SunBiz both send through it: flipping DASHBOARD_LIVE_SEND or DRIPS_LIVE
 * for one company flipped it for the other. A tenant's own flag is now checked
 * first. The first half of this file proves that with no per-tenant flag set
 * the answer is identical to the old function for every combination of the
 * shared flags; the second half proves the per-tenant flags stay per tenant.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isDryRun,
  isDripsLive,
  tenantForcedDryRun,
  tenantFlagSuffix,
  type SendTenant,
} from "../lib/integrations/send-mode";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const STRANGER = "5f63d7e6-0000-4000-8000-000000000000";

const FLAG = /^(BRAVO_FORCE_DRY_RUN|DASHBOARD_LIVE_SEND|LIVE_SEND_[A-Z_]+|DRIPS_LIVE)(__[A-Z0-9_]+)?$/;
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => FLAG.test(k)));
function clear() {
  for (const k of Object.keys(process.env)) if (FLAG.test(k)) delete process.env[k];
}
function withEnv(env: Record<string, string>, fn: () => void) {
  clear();
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    clear();
  }
}

// ── The function as it was before this change, verbatim ─────────────────────
const LEGACY_CHANNEL_LIVE_ENV: Record<string, string> = {
  texttorrent: "LIVE_SEND_TEXTTORRENT",
  texttorrent_followup: "LIVE_SEND_TEXTTORRENT_FOLLOWUP",
  kixie: "LIVE_SEND_KIXIE",
  twilio: "LIVE_SEND_TWILIO",
  gws: "LIVE_SEND_EMAIL",
  email: "LIVE_SEND_EMAIL",
  constant_contact: "LIVE_SEND_CONSTANT_CONTACT",
  smartlead: "LIVE_SEND_SMARTLEAD",
};
function legacyIsDryRun(channel?: string): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return true;
  if (channel) {
    const envKey = LEGACY_CHANNEL_LIVE_ENV[channel.toLowerCase()];
    const v = envKey ? (process.env[envKey] || "").trim() : "";
    if (v === "1") return false;
    if (v === "0") return true;
  }
  return (process.env.DASHBOARD_LIVE_SEND || "").trim() !== "1";
}

// ── 1. No per-tenant flag set → identical to before, for every tenant ──────
const VALUES = [undefined, "1", "0", "true", " 1 "];
const CHANNELS = [undefined, "kixie", "texttorrent", "TextTorrent", "texttorrent_followup", "twilio", "gws", "email", "constant_contact", "smartlead", "unknown"];
const TENANTS: Array<SendTenant | undefined> = [
  undefined, {}, { tenantId: SUNBIZ }, { tenantId: OASIS }, { tenantId: WEBDEV }, { tenantId: STRANGER },
  { tenantSlug: "submissions" }, { tenantSlug: "oasis-ai-cc" }, { tenantId: null, tenantSlug: null },
];
let compared = 0;
for (const force of VALUES) for (const dash of VALUES) for (const kixie of VALUES) for (const tt of VALUES) {
  const env: Record<string, string> = {};
  if (force !== undefined) env.BRAVO_FORCE_DRY_RUN = force;
  if (dash !== undefined) env.DASHBOARD_LIVE_SEND = dash;
  if (kixie !== undefined) env.LIVE_SEND_KIXIE = kixie;
  if (tt !== undefined) env.LIVE_SEND_TEXTTORRENT = tt;
  withEnv(env, () => {
    for (const ch of CHANNELS) {
      const want = legacyIsDryRun(ch);
      for (const t of TENANTS) {
        assert.equal(isDryRun(ch, t), want, `isDryRun(${ch}, ${JSON.stringify(t)}) under ${JSON.stringify(env)}`);
        compared += 1;
      }
    }
  });
}
assert.ok(compared > 50_000, `compared ${compared} combinations`);

for (const v of [undefined, "1", "0", " 1", "true"]) {
  withEnv(v === undefined ? {} : { DRIPS_LIVE: v }, () => {
    for (const t of TENANTS) {
      assert.equal(isDripsLive(t), v === "1", `isDripsLive(${JSON.stringify(t)}) with DRIPS_LIVE=${v}: exactly DRIPS_LIVE === "1"`);
      assert.equal(tenantForcedDryRun(t), false);
    }
  });
}

// ── 2. Which flags name which tenant ────────────────────────────────────────
assert.equal(tenantFlagSuffix({ tenantId: SUNBIZ }), "SUBMISSIONS");
assert.equal(tenantFlagSuffix({ tenantId: OASIS }), "OASIS_AI_CC");
assert.equal(tenantFlagSuffix({ tenantId: WEBDEV }), "OASIS_WEBDEV");
assert.equal(tenantFlagSuffix({ tenantSlug: "oasis-ai-cc" }), "OASIS_AI_CC");
assert.equal(tenantFlagSuffix({ tenantId: STRANGER }), null, "an unknown tenant has no flags of its own");
assert.equal(tenantFlagSuffix({ tenantId: STRANGER, tenantSlug: "submissions" }), null,
  "an unmapped id never borrows SunBiz's flags through a slug");
assert.equal(tenantFlagSuffix(undefined), null);

// ── 3. One company's flag never moves the other's ───────────────────────────
withEnv({ DASHBOARD_LIVE_SEND: "1", DASHBOARD_LIVE_SEND__OASIS_AI_CC: "0" }, () => {
  assert.equal(isDryRun(undefined, { tenantId: SUNBIZ }), false, "SunBiz stays live");
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), false);
  assert.equal(isDryRun(undefined, { tenantId: OASIS }), true, "OASIS is held dry by its own flag");
  assert.equal(isDryRun("texttorrent", { tenantId: OASIS }), true);
  assert.equal(isDryRun(undefined, { tenantId: WEBDEV }), false, "a different OASIS tenant has its own flag");
  assert.equal(isDryRun(undefined), false, "tenant-less callers see only the shared flag");
});
withEnv({ LIVE_SEND_TEXTTORRENT__SUBMISSIONS: "1" }, () => {
  assert.equal(isDryRun("texttorrent", { tenantId: SUNBIZ }), false, "SunBiz's TextTorrent goes live alone");
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), true, "and only that channel");
  assert.equal(isDryRun("texttorrent", { tenantId: OASIS }), true, "OASIS stays dry");
  assert.equal(isDryRun("texttorrent"), true);
});
withEnv({ DASHBOARD_LIVE_SEND: "1", BRAVO_FORCE_DRY_RUN__SUBMISSIONS: "1", LIVE_SEND_KIXIE__SUBMISSIONS: "1" }, () => {
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), true, "a tenant's kill switch beats its own live flags");
  assert.equal(isDryRun(undefined, { tenantId: SUNBIZ }), true);
  assert.equal(isDryRun("kixie", { tenantId: OASIS }), false, "and stops nobody else");
  assert.equal(tenantForcedDryRun({ tenantId: SUNBIZ }), true);
  assert.equal(tenantForcedDryRun({ tenantId: OASIS }), false);
});
withEnv({ BRAVO_FORCE_DRY_RUN: "1", DASHBOARD_LIVE_SEND__SUBMISSIONS: "1", LIVE_SEND_KIXIE__SUBMISSIONS: "1" }, () => {
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), true, "the shared kill switch still clamps every tenant");
});
withEnv({ LIVE_SEND_KIXIE: "1", DASHBOARD_LIVE_SEND__OASIS_AI_CC: "0" }, () => {
  assert.equal(isDryRun("kixie", { tenantId: OASIS }), true, "a tenant's own clamp beats a shared channel flag");
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), false);
});
withEnv({ DASHBOARD_LIVE_SEND__SUBMISSIONS: "0", LIVE_SEND_KIXIE__SUBMISSIONS: "1" }, () => {
  assert.equal(isDryRun("kixie", { tenantId: SUNBIZ }), false, "a tenant's channel flag beats its own dashboard flag");
  assert.equal(isDryRun("texttorrent", { tenantId: SUNBIZ }), true);
});
withEnv({ DASHBOARD_LIVE_SEND__SUBMISSIONS: "1" }, () => {
  assert.equal(isDryRun(undefined, { tenantId: STRANGER, tenantSlug: "submissions" }), true,
    "a stranger's workspace cannot ride SunBiz's live flag");
  assert.equal(isDryRun(undefined, { tenantSlug: "submissions" }), false, "a caller holding only the slug is honored");
});

// ── 4. Drips: a tenant can be held dry, never switched on alone ────────────
withEnv({ DRIPS_LIVE: "1", DRIPS_LIVE__OASIS_AI_CC: "0" }, () => {
  assert.equal(isDripsLive({ tenantId: SUNBIZ }), true, "SunBiz's drips stay live");
  assert.equal(isDripsLive({ tenantId: OASIS }), false, "OASIS's drips are held dry");
  assert.equal(isDripsLive(), true, "the run-level answer is the shared switch");
});
withEnv({ DRIPS_LIVE__SUBMISSIONS: "1" }, () => {
  assert.equal(isDripsLive({ tenantId: SUNBIZ }), false,
    "a tenant cannot open drips alone: the executor sizes its caps from the shared switch");
});

// ── 5. The callers pass their tenant ────────────────────────────────────────
{
  const runner = readFileSync("lib/cloud-tool-runner.ts", "utf8");
  assert.ok(!/isDryRun\(\)\)/.test(runner), "no chat-tool send asks without its workspace");
  assert.equal((runner.match(/isDryRun\(undefined, \{ tenantId: ctx\.tenantId \}\)/g) || []).length, 4,
    "call, Kixie SMS, TextTorrent send and inbox reply");
  assert.ok(/isDryRun\("texttorrent", \{ tenantId: ctx\.tenantId \}\)/.test(runner), "and the blast");

  const enroller = readFileSync("lib/drips/enroller.ts", "utf8");
  assert.ok(!/(=|return)\s+process\.env\.DRIPS_LIVE/.test(enroller), "the enroller reads the switch through isDripsLive only");
  assert.ok(/const tenantLive = isDripsLive\(\{ tenantId: seq\.tenant_id \}\);/.test(enroller));
  assert.ok(/if \(!tenantLive \|\| !stageAllowed\) continue;/.test(enroller));

  const executor = readFileSync("lib/drips/executor.ts", "utf8");
  assert.ok(!/(=|return)\s+process\.env\.DRIPS_LIVE/.test(executor), "the executor reads the switch through isDripsLive only");
  assert.equal((executor.match(/const shouldSend = dripSendEnabled\(row\.tenant_id\);/g) || []).length, 2, "SMS and email rows");
  assert.equal((executor.match(/const dripsLive = isDripsLive\(\{ tenantId: row\.tenant_id \}\);/g) || []).length, 2);

  const suite = readFileSync("tests/_suite.mjs", "utf8");
  assert.ok(suite.includes('"tests/send-mode-per-tenant.test.ts"'), "this file must be in the suite");
}

clear();
Object.assign(process.env, saved);
console.log(`send-mode-per-tenant.test.ts — ${compared} legacy combinations matched; all assertions passed ✓`);
