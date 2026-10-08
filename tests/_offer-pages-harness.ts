/**
 * Shared harness for tests/offer-pages-*.test.ts.
 *
 * Builds on tests/_delivery-harness.ts (a throwaway local libSQL file, the
 * live shapes of tenants / forms / form_submissions / user_profiles /
 * tenant_records / lead_interactions, real signed sessions) and adds:
 *   - migration bravo__203 (form_offer_pages), applied statement by statement
 *     the way scripts/apply_turso_migration.py splits it;
 *   - the Library tables (marketing_asset, marketing_asset_media) in the
 *     columns lib/offer-pages/video.ts reads;
 *   - stand-ins for what a test must not reach: next/font/local (compiled away
 *     by Next, it throws at plain runtime), the marketing stylesheet, and the
 *     R2 signer (signMediaUrls) - a deterministic fake that records calls.
 *
 * IMPORT THIS FIRST, like the delivery harness: it sets the data layer's env
 * before any app module loads; tests load app modules with dynamic import().
 */
import "./_delivery-harness";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";
import type { Client } from "@libsql/client";
import { setupDatabase, splitSql } from "./_delivery-harness";

export * from "./_delivery-harness";

// Pages run as server components: tsconfig's jsx:"preserve" makes tsx use the
// classic runtime (a global React), as tests/forms-safe.test.ts sets it.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

export const ROOT = join(__dirname, "..");
export const OFFER_MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__203_form_offer_pages.sql");

export function stubPath(p: string, exports: Record<string, unknown>): void {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

// next/link pulls the client router context, which does not exist under the
// react-server condition the suites run with: a plain anchor stands in (as in
// tests/forms-safe.test.ts). The marketing CTA module imports it.
stubPath(require.resolve("next/link"), {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
});

// next/font/local: a font here is its class names only.
stubPath(require.resolve("next/font/local"), {
  __esModule: true,
  default: (opts: { variable?: string }) => ({
    className: "font-stub",
    variable: `font-var-${String(opts.variable || "x").replace(/[^a-z]/gi, "")}`,
    style: { fontFamily: "stub" },
  }),
});
// The marketing stylesheet: nothing to load outside a bundler.
stubPath(join(ROOT, "app", "(marketing)", "marketing.css"), {});

/** Every call the fake signer saw, and the URL it handed back. */
export const signCalls: Array<{ bucket: string; path: string; ttl: number }> = [];
export const fakeSignedUrl = (bucket: string, path: string, ttl: number) => `https://r2.test/${bucket}/${path}?ttl=${ttl}&sig=fake`;

/**
 * The R2 signer, stood in. The rest of lib/founders/marketing-queries is kept
 * (loaded for real) so nothing else that imports it changes.
 */
export async function stubSigner(): Promise<void> {
  const p = require.resolve(join(ROOT, "lib", "founders", "marketing-queries.ts"));
  const real = await import("../lib/founders/marketing-queries");
  stubPath(p, {
    ...real,
    signMediaUrls: async (refs: Array<{ bucket: string; path: string }>, ttl = 3600) => {
      const out = new Map<string, string>();
      for (const r of refs) {
        signCalls.push({ bucket: r.bucket, path: r.path, ttl });
        out.set(`${r.bucket}\n${r.path}`, fakeSignedUrl(r.bucket, r.path, ttl));
      }
      return out;
    },
  });
}

export async function applyOfferMigration(db: Client): Promise<void> {
  for (const stmt of splitSql(readFileSync(OFFER_MIGRATION_PATH, "utf8"))) await db.execute(stmt);
}

export async function createLibraryTables(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, brand_slug TEXT NOT NULL DEFAULT 'oasis-ai',
      title TEXT NOT NULL DEFAULT '', format TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', aspect TEXT,
      duration_s REAL, updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE marketing_asset_media (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_bucket TEXT NOT NULL DEFAULT 'marketing-media', storage_path TEXT NOT NULL, mime TEXT, bytes INTEGER,
      width INTEGER, height INTEGER, label TEXT);
  `);
}

/** The delivery harness's database, plus offer pages (unless `migrate: false`) and the Library. */
export async function setupOfferDatabase(opts: { migrate?: boolean; library?: boolean } = {}): Promise<Client> {
  const db = await setupDatabase();
  if (opts.migrate !== false) await applyOfferMigration(db);
  if (opts.library !== false) await createLibraryTables(db);
  // Connections > Telegram's saved fields (lib/tenant-integration-store.ts),
  // empty: no workspace has saved a bot unless a test writes one.
  await db.executeMultiple(`
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, profile_id TEXT, service TEXT NOT NULL, field_key TEXT NOT NULL, encrypted_value TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
  `);
  return db;
}

export const AT = "2026-10-08T12:00:00.000Z";
export const OWNER_OK = { by: "pending", at: AT };

/** A form row for a workspace. */
export function formRow(id: string, tenantId: string, slug: string, name: string, steps: unknown, branding: unknown = {}, enabled = 1) {
  return {
    sql: `INSERT INTO forms (id, tenant_id, slug, name, branding, steps, step_outcomes, enabled) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    args: [id, tenantId, slug, name, JSON.stringify(branding), JSON.stringify(steps), enabled],
  };
}

/** An offer page row, written straight to the table. */
export function offerRow(input: {
  formId: string;
  tenantId: string;
  template?: string;
  draft: unknown;
  published?: unknown;
  live?: 0 | 1;
  claims?: unknown[];
  draftVersion?: number;
}) {
  return {
    sql: `INSERT INTO form_offer_pages (form_id, tenant_id, template_key, draft, draft_version, published, published_version, live, claims_confirmed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.formId,
      input.tenantId,
      input.template ?? "book_call",
      JSON.stringify(input.draft),
      input.draftVersion ?? 0,
      input.published === undefined ? null : JSON.stringify(input.published),
      input.published === undefined ? 0 : 1,
      input.live ?? 0,
      JSON.stringify(input.claims ?? []),
    ],
  };
}

export const CONTACT_STEPS = [
  {
    key: "contact",
    title: "Your details",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Mobile number", type: "phone", required: true },
      { name: "company", label: "Company", type: "text" },
    ],
  },
  { key: "details", title: "About you", fields: [{ name: "details", label: "Tell us more", type: "textarea" }] },
];

/** A minimal valid page: a headline and the Book section. */
export function minimalDoc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    template: "book_call",
    theme: { canvas: "dark" },
    nav: { pinned: [] },
    hero: { headline: "Systems that answer every lead" },
    sections: [],
    book: { mode: "form", qualify: "after" },
    seo: { indexable: false },
    ...overrides,
  };
}

let failures = 0;
/** Like the delivery harness's check(), but this file's own count, for files that import only this. */
export async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}
export function done(label: string): void {
  if (failures) {
    console.log(`${label}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`${label}: all passed`);
  process.exit(0);
}
