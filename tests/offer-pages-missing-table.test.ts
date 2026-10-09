/**
 * offer-pages-missing-table.test.ts - everything works before Bravo applies
 * migration bravo__203 (design section 3.6, "When the migration has not run
 * yet").
 *
 * The code ships before the table exists. Until it does:
 *   - every public form renders exactly its plain form page (the page returns
 *     FormPublicClient), with no 500, and "[offer-pages] table missing" is
 *     logged ONCE per isolate, never the generic "page layer failed";
 *   - the Offers list renders, with every form an intake form;
 *   - the editor opens the form's own builder;
 *   - the builder routes answer 503 offer_pages_unavailable (not a 500);
 *   - deleting a form still works;
 *   - a new lead's offer alert reads "not an offer" and sends nothing.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-missing-table.test.ts
 */
import { OASIS, USERS, done, formRow, login, setupOfferDatabase, step, stubPath, CONTACT_STEPS, ROOT } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
stubPath(require.resolve("next/link"), {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
});
const marker = (name: string) => Object.assign(() => null, { displayName: name });
const FormsListMarker = marker("FormsListClient");
const FormBuilderMarker = marker("FormBuilderClient");
const OfferBuilderMarker = marker("OfferBuilder");
const TurnIntoOfferMarker = marker("TurnIntoOffer");
stubPath(join(ROOT, "components", "forms", "FormsListClient.tsx"), { FormsListClient: FormsListMarker });
stubPath(join(ROOT, "components", "forms", "FormBuilderClient.tsx"), { FormBuilderClient: FormBuilderMarker });
stubPath(join(ROOT, "components", "forms", "SunBizFormsClient.tsx"), { SunBizFormsClient: marker("SunBizFormsClient") });
stubPath(join(ROOT, "components", "offer-pages", "builder", "OfferBuilder.tsx"), { OfferBuilder: OfferBuilderMarker });
stubPath(join(ROOT, "components", "offer-pages", "builder", "TurnIntoOffer.tsx"), { TurnIntoOffer: TurnIntoOfferMarker });

const logs: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};

const FORM = "f0a1d170-0000-4000-8000-00000000000b";

function find(node: unknown, type: unknown, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = find(v, type, seen);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (el.type === type) return el.props;
    return find(el.props, type, seen);
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = find(v, type, seen);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const db = await setupOfferDatabase({ migrate: false });
  await db.batch([formRow(FORM, OASIS, "growth", "Growth", CONTACT_STEPS, { headline: "Grow" })], "write");
  const { FormPublicClient } = await import("../components/forms/FormPublicClient");
  const { OfferPage } = await import("../components/offer-pages/OfferPage");
  const publicPage = await import("../app/f/[tenant_slug]/[form_slug]/page");
  const params = { params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: "growth" }), searchParams: Promise.resolve({}) };

  console.log("offer-pages-missing-table:");
  const log = (s: string) => process.stdout.write(`${s}\n`);

  await step("the public page renders the plain form, three times over, and logs the missing table once", async () => {
    for (let i = 0; i < 3; i++) {
      const tree = await publicPage.default(params);
      const el = tree as { type?: unknown; props?: Record<string, unknown> };
      assert.equal(el.type, FormPublicClient, "not the plain form");
      assert.equal(find(tree, OfferPage), null);
      assert.equal(el.props?.chrome, undefined, "the plain form carries no offer props");
    }
    const meta = await publicPage.generateMetadata({ params: params.params });
    assert.deepEqual(meta.robots, { index: false, follow: false });
    assert.equal(meta.title, "Grow");
    assert.equal(logs.filter((l) => l.includes("[offer-pages] table missing")).length, 1, logs.join("\n"));
    assert.equal(logs.filter((l) => /page layer failed|live page unreadable/.test(l)).length, 0, logs.join("\n"));
  });

  await step("the Offers list renders with every form an intake form", async () => {
    await login(USERS.cc);
    const tree = await (await import("../app/forms/page")).default();
    const props = find(tree, FormsListMarker) as { offers: unknown; initialRows: Array<{ id: string }> } | null;
    assert.ok(props, "the list is mounted");
    assert.equal(props.offers, null, "offer pages read as not available");
    assert.ok(props.initialRows.some((r) => r.id === FORM));
  });

  await step("the editor opens the form's own builder, with no offer controls", async () => {
    await login(USERS.cc);
    const tree = await (await import("../app/forms/[id]/edit/page")).default({ params: Promise.resolve({ id: FORM }) });
    assert.equal((find(tree, FormBuilderMarker) as { initialForm: { id: string } } | null)?.initialForm.id, FORM);
    assert.equal(find(tree, OfferBuilderMarker), null);
    assert.equal(find(tree, TurnIntoOfferMarker), null, "Turn into an offer is offered before the table exists");
  });

  await step("the builder routes answer 503 offer_pages_unavailable, never a 500", async () => {
    await login(USERS.cc);
    const { NextRequest } = await import("next/server");
    const route = await import("../app/api/forms/[id]/offer/route");
    const get = await route.GET(new NextRequest(`http://localhost/api/forms/${FORM}/offer`), { params: Promise.resolve({ id: FORM }) });
    assert.equal(get.status, 503);
    assert.equal(((await get.json()) as { error: string }).error, "offer_pages_unavailable");
    const put = await route.PUT(
      new NextRequest(`http://localhost/api/forms/${FORM}/offer`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: "book_call" }) }),
      { params: Promise.resolve({ id: FORM }) },
    );
    assert.equal(put.status, 503);
  });

  await step("a new lead's offer alert reads 'not an offer' and sends nothing", async () => {
    const { notifyOfferLead } = await import("../lib/offer-pages/notify");
    const { offerPagesDb } = await import("../lib/offer-pages/store");
    const { getServiceSupabase } = await import("../lib/supabase-server");
    let pushed = 0;
    const r = await notifyOfferLead({
      db: getServiceSupabase(),
      offers: offerPagesDb(),
      tenantId: OASIS,
      formId: FORM,
      formName: "Growth",
      leadId: "lead-x",
      submissionId: "sub-x",
      answers: {},
      push: async () => {
        pushed += 1;
        return { delivered: true, outcome: "Sent to Telegram" };
      },
    });
    assert.equal(r, "not_offer");
    assert.equal(pushed, 0);
  });

  await step("deleting a form still works", async () => {
    await login(USERS.cc);
    const { NextRequest } = await import("next/server");
    const route = await import("../app/api/forms/[id]/route");
    const res = await route.DELETE(new NextRequest(`http://localhost/api/forms/${FORM}`, { method: "DELETE" }), { params: Promise.resolve({ id: FORM }) });
    assert.equal(res.status, 200, await res.text());
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM forms WHERE id = ?", args: [FORM] })).rows[0].n, 0);
  });

  log(`(console.error lines seen: ${logs.length})`);
  console.error = realError;
  done("offer-pages-missing-table");
}

main().catch((err) => {
  console.error = realError;
  console.error(err);
  process.exit(1);
});
