/**
 * verified-mailboxes.test.ts - every oasisai.work address the product publishes
 * is a mailbox somebody reads.
 *
 * WHY. For months /privacy, /terms, /dmca, Settings > Data & privacy and the
 * privacy manifest told people to write to privacy@, legal@, dmca@ and
 * support@oasisai.work, and /unsubscribe told them to write to unsubscribe@.
 * None of the five existed (CC, 2026-09-30; Gmail send-as lists only conaugh@,
 * and no message had ever reached any of them). A Law 25 access request, a DMCA
 * takedown or a CASL opt-out sent there bounced, while the policy promised an
 * answer within 30 days. So an address is published only if it is in
 * config/verified-mailboxes.json, and this test is what enforces it:
 *
 *   1. LEGAL_CONTACTS, PRIVACY_OFFICER.email and CONTACT_EMAIL are verified.
 *   2. Every literal mailto: to an oasisai.work address in app/, components/
 *      and lib/ is verified.
 *   3. No role alias (privacy@, legal@, dmca@, support@, unsubscribe@, info@...)
 *      appears anywhere in app/, components/, lib/ or docs/compliance unless it
 *      is verified. Personal addresses (a teammate's own login) are identity
 *      keys, not published contacts, and are not this test's business.
 *   4. Every address in docs/compliance/*.json is verified.
 *   5. The rendered /privacy, /terms, /dmca and /unsubscribe pages (the page
 *      components themselves, not their source) show at least one oasisai.work
 *      address, and every one they show is verified.
 *
 * To publish a new address: create it in Google Workspace, send it a test
 * message, add it to config/verified-mailboxes.json, then use it.
 *
 * Run: node --conditions=react-server --import tsx tests/verified-mailboxes.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";

const ROOT = join(__dirname, "..");

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

const config = JSON.parse(readFileSync(join(ROOT, "config/verified-mailboxes.json"), "utf8")) as { mailboxes: string[] };
const VERIFIED = new Set(config.mailboxes);

const DOMAIN_ADDRESS = /[a-z0-9._%+-]+@oasisai\.work/gi;
const ROLE_ALIAS =
  /\b(?:privacy|legal|dmca|support|unsubscribe|info|hello|contact|help|billing|admin|security|abuse|noreply|no-reply|team|sales|office|accounts|finance|compliance|press)@oasisai\.work\b/gi;

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

/** Strings and href/props reachable in a server-rendered element tree. */
function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function") {
      textOf((node.type as (p: unknown) => unknown)(props), out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v, out, depth + 1);
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main() {
  console.log("verified-mailboxes:");

  await check("the verified list is lowercase oasisai.work addresses, no role aliases unless deliberate", () => {
    assert.ok(config.mailboxes.length > 0, "config/verified-mailboxes.json lists no mailbox");
    for (const m of config.mailboxes) {
      assert.equal(m, m.toLowerCase(), `${m} must be lowercase`);
      assert.match(m, /^[a-z0-9._%+-]+@oasisai\.work$/, `${m} is not an oasisai.work address`);
    }
  });

  const legal = await import("../lib/legal/constants");
  const { CONTACT_EMAIL } = await import("../lib/marketing/routes");

  await check("1. every legal contact, the privacy officer and CONTACT_EMAIL are verified inboxes", () => {
    for (const [role, address] of Object.entries(legal.LEGAL_CONTACTS)) {
      assert.ok(VERIFIED.has(address), `LEGAL_CONTACTS.${role} = ${address} is not in config/verified-mailboxes.json`);
    }
    assert.ok(VERIFIED.has(legal.PRIVACY_OFFICER.email), `PRIVACY_OFFICER.email = ${legal.PRIVACY_OFFICER.email} is not verified`);
    assert.ok(VERIFIED.has(CONTACT_EMAIL), `CONTACT_EMAIL = ${CONTACT_EMAIL} is not verified`);
  });

  const source = ["app", "components", "lib"].flatMap((d) => files(join(ROOT, d)));

  await check("2. every literal mailto: to an oasisai.work address is verified", () => {
    const bad: string[] = [];
    for (const f of source) {
      for (const m of readFileSync(f, "utf8").matchAll(/mailto:([a-z0-9._%+-]+@oasisai\.work)/gi)) {
        if (!VERIFIED.has(m[1].toLowerCase())) bad.push(`${rel(f)}: mailto:${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], `unverified mailto targets:\n${bad.join("\n")}`);
  });

  await check("3. no role alias at oasisai.work appears unless it is verified", () => {
    const scanned = [...source, ...files(join(ROOT, "docs/compliance"))];
    const bad: string[] = [];
    for (const f of scanned) {
      for (const m of readFileSync(f, "utf8").matchAll(ROLE_ALIAS)) {
        if (!VERIFIED.has(m[0].toLowerCase())) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    assert.deepEqual(bad, [], `unverified role aliases:\n${bad.join("\n")}`);
  });

  await check("4. every address in docs/compliance/*.json is verified", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of files(join(ROOT, "docs/compliance")).filter((p) => p.endsWith(".json"))) {
      for (const m of readFileSync(f, "utf8").matchAll(DOMAIN_ADDRESS)) {
        seen += 1;
        if (!VERIFIED.has(m[0].toLowerCase())) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    assert.ok(seen > 0, "the privacy manifest publishes a contact; finding none means this scan is broken");
    assert.deepEqual(bad, [], `unverified addresses in the compliance manifests:\n${bad.join("\n")}`);
  });

  const rendered: Record<string, () => Promise<unknown> | unknown> = {
    "/privacy": (await import("../app/(marketing)/privacy/page")).default,
    "/terms": (await import("../app/(marketing)/terms/page")).default,
    "/dmca": (await import("../app/(marketing)/dmca/page")).default,
    "/unsubscribe": async () =>
      (await import("../app/unsubscribe/page")).default({ searchParams: Promise.resolve({}) }),
  };
  for (const [path, page] of Object.entries(rendered)) {
    await check(`5. ${path} renders only verified oasisai.work addresses`, async () => {
      const text = textOf(await page()).join("\n");
      const found = [...text.matchAll(DOMAIN_ADDRESS)].map((m) => m[0].toLowerCase());
      assert.ok(found.length > 0, `${path} rendered no oasisai.work address at all; the page must name a contact`);
      const bad = [...new Set(found.filter((a) => !VERIFIED.has(a)))];
      assert.deepEqual(bad, [], `${path} renders unverified addresses: ${bad.join(", ")}`);
    });
  }

  await check("5b. the manual opt-out writes to a verified inbox with the subject BEA suppresses on", async () => {
    const { ManualOptOut, MANUAL_UNSUBSCRIBE_HREF } = await import("../app/unsubscribe/ManualOptOut");
    assert.match(MANUAL_UNSUBSCRIBE_HREF, /^mailto:([^?]+)\?subject=unsubscribe$/);
    const target = MANUAL_UNSUBSCRIBE_HREF.slice("mailto:".length).split("?")[0];
    assert.ok(VERIFIED.has(target), `${target} is not verified`);
    const text = textOf(ReactNS.createElement(ManualOptOut, {})).join(" ");
    assert.ok(text.includes(target), "the address is shown as text too, for a reader whose mail client ignores mailto:");
    assert.ok(text.includes(MANUAL_UNSUBSCRIBE_HREF));
  });

  if (failures > 0) {
    console.error(`verified-mailboxes: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("verified-mailboxes: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
