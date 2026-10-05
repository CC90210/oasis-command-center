/**
 * support-address.test.ts - support@oasisai.work is the one OASIS address a
 * client, a prospect or a legal reader is given. conaugh@oasisai.work is CC's
 * identity (his login, the founders' roster, his calendar, the sales mailbox
 * default) and appears only in the files that use it as one.
 *
 * WHY (CC, 2026-10-01): a new Google Workspace account, support@oasisai.work,
 * "will handle all the support tickets and branding across the software ...
 * find where conaugh@oasisai.work is listed or built into the software itself
 * so that you can update it with the correct email."
 *
 *   1. The published constants: OASIS_SUPPORT_EMAIL is support@, and
 *      CONTACT_EMAIL, every LEGAL_CONTACTS role, PRIVACY_OFFICER.email and the
 *      privacy manifest's three address fields are it. The privacy officer is
 *      still a named person (Quebec Law 25 designates a person, not a mailbox).
 *   2. The client-facing files never name CC's address, and each takes its
 *      contact (or its sending identity) from the single source.
 *   3. Everywhere else in app/, components/, lib/ and docs/compliance, CC's
 *      address appears only in the IDENTITY files below, each with the reason
 *      it names CC rather than a contact. A new occurrence fails, and so does
 *      an entry whose file no longer has it.
 *   4. Rendered: the legal pages, /unsubscribe, the manual opt-out and the
 *      error help show support@ and never CC's address.
 *
 * Run: node --conditions=react-server --import tsx tests/support-address.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";

const ROOT = join(__dirname, "..");
const SUPPORT = "support@oasisai.work";
const CC = "conaugh@oasisai.work";

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React.
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

/**
 * Files a client, a prospect or a legal reader sees (or that compose email to
 * a client), and the token that proves each one takes its address or its
 * sending identity from the single source. `null`: no wiring to prove, the
 * file must only never name CC.
 */
const CLIENT_FACING: Record<string, RegExp | null> = {
  "app/(marketing)/privacy/page.tsx": /PRIVACY_OFFICER\.email/,
  "app/(marketing)/terms/page.tsx": /LEGAL_CONTACTS\.legal/,
  "app/(marketing)/dmca/page.tsx": /LEGAL_CONTACTS\.dmca/,
  "app/(marketing)/contact/page.tsx": /CONTACT_EMAIL/,
  "app/page.tsx": /CONTACT_EMAIL/,
  "app/unsubscribe/page.tsx": /CONTACT_EMAIL/,
  "app/unsubscribe/ManualOptOut.tsx": /CONTACT_EMAIL/,
  "app/settings/privacy/page.tsx": /PRIVACY_OFFICER\.email/,
  "app/clients/[id]/page.tsx": /OASIS_SUPPORT_EMAIL/,
  "components/legal/LegalPage.tsx": /LEGAL_CONTACTS\.legal/,
  "components/marketing/MarketingFooter.tsx": /CONTACT_EMAIL/,
  "components/marketing/AuditForm.tsx": /CONTACT_EMAIL/,
  "components/ErrorHelp.tsx": /CONTACT_EMAIL/,
  "components/onboarding/ProvisioningProgress.tsx": /CONTACT_EMAIL/,
  "lib/marketing/routes.ts": /CONTACT_EMAIL = OASIS_SUPPORT_EMAIL/,
  "lib/playbook/templates/context.ts": /LEGAL_CONTACTS/,
  "lib/delivery/messages.ts": null,
  "lib/delivery/notify.ts": /purpose: "support"/,
  "app/api/clients/[id]/reply/route.ts": /purpose: "support"/,
  "lib/os/approvals/executors.ts": /purpose = await emailPurposeFor\(ctx\.db, ctx\.tenant\.id, ctx\.approval, to\)/,
  "lib/founders-finances/invoice-email.ts": /replyTo: OASIS_SUPPORT_EMAIL/,
  "lib/auth-email.ts": /replyTo: OASIS_SUPPORT_EMAIL/,
  "lib/config/email-signature.ts": /function oasisSupportFooter\(/,
  "docs/compliance/PRIVACY_NUTRITION_LABEL.json": null,
};

/**
 * Files that name CC's address as CC: an identity, never a published contact.
 * Each needs its reason; an entry whose file no longer names him fails.
 */
const IDENTITY_FILES: Record<string, string> = {
  "app/founders/marketing/library/page.tsx":
    "a comment on the founders' marketing portal: CC is the default author Maven stamps on an asset",
  "lib/agent-roots.ts": "a comment naming CC's login as the operator family's root user",
  "lib/cloud-tools.ts": "the lead-import tool tells the operator's agent which teammate logins may own a batch (CC or Adon)",
  "lib/config/agents.ts": "a comment recording why CC's login fell off the SunBiz signer roster (2026-09-08)",
  "lib/email/brands.ts": "the OASIS SALES mailbox default when OASIS_MAIL_FROM is unset; support mail never uses it",
  "lib/founders-finances/access.ts": "the finance allowlist: CC's login owns his personal books",
  "lib/founders-marketing-core.ts": 'maps CC\'s login to the author name "CC" in the founders\' marketing portal',
  "lib/integrations/google-calendar.ts": "founder-audit invites copy CC by default (GOOGLE_FOUNDER_MEETING_CC_EMAIL)",
  "lib/integrations/oasis-shared-gmail-send.ts": "an incident comment quoting the header CC saw on 2026-09-09",
  "lib/manifest/seeds.ts": "OASIS's own setup-readiness note: BEA's send_gateway sends OASIS sales mail as CC (operator only)",
  "lib/operator-credentials.ts": "the default operator login (CC) for the operator gate",
  "lib/team.ts": "the founders' assignment roster: new-ticket and SLA alerts go TO CC (internal mail)",
};

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(tsx?|jsx?|mjs|json|html|md)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");
const read = (r: string) => readFileSync(join(ROOT, r), "utf8");
/** Code without its comments, so a wiring token in a comment proves nothing. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Strings and href/props reachable in a server-rendered element tree (as in verified-mailboxes.test.ts). */
function textOf(node: unknown, out: string[] = [], depth = 0, opaque: ReadonlySet<unknown> = new Set()): string[] {
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1, opaque);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function" && !opaque.has(node.type)) {
      textOf((node.type as (p: unknown) => unknown)(props), out, depth + 1, opaque);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v, out, depth + 1, opaque);
      else if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  console.log("support-address:");
  const legal = await import("../lib/legal/constants");
  const { CONTACT_EMAIL } = await import("../lib/marketing/routes");

  await check("1. support@ is the one published address; the privacy officer is still a named person", () => {
    assert.equal(legal.OASIS_SUPPORT_EMAIL, SUPPORT);
    assert.equal(CONTACT_EMAIL, SUPPORT, "CONTACT_EMAIL (marketing site, error, setup and opt-out pages)");
    for (const [role, address] of Object.entries(legal.LEGAL_CONTACTS)) {
      assert.equal(address, SUPPORT, `LEGAL_CONTACTS.${role}`);
    }
    assert.equal(legal.PRIVACY_OFFICER.email, SUPPORT, "PRIVACY_OFFICER.email");
    assert.equal(legal.PRIVACY_OFFICER.name, "Conaugh McKenna", "Law 25 designates a person; only the contact moved");
    const label = JSON.parse(read("docs/compliance/PRIVACY_NUTRITION_LABEL.json"));
    assert.equal(label.app.privacyContact, SUPPORT);
    assert.equal(label.app.privacyOfficer.email, SUPPORT);
    assert.equal(label.userRights.requestChannel, SUPPORT);
    const mailboxes = JSON.parse(read("config/verified-mailboxes.json")).mailboxes as string[];
    assert.ok(mailboxes.includes(SUPPORT), "a published address must be a verified mailbox");
    assert.ok(mailboxes.includes(CC), "CC's inbox is still a real, verified mailbox; it is just not published");
  });

  await check("2. client-facing files never name CC's address and take their contact from the single source", () => {
    const bad: string[] = [];
    for (const [file, wiring] of Object.entries(CLIENT_FACING)) {
      const src = read(file);
      if (src.toLowerCase().includes(CC)) bad.push(`${file}: names ${CC}`);
      if (wiring && !wiring.test(code(src))) bad.push(`${file}: no ${wiring} (not wired to the single source)`);
      if (file in IDENTITY_FILES) bad.push(`${file}: is both client-facing and an identity file`);
    }
    assert.deepEqual(bad, [], bad.join("\n"));
  });

  await check("3. everywhere else, CC's address appears only in the identity files, each with its reason", () => {
    const scanned = [...["app", "components", "lib"].flatMap((d) => files(join(ROOT, d))), ...files(join(ROOT, "docs/compliance"))];
    assert.ok(scanned.length > 500, `the scan found only ${scanned.length} files; it is broken`);
    const naming = new Set(scanned.filter((f) => readFileSync(f, "utf8").toLowerCase().includes(CC)).map(rel));
    const unexplained = [...naming].filter((f) => !(f in IDENTITY_FILES)).sort();
    assert.deepEqual(
      unexplained,
      [],
      `these name ${CC} without being an identity file. A client-facing address is OASIS_SUPPORT_EMAIL; ` +
        `if this really is CC as a person, add the file to IDENTITY_FILES with the reason:\n${unexplained.join("\n")}`,
    );
    const stale = Object.keys(IDENTITY_FILES).filter((f) => !naming.has(f)).sort();
    assert.deepEqual(stale, [], `IDENTITY_FILES lists files that no longer name ${CC}; delete the entries:\n${stale.join("\n")}`);
    for (const [file, why] of Object.entries(IDENTITY_FILES)) assert.ok(why.length > 20, `${file} needs its reason`);
  });

  const UnsubscribeForm = (await import("../app/unsubscribe/UnsubscribeForm")).default;
  const rendered: Record<string, () => Promise<unknown> | unknown> = {
    "/privacy": (await import("../app/(marketing)/privacy/page")).default,
    "/terms": (await import("../app/(marketing)/terms/page")).default,
    "/dmca": (await import("../app/(marketing)/dmca/page")).default,
    "/unsubscribe": async () => (await import("../app/unsubscribe/page")).default({ searchParams: Promise.resolve({}) }),
  };
  for (const [path, page] of Object.entries(rendered)) {
    await check(`4. ${path} shows ${SUPPORT} and never CC's address`, async () => {
      const text = textOf(await page(), [], 0, new Set([UnsubscribeForm])).join("\n");
      assert.ok(text.includes(SUPPORT), `${path} does not show ${SUPPORT}`);
      assert.ok(!text.toLowerCase().includes(CC), `${path} shows ${CC}`);
    });
  }

  await check("4b. the manual opt-out writes to support@ with the subject an inbox check suppresses on", async () => {
    const { ManualOptOut, MANUAL_UNSUBSCRIBE_HREF } = await import("../app/unsubscribe/ManualOptOut");
    assert.equal(MANUAL_UNSUBSCRIBE_HREF, `mailto:${SUPPORT}?subject=unsubscribe`);
    const text = textOf(ReactNS.createElement(ManualOptOut, {})).join(" ");
    assert.ok(text.includes(SUPPORT) && !text.includes(CC));
  });

  await check("4c. the error help gives OASIS's clients support@, and a client's prospect no OASIS address at all", async () => {
    const { ErrorHelp } = await import("../components/ErrorHelp");
    const client = textOf(ReactNS.createElement(ErrorHelp, { digest: "d1" })).join(" ");
    assert.ok(client.includes(SUPPORT) && !client.includes(CC), client);
    const prospect = textOf(ReactNS.createElement(ErrorHelp, { digest: "d1", prospectFacing: true })).join(" ");
    assert.ok(!prospect.includes(SUPPORT) && !prospect.includes(CC), "a client's prospect is sent back to that business");
  });

  await check("5. client invoices name support@ as the seller contact; the business settings name CC nowhere", async () => {
    const { seedStatements, BUSINESS_ENTITY_ID } = await import("../lib/founders-finances/chart");
    const rows = seedStatements().filter((s) => /INSERT OR IGNORE INTO fin_settings/.test(s.sql) && s.args[0] === BUSINESS_ENTITY_ID);
    assert.equal(rows.length, 1, "exactly one seeded settings row for the business entity");
    // Pair each column with its value: a literal in the SQL, or the next bound arg for a "?".
    const m = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/.exec(rows[0].sql);
    assert.ok(m, "the settings seed keeps its column list");
    const columns = m[1].split(",").map((c) => c.trim());
    const values = m[2].split(",").map((v) => v.trim());
    let next = 0;
    const row = Object.fromEntries(columns.map((c, i) => [c, values[i] === "?" ? rows[0].args[next++] : values[i]]));
    assert.equal(row.contact_email, SUPPORT, "invoices-io.ts prints contact_email as the seller's email on every client invoice");
    for (const [column, value] of Object.entries(row)) {
      assert.ok(String(value).toLowerCase() !== CC, `${column} names CC's address`);
    }
  });

  if (failures > 0) {
    console.error(`support-address: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("support-address: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
