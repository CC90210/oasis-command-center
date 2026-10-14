import { createClient } from "@libsql/client";
import { expect, test, type Page } from "@playwright/test";
import {
  MONEY_BROWSER_AUTH_SECRET,
  MONEY_BROWSER_BASE_URL,
  MONEY_BROWSER_DB_FILE,
  MONEY_BROWSER_FOUNDER,
} from "./money-browser-fixture";
import { signFor } from "../_onboarding-fixture";

type CapturedAction = { action: string; body: Record<string, unknown> };

async function postAction(page: Page, action: string, click: () => Promise<void>) {
  const response = page.waitForResponse((candidate) => {
    if (candidate.request().method() !== "POST") return false;
    if (new URL(candidate.url()).pathname !== "/api/founders/finances/actions") return false;
    const body = candidate.request().postDataJSON() as Record<string, unknown>;
    return body.action === action;
  });
  await click();
  const result = await response;
  expect(result.status(), `${action} should succeed`).toBe(200);
  const json = (await result.json()) as Record<string, unknown>;
  expect(json.ok, `${action} should return ok`).toBe(true);
  return json;
}

async function waitForInvoicesPage(page: Page) {
  await page.goto("/founders/finances/invoices");
  await expect(page.getByRole("heading", { name: "Invoices", exact: true })).toBeVisible();
  await expect(page.locator("#new-invoice")).toBeVisible();
}

async function createDraft(
  page: Page,
  input: {
    customer: string;
    method: "wise" | "stripe" | "wise_stripe";
    oneTime: string;
    monthly?: string;
    label: string;
  },
) {
  const editor = page.locator("#new-invoice");
  const selectBeside = (label: string) =>
    editor.locator("label", { hasText: label }).locator("..").getByRole("combobox");

  const customerSelect = selectBeside("Customer");
  const customerValue = await customerSelect.locator("option", { hasText: input.customer }).getAttribute("value");
  expect(customerValue, `${input.customer} should be selectable`).toBeTruthy();
  await customerSelect.selectOption(customerValue!);
  const paymentMethod = selectBeside("How the client pays");
  await expect(paymentMethod).toBeEnabled();
  await paymentMethod.selectOption(input.method);

  const rows = editor.locator("tbody tr");
  await rows.nth(0).locator('input[placeholder="What was delivered"]').fill(`${input.label} implementation`);
  await rows.nth(0).locator('input[placeholder="0.00"]').fill(input.oneTime);

  if (input.monthly) {
    await editor.getByRole("button", { name: "Add line" }).click();
    await expect(rows).toHaveCount(2);
    await rows.nth(1).locator('input[placeholder="What was delivered"]').fill(`${input.label} monthly retainer`);
    await rows.nth(1).locator('input[placeholder="0.00"]').fill(input.monthly);
    await rows.nth(1).getByRole("button", { name: "Monthly", exact: true }).click();
  }

  const result = await postAction(page, "invoice.create", () =>
    editor.getByRole("button", { name: "Create draft" }).click(),
  );
  await expect(page).toHaveURL(/\/founders\/finances\/invoices\/[^/]+$/, { timeout: 45_000 });
  return String(result.id);
}

test("Money customer lifecycle and payment-mode drafts stay side-effect free", async ({ browser }) => {
  process.env.AUTH_SESSION_SECRET = MONEY_BROWSER_AUTH_SECRET;
  const context = await browser.newContext();
  const externalRequests: string[] = [];
  const capturedActions: CapturedAction[] = [];

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  context.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== "/api/founders/finances/actions") return;
    const body = request.postDataJSON() as Record<string, unknown>;
    capturedActions.push({ action: String(body.action), body });
  });

  const session = await signFor(MONEY_BROWSER_FOUNDER, "done");
  await context.addCookies([
    {
      name: "oasis_session",
      value: session,
      url: MONEY_BROWSER_BASE_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  await waitForInvoicesPage(page);

  const addForm = page.getByRole("button", { name: "Add customer" }).locator("xpath=ancestor::form");
  await addForm.locator('input[name="name"]').fill("Browser Fixture Co");
  await addForm.locator('input[name="email"]').fill("billing@browser-fixture.test");
  await addForm.locator('input[name="company"]').fill("Browser Fixture Holdings");
  await addForm.locator('input[name="address"]').fill("100 Test Loop, Montreal QC");
  await postAction(page, "contact.create", () => addForm.getByRole("button", { name: "Add customer" }).click());
  await expect(page.getByRole("button", { name: "Edit Browser Fixture Co" })).toBeVisible();

  await page.getByRole("button", { name: "Edit Browser Fixture Co" }).click();
  const editForm = page.getByRole("button", { name: "Save customer" }).locator("xpath=ancestor::form");
  await editForm.locator('input[name="name"]').fill("Browser Fixture Company");
  await editForm.locator('input[name="company"]').fill("Browser Fixture Group");
  await postAction(page, "contact.update", () => editForm.getByRole("button", { name: "Save customer" }).click());
  await expect(page.getByRole("button", { name: "Edit Browser Fixture Company" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await postAction(page, "contact.archive", () =>
    page.getByRole("button", { name: "Archive Browser Fixture Company" }).click(),
  );
  await expect(page.getByRole("button", { name: "Edit Browser Fixture Company" })).toHaveCount(0);
  await page.getByText(/^Archived \(1\)$/).click();
  await postAction(page, "contact.restore", () =>
    page.getByRole("button", { name: "Restore Browser Fixture Company" }).click(),
  );
  await expect(page.getByRole("button", { name: "Edit Browser Fixture Company" })).toBeVisible();

  const firstInvoiceAction = capturedActions.findIndex(({ action }) => action === "invoice.create");
  expect(firstInvoiceAction).toBe(-1);
  expect(capturedActions.map(({ action }) => action)).toEqual([
    "contact.create",
    "contact.update",
    "contact.archive",
    "contact.restore",
  ]);

  const wiseDraft = await createDraft(page, {
    customer: "Browser Fixture Company",
    method: "wise",
    oneTime: "1500.00",
    label: "Wise-only",
  });
  await waitForInvoicesPage(page);
  const stripeDraft = await createDraft(page, {
    customer: "Browser Fixture Company",
    method: "stripe",
    oneTime: "2500.00",
    label: "Stripe-only",
  });
  await waitForInvoicesPage(page);
  const hybridDraft = await createDraft(page, {
    customer: "Browser Fixture Company",
    method: "wise_stripe",
    oneTime: "7500.00",
    monthly: "3500.00",
    label: "Hybrid",
  });

  const db = createClient({ url: `file:${MONEY_BROWSER_DB_FILE}` });
  const invoices = await db.execute({
    sql: `SELECT id, number, status, payment_method, total_cents, retainer_monthly_cents,
                 stripe_price_id, stripe_payment_link_id, stripe_payment_link_url,
                 stripe_retainer_product_id, stripe_retainer_price_id,
                 stripe_retainer_price_cents, stripe_retainer_price_currency,
                 stripe_retainer_link_id, stripe_retainer_link_url,
                 stripe_retainer_link_cents, stripe_retainer_link_currency
            FROM fin_invoices ORDER BY created_at, id`,
    args: [],
  });
  expect(invoices.rows).toHaveLength(3);
  expect(invoices.rows.map((row) => row.id)).toEqual([wiseDraft, stripeDraft, hybridDraft]);
  expect(invoices.rows.map((row) => row.payment_method)).toEqual(["wise", "stripe", "wise_stripe"]);
  expect(invoices.rows.map((row) => row.status)).toEqual(["draft", "draft", "draft"]);
  expect(invoices.rows.map((row) => row.number)).toEqual([null, null, null]);
  expect(invoices.rows.map((row) => Number(row.total_cents))).toEqual([150_000, 250_000, 750_000]);
  expect(invoices.rows.map((row) => Number(row.retainer_monthly_cents))).toEqual([0, 0, 350_000]);

  const stripeColumns = [
    "stripe_price_id",
    "stripe_payment_link_id",
    "stripe_payment_link_url",
    "stripe_retainer_product_id",
    "stripe_retainer_price_id",
    "stripe_retainer_price_cents",
    "stripe_retainer_price_currency",
    "stripe_retainer_link_id",
    "stripe_retainer_link_url",
    "stripe_retainer_link_cents",
    "stripe_retainer_link_currency",
  ] as const;
  for (const row of invoices.rows) {
    for (const column of stripeColumns) expect(row[column], `${row.id}.${column}`).toBeNull();
  }

  const lines = await db.execute({
    sql: `SELECT invoice_id, billing, amount_cents FROM fin_invoice_lines ORDER BY invoice_id, line_no`,
    args: [],
  });
  const hybridLines = lines.rows
    .filter((row) => row.invoice_id === hybridDraft)
    .map((row) => [row.billing, Number(row.amount_cents)]);
  expect(hybridLines).toEqual([
    ["one_time", 750_000],
    ["monthly", 350_000],
  ]);

  const effects = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM fin_payments) AS payments,
            (SELECT COUNT(*) FROM fin_journal_entries) AS journals,
            (SELECT COUNT(*) FROM fin_stripe_events) AS stripe_events,
            (SELECT invoice_next_number FROM fin_settings WHERE entity_id = 'fin_ent_oasis') AS invoice_next_number`,
    args: [],
  });
  expect(effects.rows[0]).toMatchObject({
    payments: 0,
    journals: 0,
    stripe_events: 0,
    invoice_next_number: 1,
  });

  expect(capturedActions.map(({ action }) => action)).toEqual([
    "contact.create",
    "contact.update",
    "contact.archive",
    "contact.restore",
    "invoice.create",
    "invoice.create",
    "invoice.create",
  ]);
  for (const forbidden of ["invoice.finalize", "invoice.send", "invoice.mark_paid", "invoice.void"]) {
    expect(capturedActions.some(({ action }) => action === forbidden), `${forbidden} must never be called`).toBe(false);
  }
  expect(externalRequests, "the browser must not contact a non-loopback host").toEqual([]);

  db.close();
  await context.close();
});
