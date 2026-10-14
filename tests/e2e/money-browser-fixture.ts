import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { seedStatements } from "../../lib/founders-finances/chart";
import {
  OASIS,
  SECRET as ONBOARDING_AUTH_SECRET,
  createBaseSchema,
  seedAuthUser,
  seedProfile,
  seedTenant,
  type SeedUser,
} from "../_onboarding-fixture";

const ROOT = resolve(__dirname, "../..");
const WORKTREE_KEY = createHash("sha256").update(ROOT).digest("hex").slice(0, 12);
const FIXTURE_DIR = join(tmpdir(), `oasis-money-browser-${WORKTREE_KEY}`);

export const MONEY_BROWSER_BASE_URL = "http://127.0.0.1:3117";
export const MONEY_BROWSER_DB_FILE = join(FIXTURE_DIR, "money-browser.db");
export const MONEY_BROWSER_AUTH_SECRET = ONBOARDING_AUTH_SECRET;
export const MONEY_BROWSER_TENANT_ID = OASIS;
export const MONEY_BROWSER_FOUNDER: SeedUser = {
  id: "0b000000-0000-4000-8000-000000000001",
  email: "conaugh@oasisai.work",
  name: "CC Browser Fixture",
};

const FINANCE_MIGRATIONS = [
  "180_founders_finances.turso.sql",
  "184_finance_wise_payments.turso.sql",
  "185_finance_invoice_retainer.turso.sql",
  "bravo__190_ledger_core.sql",
  "bravo__193_stripe_payouts.sql",
  "bravo__226_finance_invoice_send_claim.sql",
] as const;

const SHELL_SUPPORT_MIGRATIONS = [
  "bravo__187_os_connections.sql",
  "bravo__205_tenant_integration_checks.sql",
  "bravo__209_connection_vendor_principal.sql",
] as const;

/**
 * Blank every credential a draft-render could otherwise inherit from the
 * developer's shell or a Next dotenv file. Empty strings are deliberate:
 * dotenv does not replace variables already present in the child process.
 */
const BLANK_PROVIDER_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_FINANCE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "WISE_API_TOKEN",
  "WISE_PROFILE_ID",
  "INVOICE_FROM_EMAIL",
  "INVOICE_FROM_APP_PASSWORD",
  "INVOICE_FROM_NAME",
  "OASIS_MAIL_FROM",
  "OASIS_MAIL_APP_PASSWORD",
  "SUPPORT_GMAIL_USER",
  "SUPPORT_GMAIL_APP_PASSWORD",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "AUTH_SMTP_HOST",
  "AUTH_SMTP_PORT",
  "AUTH_SMTP_USER",
  "AUTH_SMTP_PASSWORD",
  "AUTH_SMTP_PASS",
  "AUTH_FROM_EMAIL",
  "RESEND_API_KEY",
  "SENDGRID_API_KEY",
  "MAILGUN_API_KEY",
  "POSTMARK_SERVER_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "PLATFORM_DEFAULT_OPENAI_API_KEY",
  "PLATFORM_DEFAULT_ANTHROPIC_API_KEY",
  "PLATFORM_DEFAULT_GOOGLE_API_KEY",
  "PLATFORM_DEFAULT_OPENROUTER_API_KEY",
  "BRAVO_SUPABASE_URL",
  "BRAVO_SUPABASE_SERVICE_ROLE_KEY",
  "BRAVO_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "TURSO_DATABASE_URL",
  "TURSO_DB_URL",
  "TURSO_AUTH_TOKEN",
] as const;

export function moneyBrowserServerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    EMPIRE_DATA_BACKEND: "turso_cloud",
    EMPIRE_AUTH_BACKEND: "turso",
    AUTH_SESSION_SECRET: MONEY_BROWSER_AUTH_SECRET,
    FOUNDERS_TENANT_IDS: MONEY_BROWSER_TENANT_ID,
    TURSO_DB_PATH: MONEY_BROWSER_DB_FILE,
    OPERATOR_EMAIL_FALLBACK_ENABLED: "false",
    DEPLOY_SURFACE: "oasis",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const key of BLANK_PROVIDER_ENV) env[key] = "";
  return env;
}

function resetFixtureDatabase(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const fixtureRoot = resolve(FIXTURE_DIR);
  for (const suffix of ["", "-shm", "-wal", "-journal"]) {
    const target = resolve(`${MONEY_BROWSER_DB_FILE}${suffix}`);
    if (!target.startsWith(`${fixtureRoot}\\`) && !target.startsWith(`${fixtureRoot}/`)) {
      throw new Error(`refusing to clear fixture path outside ${fixtureRoot}: ${target}`);
    }
    rmSync(target, { force: true });
  }
}

/** Build a fresh file-backed database using the production finance DDL/seed. */
export async function prepareMoneyBrowserFixture(): Promise<void> {
  resetFixtureDatabase();
  const db = createClient({ url: `file:${MONEY_BROWSER_DB_FILE}` });
  try {
    await createBaseSchema(db);
    for (const migration of FINANCE_MIGRATIONS) {
      await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", migration), "utf8"));
    }
    // The authenticated root layout reads these empty connection tables for
    // its status dot. They carry no fixture data and no credentials; creating
    // their real schema keeps the Money run loud only about Money failures.
    await db.executeMultiple(`
      CREATE TABLE tenant_integration_credentials (
        id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
        tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL, last_tested_at TEXT, last_test_ok INTEGER,
        last_test_error TEXT, created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX tenant_integration_credentials_key
        ON tenant_integration_credentials (tenant_id, service, field_key);
      CREATE TABLE integrations_health (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
        profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL,
        last_ping_at TEXT, last_error TEXT, metadata TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE bridge_pairings (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
        last_seen_at TEXT, revoked_at TEXT, tool_capabilities TEXT NOT NULL DEFAULT '[]',
        scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT,
        claim_enabled_by TEXT
      );
    `);
    for (const migration of SHELL_SUPPORT_MIGRATIONS) {
      await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", migration), "utf8"));
    }
    await db.batch(seedStatements(), "write");
    await seedAuthUser(db, MONEY_BROWSER_FOUNDER);
    await seedTenant(db, MONEY_BROWSER_TENANT_ID, "oasis-ai-cc", "OASIS AI Solutions");
    await seedProfile(db, MONEY_BROWSER_FOUNDER, MONEY_BROWSER_TENANT_ID, {
      role: "owner",
      owner: true,
      onboarded: true,
      agents: ["bravo", "atlas", "maven"],
    });

    const proof = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM fin_entities) AS entities,
              (SELECT COUNT(*) FROM fin_accounts) AS accounts,
              (SELECT COUNT(*) FROM user_profiles WHERE auth_user_id = ?) AS founders`,
      args: [MONEY_BROWSER_FOUNDER.id],
    });
    const row = proof.rows[0];
    if (Number(row?.entities) !== 3 || Number(row?.accounts) === 0 || Number(row?.founders) !== 1) {
      throw new Error(`money browser fixture did not seed correctly: ${JSON.stringify(row)}`);
    }
  } finally {
    db.close();
  }
}
