-- 180 - FOUNDERS > Finances: double-entry bookkeeping for OASIS AI Solutions
-- plus the two founders' personal books (2026-09-24).
--
-- Additive only. Every table is new and prefixed fin_, so no existing reader
-- or writer is touched. Seed rows (entities, charts of accounts, tax codes,
-- categories) are NOT inserted here: lib/founders-finances/seed-io.ts inserts
-- them idempotently (INSERT OR IGNORE on deterministic ids) from the single
-- chart definition in lib/founders-finances/chart.ts, so the chart has one
-- source of truth that the tests can execute.
--
-- MONEY IS INTEGER CENTS, ALWAYS WITH AN ISO CURRENCY BESIDE IT. No REAL
-- column ever holds money. FX rates are stored as the decimal TEXT the Bank
-- of Canada publishes and parsed to a scaled integer in code.
--
-- PRIVACY. fin_entities.kind = 'personal' rows carry owner_key ('cc' or
-- 'adon'). Every read and write in lib/founders-finances resolves the entity
-- first and refuses a personal entity whose owner_key is not the caller's.
-- The database cannot enforce that (Turso has no RLS), so the code does, in
-- one pure predicate (access.ts canAccessEntity) that the tests execute.

CREATE TABLE IF NOT EXISTS fin_entities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('business', 'personal')),
  owner_key TEXT CHECK (owner_key IS NULL OR owner_key IN ('cc', 'adon')),
  owner_email TEXT,
  base_currency TEXT NOT NULL DEFAULT 'CAD',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'business' AND owner_key IS NULL) OR (kind = 'personal' AND owner_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fin_settings (
  entity_id TEXT PRIMARY KEY REFERENCES fin_entities(id),
  legal_name TEXT NOT NULL DEFAULT '',
  address_line1 TEXT NOT NULL DEFAULT '',
  address_line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'Canada',
  contact_email TEXT NOT NULL DEFAULT '',
  gst_qst_registered INTEGER NOT NULL DEFAULT 0 CHECK (gst_qst_registered IN (0, 1)),
  gst_number TEXT NOT NULL DEFAULT '',
  qst_number TEXT NOT NULL DEFAULT '',
  registration_effective_date TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  invoice_next_number INTEGER NOT NULL DEFAULT 1 CHECK (invoice_next_number >= 1),
  invoice_number_year INTEGER,
  payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK (payment_terms_days BETWEEN 0 AND 365),
  payment_instructions TEXT NOT NULL DEFAULT '',
  stripe_account_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS fin_accounts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  subtype TEXT NOT NULL DEFAULT 'other',
  currency TEXT NOT NULL DEFAULT 'CAD',
  owner_key TEXT CHECK (owner_key IS NULL OR owner_key IN ('cc', 'adon')),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS idx_fin_accounts_entity_type ON fin_accounts(entity_id, type);

CREATE TABLE IF NOT EXISTS fin_journal_entries (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverses_entry_id TEXT REFERENCES fin_journal_entries(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Idempotency: one entry per (entity, source, source_ref). A Stripe retry, a
-- double-clicked button or a re-run reconcile finds the existing entry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_journal_source
  ON fin_journal_entries(entity_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_journal_entity_date ON fin_journal_entries(entity_id, entry_date);

CREATE TABLE IF NOT EXISTS fin_journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES fin_journal_entries(id),
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  currency TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  cad_debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (cad_debit_cents >= 0),
  cad_credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (cad_credit_cents >= 0),
  fx_rate TEXT,
  contact_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_fin_lines_entry ON fin_journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_fin_lines_account ON fin_journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_fin_lines_entity ON fin_journal_lines(entity_id);

-- Bank of Canada daily rates. pair = 'USDCAD' means CAD per 1 USD (FXUSDCAD).
CREATE TABLE IF NOT EXISTS fin_fx_rates (
  pair TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  rate TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'bank_of_canada_valet',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pair, rate_date)
);

CREATE TABLE IF NOT EXISTS fin_contacts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'vendor', 'both')),
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  stripe_customer_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_contacts_entity ON fin_contacts(entity_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_contacts_stripe
  ON fin_contacts(entity_id, stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fin_categories (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity_id, name)
);

CREATE TABLE IF NOT EXISTS fin_rules (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  name TEXT NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'description' CHECK (match_field IN ('description', 'payee')),
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'equals', 'starts_with')),
  pattern TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  set_category_id TEXT NOT NULL REFERENCES fin_categories(id),
  set_contact_id TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_rules_entity ON fin_rules(entity_id, active, priority);

CREATE TABLE IF NOT EXISTS fin_tax_codes (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_ppm INTEGER NOT NULL CHECK (rate_ppm >= 0),
  payable_account_id TEXT REFERENCES fin_accounts(id),
  receivable_account_id TEXT REFERENCES fin_accounts(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (entity_id, code)
);

CREATE TABLE IF NOT EXISTS fin_invoices (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  contact_id TEXT NOT NULL REFERENCES fin_contacts(id),
  number TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'overdue', 'paid', 'void')),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  gst_cents INTEGER NOT NULL DEFAULT 0,
  qst_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  tax_registered_snapshot INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  recognition_entry_id TEXT,
  stripe_price_id TEXT,
  stripe_payment_link_id TEXT,
  stripe_payment_link_url TEXT,
  sent_at TEXT,
  sent_to TEXT,
  paid_at TEXT,
  voided_at TEXT,
  last_reminded_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_invoices_number
  ON fin_invoices(entity_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_invoices_entity_status ON fin_invoices(entity_id, status, due_date);

CREATE TABLE IF NOT EXISTS fin_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES fin_invoices(id),
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  taxable INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  revenue_account_id TEXT NOT NULL REFERENCES fin_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_fin_invoice_lines_invoice ON fin_invoice_lines(invoice_id, line_no);

CREATE TABLE IF NOT EXISTS fin_bills (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('bill', 'expense')),
  contact_id TEXT REFERENCES fin_contacts(id),
  vendor_name TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  bill_date TEXT NOT NULL,
  due_date TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  gst_cents INTEGER NOT NULL DEFAULT 0 CHECK (gst_cents >= 0),
  qst_cents INTEGER NOT NULL DEFAULT 0 CHECK (qst_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'void')),
  paid_at TEXT,
  paid_from_account_id TEXT REFERENCES fin_accounts(id),
  memo TEXT NOT NULL DEFAULT '',
  entry_id TEXT,
  payment_entry_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_bills_entity_status ON fin_bills(entity_id, status, bill_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_bills_source
  ON fin_bills(entity_id, source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS fin_bill_lines (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES fin_bills(id),
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
);
CREATE INDEX IF NOT EXISTS idx_fin_bill_lines_bill ON fin_bill_lines(bill_id, line_no);

-- Receipts and other files. The bytes live in object storage (R2 through
-- getServiceSupabase().storage, bucket 'finance-receipts', PRIVATE); this row
-- is the pointer plus the metadata to find and verify it.
CREATE TABLE IF NOT EXISTS fin_attachments (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('bill', 'transaction', 'invoice', 'journal')),
  owner_id TEXT NOT NULL,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_attachments_owner ON fin_attachments(entity_id, owner_type, owner_id);

CREATE TABLE IF NOT EXISTS fin_imports (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  filename TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'ofx', 'qfx')),
  file_sha256 TEXT NOT NULL,
  rows_total INTEGER NOT NULL,
  rows_inserted INTEGER NOT NULL,
  rows_duplicate INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_imports_entity ON fin_imports(entity_id, created_at);

-- The money-in/out register: imported bank lines, manual entries and drafts
-- Atlas extracted from receipts. amount_cents is SIGNED (+ in, - out).
CREATE TABLE IF NOT EXISTS fin_bank_transactions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  import_id TEXT REFERENCES fin_imports(id),
  posted_date TEXT NOT NULL,
  description TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  category_id TEXT REFERENCES fin_categories(id),
  contact_id TEXT,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'posted', 'excluded', 'draft')),
  entry_id TEXT,
  dedupe_hash TEXT NOT NULL,
  fitid TEXT,
  source TEXT NOT NULL CHECK (source IN ('import', 'manual', 'atlas')),
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity_id, account_id, dedupe_hash)
);
CREATE INDEX IF NOT EXISTS idx_fin_bank_txn_entity_date ON fin_bank_transactions(entity_id, posted_date);
CREATE INDEX IF NOT EXISTS idx_fin_bank_txn_status ON fin_bank_transactions(entity_id, status);

-- Money actually RECEIVED (and refunded). The single table revenueCollected
-- reads, so an invoice paid through Stripe is one row, never two: the
-- Stripe charge id, payment intent id and Stripe invoice id are each unique.
CREATE TABLE IF NOT EXISTS fin_payments (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  source TEXT NOT NULL CHECK (source IN ('stripe', 'manual')),
  occurred_at TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  settlement_cad_cents INTEGER,
  fee_cad_cents INTEGER,
  fee_status TEXT NOT NULL DEFAULT 'none' CHECK (fee_status IN ('none', 'pending', 'posted')),
  settlement_estimated INTEGER NOT NULL DEFAULT 0 CHECK (settlement_estimated IN (0, 1)),
  parent_payment_id TEXT REFERENCES fin_payments(id),
  invoice_id TEXT REFERENCES fin_invoices(id),
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  stripe_customer_id TEXT,
  stripe_charge_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT,
  stripe_refund_id TEXT,
  stripe_balance_txn_id TEXT,
  deposit_account_id TEXT REFERENCES fin_accounts(id),
  income_account_id TEXT REFERENCES fin_accounts(id),
  entry_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  livemode INTEGER NOT NULL DEFAULT 1 CHECK (livemode IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_payments_charge
  ON fin_payments(stripe_charge_id) WHERE kind = 'payment' AND stripe_charge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_payments_pi
  ON fin_payments(stripe_payment_intent_id) WHERE kind = 'payment' AND stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_payments_stripe_invoice
  ON fin_payments(stripe_invoice_id) WHERE kind = 'payment' AND stripe_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_payments_refund
  ON fin_payments(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_payments_entity_day ON fin_payments(entity_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_fin_payments_invoice ON fin_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_fin_payments_parent ON fin_payments(parent_payment_id);

-- Stripe webhook idempotency: one row per Stripe event id.
CREATE TABLE IF NOT EXISTS fin_stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1,
  event_created INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'ignored', 'failed')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

-- Subscription state for MRR, kept by the webhook and the reconcile.
CREATE TABLE IF NOT EXISTS fin_subscriptions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  stripe_customer_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at INTEGER,
  livemode INTEGER NOT NULL DEFAULT 1,
  source_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_subscriptions_status ON fin_subscriptions(entity_id, status);

CREATE TABLE IF NOT EXISTS fin_owner_equity_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  owner_key TEXT NOT NULL CHECK (owner_key IN ('cc', 'adon')),
  kind TEXT NOT NULL CHECK (kind IN ('draw', 'contribution')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  event_date TEXT NOT NULL,
  cash_account_id TEXT NOT NULL REFERENCES fin_accounts(id),
  memo TEXT NOT NULL DEFAULT '',
  entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_equity_entity ON fin_owner_equity_events(entity_id, owner_key, event_date);

CREATE TABLE IF NOT EXISTS fin_recurring_items (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES fin_entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'bill', 'invoice')),
  name TEXT NOT NULL,
  contact_id TEXT,
  category_id TEXT REFERENCES fin_categories(id),
  paid_from_account_id TEXT REFERENCES fin_accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_run_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_recurring_due ON fin_recurring_items(entity_id, active, next_run_on);

CREATE TABLE IF NOT EXISTS fin_audit_log (
  id TEXT PRIMARY KEY,
  entity_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON fin_audit_log(entity_id, created_at);
