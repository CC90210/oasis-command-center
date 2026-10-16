/**
 * tests/consent-summary.test.ts - each consent box shows one summary line and
 * keeps the full disclosure one click away (CC, 2026-10-16: "remove the text
 * ... just make it a clickable link ... or drops it down").
 *
 * Proves: the summary keeps who / what / how to stop (and, for SMS, the rates
 * and STOP lines carriers expect at the opt-in); the full disclosure is still
 * in the page, collapsed, tied to the box by aria-describedby; the ledger
 * version marks the new presentation; and every public form renders consent
 * through the one component, so no form can show different terms.
 *
 * The component's element tree is walked directly, with no renderer: CI runs
 * every test with NODE_OPTIONS=--conditions=react-server, where
 * react-dom/server refuses to load.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import {
  CONSENT_DISCLOSURE_VERSION,
  consentDisclosureText,
  consentSummaryText,
  type ConsentIdentity,
} from "../lib/consent/ledger-disclosure";

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

const identity: ConsentIdentity = {
  businessName: "OASIS AI Solutions",
  address: "6993 Decarie Blvd, Montreal, QC H3W 0B5",
  privacyUrl: "https://oasisai.work/privacy",
};

type El = { type: unknown; props: Record<string, unknown> };

function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as El).props.children);
  return "";
}

async function main(): Promise<void> {
  // tsconfig.json sets jsx:"preserve", so tsx compiles components with the
  // classic runtime: React must be global before the component module loads.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { ConsentChoice } = await import("../components/forms/ConsentChoice");

  console.log("consent summary");

  check("the summary names who asks, what for and how to stop; the SMS line keeps rates and STOP", () => {
    const email = consentSummaryText("email", identity);
    const sms = consentSummaryText("sms", identity);
    assert.match(email, /OASIS AI Solutions may email me/);
    assert.match(email, /unsubscribe at any time/);
    assert.match(sms, /OASIS AI Solutions may text my mobile/);
    assert.match(sms, /Msg & data rates may apply/);
    assert.match(sms, /reply STOP to opt out/);
    for (const line of [email, sms]) {
      assert.ok(!line.includes(identity.address), "the address belongs under Full terms, not on the face of the form");
    }
  });

  check("the ledger version marks the collapsed presentation; the recorded wording is unchanged", () => {
    assert.equal(CONSENT_DISCLOSURE_VERSION, "occ-ledger-v2-2026-10-16");
    assert.match(consentDisclosureText("email", identity), /^I agree that OASIS AI Solutions \(6993 Decarie Blvd/);
  });

  check("each box shows the summary and keeps the full terms in the page, collapsed and tied to the box", () => {
    for (const channel of ["email", "sms"] as const) {
      const id = `c-${channel}`;
      const els = elements(ConsentChoice({ id, channel, identity, checked: false, onChange: () => undefined }));
      const one = (type: string) => {
        const found = els.filter((el) => el.type === type);
        assert.equal(found.length, 1, `${channel}: expected one <${type}>`);
        return found[0];
      };
      const input = one("input");
      const label = one("label");
      const details = one("details");
      const summary = one("summary");
      const terms = one("p");
      assert.equal(input.props.type, "checkbox");
      assert.equal(input.props["aria-describedby"], `${id}-terms`, `${channel}: the box is not tied to its terms`);
      assert.equal(label.props.htmlFor, id, `${channel}: the summary is not the box's label`);
      assert.equal(textOf(label), consentSummaryText(channel, identity), `${channel}: summary missing`);
      assert.ok(!details.props.open, `${channel}: the full terms are open by default`);
      assert.equal(textOf(summary).trim(), "Full terms", `${channel}: the Full terms link is missing`);
      assert.equal(terms.props.id, `${id}-terms`, `${channel}: the terms carry no id`);
      assert.equal(textOf(terms), consentDisclosureText(channel, identity), `${channel}: the full disclosure left the page`);
      // Legal text and its control keep AA contrast on light forms (Codex on #633).
      for (const el of els) {
        assert.doesNotMatch(String(el.props.className ?? ""), /text-fg-dim/, `${channel}: a consent element uses fg-dim`);
      }
    }
  });

  check("every public form renders consent through ConsentChoice, never its own copy of the terms", () => {
    for (const file of [
      "components/forms/FormPublicClient.tsx",
      "components/marketing/AuditForm.tsx",
      "components/booking/BookingPage.tsx",
    ]) {
      const src = readFileSync(file, "utf8");
      assert.match(src, /<ConsentChoice\b/, `${file} does not use ConsentChoice`);
      assert.doesNotMatch(src, /consentDisclosureText\(/, `${file} renders the disclosure itself`);
    }
  });

  console.log("consent-summary: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
