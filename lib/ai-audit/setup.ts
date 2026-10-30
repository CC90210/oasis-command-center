/**
 * lib/ai-audit/setup.ts — is the Free AI Audit ready to run, in words CC can
 * act on (CC, 2026-10-27: "ensure that it's 100% turnkey"). Shown on the board
 * and on the settings page.
 *
 * Read-only. Each line asks the question the step itself asks, so this list
 * cannot say "ready" while the step refuses: the delivery gate (link secret,
 * Stripe, the stored PDF, the mailbox), the Pay button (its switch and Stripe),
 * the Mac that prints the PDF, the independently gated model/search workers,
 * the confirmed prices and the tax rule a proposal needs. A key is only ever
 * "set" or "not set": no
 * value is read back to the page.
 *
 * Each check stands alone: one that fails to read says so, the rest answer.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { isDryRun } from "@/lib/integrations/send-mode";
import { aiAuditLinkSecret, aiAuditModelSearchEnabled, MODEL_SEARCH_SWITCH } from "@/lib/ai-audit/env";
import { r2Configured } from "@/lib/r2-storage";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { oasisSharedMailboxConfigured } from "@/lib/integrations/oasis-shared-gmail-send";
import { liveRunnerForTool } from "@/lib/tools/store";
import { RUNNER_LIVE_MINUTES } from "@/lib/tools/limits";
import { listCatalogue } from "@/lib/ai-audit/catalogue-store";
import { getSettings } from "@/lib/ai-audit/store";
import { DRY_RUN_CHANNEL as PAY_CHANNEL } from "@/lib/ai-audit/payment";
import { AUDIT_EMAIL_CHANNEL } from "@/lib/ai-audit/delivery-payload";
import { formatOperatorDate } from "@/lib/dates";

export type SetupState = "ready" | "test_mode" | "deferred" | "missing" | "unknown";

export type SetupCheck = {
  key: "prices" | "tax" | "mac" | "model_search" | "pdf_storage" | "link_secret" | "mailbox" | "stripe" | "audit_email" | "payments";
  label: string;
  state: SetupState;
  detail: string;
  link?: { href: string; label: string };
};

export type SetupDeps = {
  isDryRun: (channel: string) => boolean;
  linkSecretSet: () => boolean;
  pdfStorageSet: () => boolean;
  stripeConnected: (tenantId: string) => Promise<boolean>;
  mailboxConnected: (tenantId: string) => Promise<boolean>;
  runnerFor: (db: Client, tenantId: string, tool: string, now: Date) => Promise<{ label: string; lastSeenAt: string } | null>;
  modelSearchEnabled: () => boolean;
};

export function defaultSetupDeps(): SetupDeps {
  return {
    isDryRun,
    linkSecretSet: () => aiAuditLinkSecret() !== null,
    pdfStorageSet: r2Configured,
    stripeConnected: async (tenantId) => !!(await getTenantIntegrationValue(tenantId, "stripe", "secret_key")),
    mailboxConnected: oasisSharedMailboxConfigured,
    runnerFor: liveRunnerForTool,
    modelSearchEnabled: aiAuditModelSearchEnabled,
  };
}

const CONNECTIONS = { href: "/settings/connections", label: "Open Connections" };

/** What the Mac's AI audit runner serves: the PDF for every audit; the model and the web search for Claude on the Mac. */
const MAC_TOOLS = ["ai_audit_pdf", "ai_audit_model", "ai_audit_search"] as const;

async function attempt<T>(what: string, f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await f() };
  } catch (err) {
    console.error(`[ai-audit.setup] the ${what} check could not be read`, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return { ok: false };
  }
}

function unknown(key: SetupCheck["key"], label: string): SetupCheck {
  return { key, label, state: "unknown", detail: "Could not be checked just now. Reload the page; the error was logged." };
}

export async function setupChecks(db: Client, tenantId: string, now: Date, deps: SetupDeps = defaultSetupDeps()): Promise<SetupCheck[]> {
  const [catalogue, settings, runner, stripe, mailbox] = await Promise.all([
    attempt("catalogue", () => listCatalogue(db, tenantId)),
    attempt("settings", () => getSettings(db, tenantId)),
    // Each tool the Mac row speaks for, on its own: one runner may serve the PDF and not the model (CodeRabbit on #749).
    attempt("Mac runner", () => Promise.all(MAC_TOOLS.map((tool) => deps.runnerFor(db, tenantId, tool, now)))),
    attempt("Stripe", () => deps.stripeConnected(tenantId)),
    attempt("mailbox", () => deps.mailboxConnected(tenantId)),
  ]);
  const checks: SetupCheck[] = [];
  const modelSearchEnabled = deps.modelSearchEnabled();

  if (!catalogue.ok) checks.push(unknown("prices", "Prices"));
  else {
    const confirmed = catalogue.value.filter((i) => i.status === "confirmed").length;
    const proposed = catalogue.value.filter((i) => i.status === "proposed").length;
    const waiting = proposed ? `${proposed} proposed price${proposed === 1 ? " is" : "s are"} waiting for you to confirm.` : "";
    checks.push(
      confirmed
        ? { key: "prices", label: "Prices", state: "ready", detail: `${confirmed} confirmed.${waiting ? ` ${waiting}` : ""}`, link: { href: "/ai-audits/catalogue", label: "Open the catalogue" } }
        : {
            key: "prices",
            label: "Prices",
            state: "missing",
            detail: proposed
              ? `None confirmed yet. ${waiting} Until then every proposal line waits as "needs your price".`
              : "The catalogue is empty. Seed it from the existing price files, then confirm each price.",
            link: { href: "/ai-audits/catalogue", label: "Open the catalogue" },
          },
    );
  }

  if (!settings.ok) checks.push(unknown("tax", "Tax rule"));
  else {
    const tax = settings.value.settings.tax;
    checks.push(
      tax
        ? {
            key: "tax",
            label: "Tax rule",
            state: "ready",
            detail: tax.mode === "registered" ? `Registered: ${tax.label} ${(tax.rate_bps / 100).toFixed(2)}%.` : "Not registered: no tax is added.",
            link: { href: "/ai-audits/settings", label: "Change it" },
          }
        : { key: "tax", label: "Tax rule", state: "missing", detail: "Not set. No proposal can go to final approval until it is.", link: { href: "/ai-audits/settings", label: "Set it" } },
    );
  }

  if (!runner.ok) checks.push(unknown("mac", "PDF printer"));
  else {
    const [pdf] = runner.value;
    if (!pdf) {
      checks.push({
        key: "mac",
        label: "PDF printer",
        state: "missing",
        detail: `The Mac has not checked in for over ${RUNNER_LIVE_MINUTES} minutes, so PDFs wait. Wake the Mac, or start its AI audit runner.`,
      });
    } else {
      const seen = new Date(pdf.lastSeenAt);
      const at = Number.isNaN(seen.getTime()) ? pdf.lastSeenAt : formatOperatorDate({ hour: "numeric", minute: "2-digit" }, seen);
      checks.push({ key: "mac", label: "PDF printer", state: "ready", detail: `Online (${pdf.label}, checked in at ${at}). It prints each audit's PDF.` });
    }
  }

  if (!modelSearchEnabled) {
    checks.push({
      key: "model_search",
      label: "Model and web search",
      state: "deferred",
      detail: `Deferred: ${MODEL_SEARCH_SWITCH} is off. Website checks, PageSpeed, evidence rules, audit and proposal drafting, and PDF printing keep running.`,
    });
  } else if (!settings.ok) checks.push(unknown("model_search", "Model and web search"));
  else if (settings.value.settings.engine === "none") {
    checks.push({ key: "model_search", label: "Model and web search", state: "deferred", detail: "Deferred by default: this workspace's audit engine is No AI. Deterministic audit and PDF work keeps running." });
  } else if (settings.value.settings.engine === "cloud_workspace") {
    checks.push({ key: "model_search", label: "Model and web search", state: "ready", detail: "The workspace cloud model is enabled. Mac-only web search is not used for this default." });
  } else if (!runner.ok) checks.push(unknown("model_search", "Model and web search"));
  else {
    const [, model, search] = runner.value;
    const lacking = [...(model ? [] : ["reading calls and writing (ai_audit_model)"]), ...(search ? [] : ["web search (ai_audit_search)"])];
    checks.push(
      lacking.length
        ? { key: "model_search", label: "Model and web search", state: "missing", detail: `Enabled, but no live runner offers ${lacking.join(" or ")}. Update the Mac's AI audit runner.` }
        : { key: "model_search", label: "Model and web search", state: "ready", detail: "Enabled, and the Mac runner offers both model work and web search." },
    );
  }

  checks.push(
    deps.pdfStorageSet()
      ? { key: "pdf_storage", label: "PDF storage", state: "ready", detail: "Set up." }
      : { key: "pdf_storage", label: "PDF storage", state: "missing", detail: "Not set up on this deployment, so a printed PDF has nowhere to go and no audit can be sent." },
  );
  checks.push(
    deps.linkSecretSet()
      ? { key: "link_secret", label: "Private links", state: "ready", detail: "Set up." }
      : { key: "link_secret", label: "Private links", state: "missing", detail: "AI_AUDIT_LINK_SECRET is not set on this deployment, so no client link can be made and no audit can be sent." },
  );

  if (!mailbox.ok) checks.push(unknown("mailbox", "Mailbox"));
  else
    checks.push(
      mailbox.value
        ? { key: "mailbox", label: "Mailbox", state: "ready", detail: "The OASIS mailbox is connected." }
        : { key: "mailbox", label: "Mailbox", state: "missing", detail: "The OASIS mailbox is not connected, so the audit email cannot go out.", link: CONNECTIONS },
    );

  if (!stripe.ok) checks.push(unknown("stripe", "Stripe"));
  else
    checks.push(
      stripe.value
        ? { key: "stripe", label: "Stripe", state: "ready", detail: "Connected." }
        : { key: "stripe", label: "Stripe", state: "missing", detail: "Not connected, so a client could not pay, and the final approval refuses to send the audit.", link: CONNECTIONS },
    );

  checks.push(
    deps.isDryRun(AUDIT_EMAIL_CHANNEL)
      ? {
          key: "audit_email",
          label: "Emails to clients",
          state: "test_mode",
          detail: "Approving the final card records a test run and emails nobody. It goes live when LIVE_SEND_AI_AUDIT=1 is set on the server and the BRAVO_FORCE_DRY_RUN kill switch is off.",
        }
      : { key: "audit_email", label: "Emails to clients", state: "ready", detail: "Live: an approved audit is emailed to the client." },
  );
  checks.push(
    deps.isDryRun(PAY_CHANNEL)
      ? {
          key: "payments",
          label: "Client payments",
          state: "test_mode",
          detail: "The Pay button opens no checkout, so no client can pay yet. It goes live when LIVE_SEND_STRIPE_CHECKOUT=1 is set on the server and the BRAVO_FORCE_DRY_RUN kill switch is off. Until then a client who presses Pay is told payment is not open yet, and you get an alert.",
        }
      : { key: "payments", label: "Client payments", state: "ready", detail: "Live: the Pay button opens Stripe's checkout." },
  );
  return checks;
}
