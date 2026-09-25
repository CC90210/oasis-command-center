/**
 * The money-in/out register: manual entries, statement imports (CSV / OFX /
 * QFX), auto-categorisation rules, and drafts from Atlas.
 *
 * A register row is POSTED to the ledger the moment it has a category:
 *   money in  (+): Dr the register account (bank/card) / Cr the category's account
 *   money out (-): Dr the category's account / Cr the register account
 * Re-categorising reverses the old entry and posts a new one, in one batch,
 * gated on the row still pointing at the entry this decision saw.
 * Uncategorised rows and Atlas drafts are not posted until a founder reviews
 * them — a draft is a suggestion, not a booking.
 *
 * OWNED vs LINKED. A line's entry is normally its OWN (source "bank_txn",
 * written from this file). A bank feed can instead LINK a line to an entry
 * that already moved the same money — an expense or bill payment recorded on
 * the Bills page — so the money is booked once. Excluding a linked line only
 * unlinks it; re-categorising one is refused. Neither ever reverses the
 * expense it points at.
 *
 * HELD lines. The Wise feed holds an unreviewed line it cannot safely book
 * (it may already be on the books) by starting its memo with FEED_HOLD_MARK
 * and saying why. No RULE ever categorises a held line — not at import, not
 * "Apply rules to unreviewed transactions", not "create rule from
 * transaction"; a founder decides it, one line at a time. Categorising is
 * refused outright where it is certainly a second booking
 * (alreadyOnTheBooks): a line linked to an expense, a Wise deposit already
 * recorded against an invoice, a Wise line an opening balance already holds.
 */
import "server-only";

import { accountId, REGISTER_SUBTYPES, SYS } from "./chart";
import { isCurrency } from "./money";
import { isIsoDate } from "./fx";
import { dedupeHashes, manualDedupeHash, parseStatement, sha256Hex, MAX_IMPORT_BYTES, type DateOrder } from "./import-parse";
import { firstMatchingRule, normalizeText, suggestRulePattern, validateRuleInput, type RuleLike } from "./rules";
import { validateTransactionInput, type TransactionInput } from "./validation";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import {
  FinanceInputError,
  FinanceNotFound,
  requireAccountOf,
  requireCategoryOf,
  requireEntity,
  requireRowEntity,
  type CategoryRow,
  type EntityRow,
} from "./access-io";
import { buildPosting, buildReversal, findEntryBySource } from "./ledger-io";
import type { JournalLineInput } from "./ledger";
import { FEED_HOLD_MARK, OPENING_BALANCE_SOURCE, parseWiseFitid, WISE_PAYMENT_SOURCE } from "./wise-feed";

/** The source of every entry a register line owns. */
export const REGISTER_ENTRY_SOURCE = "bank_txn";

export type TxnRow = {
  id: string;
  entity_id: string;
  account_id: string;
  import_id: string | null;
  posted_date: string;
  description: string;
  payee: string;
  amount_cents: number;
  currency: string;
  category_id: string | null;
  contact_id: string | null;
  rule_id: string | null;
  status: "unreviewed" | "posted" | "excluded" | "draft";
  entry_id: string | null;
  fitid: string | null;
  source: string;
  memo: string;
  created_by: string;
  created_at: string;
};

async function loadTxn(id: string): Promise<TxnRow | null> {
  return queryOne<TxnRow>(`SELECT * FROM fin_bank_transactions WHERE id = ?`, [id]);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

async function registerAccount(entity: EntityRow, id: string) {
  const a = await requireAccountOf(entity.id, id);
  if (!REGISTER_SUBTYPES.has(a.subtype)) throw new FinanceInputError("transactions are recorded against a bank, cash, clearing or credit-card account");
  return a;
}

function txnPostingInput(txn: Pick<TxnRow, "id" | "entity_id" | "account_id" | "posted_date" | "description" | "amount_cents" | "currency" | "contact_id">, category: CategoryRow, createdBy: string, sourceRef: string) {
  if (category.account_id === txn.account_id) throw new FinanceInputError("a transaction cannot be categorised into its own account");
  const amount = Math.abs(txn.amount_cents);
  const inflow = txn.amount_cents > 0;
  return {
    entityId: txn.entity_id,
    entryDate: txn.posted_date,
    memo: txn.description.slice(0, 200),
    source: REGISTER_ENTRY_SOURCE,
    sourceRef,
    createdBy,
    lines: inflow
      ? [
          { accountId: txn.account_id, currency: txn.currency, debitCents: amount, contactId: txn.contact_id },
          { accountId: category.account_id, currency: txn.currency, creditCents: amount, contactId: txn.contact_id },
        ]
      : [
          { accountId: category.account_id, currency: txn.currency, debitCents: amount, contactId: txn.contact_id },
          { accountId: txn.account_id, currency: txn.currency, creditCents: amount, contactId: txn.contact_id },
        ],
  };
}

// ── reads ────────────────────────────────────────────────────────────────

export type TxnFilters = {
  accountId?: string;
  categoryId?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
};

export async function listTransactions(viewer: FinanceViewer, entityRef: string, f: TxnFilters = {}) {
  const entity = await requireEntity(viewer, entityRef);
  const where = ["t.entity_id = ?"];
  const args: Array<string | number> = [entity.id];
  if (f.accountId) {
    where.push("t.account_id = ?");
    args.push(f.accountId);
  }
  if (f.categoryId === "none") where.push("t.category_id IS NULL");
  else if (f.categoryId) {
    where.push("t.category_id = ?");
    args.push(f.categoryId);
  }
  if (f.status && ["unreviewed", "posted", "excluded", "draft"].includes(f.status)) {
    where.push("t.status = ?");
    args.push(f.status);
  }
  if (f.from && isIsoDate(f.from)) {
    where.push("t.posted_date >= ?");
    args.push(f.from);
  }
  if (f.to && isIsoDate(f.to)) {
    where.push("t.posted_date < ?");
    args.push(f.to);
  }
  if (f.q && f.q.trim()) {
    where.push("(lower(t.description) LIKE ? OR lower(t.payee) LIKE ? OR lower(t.memo) LIKE ?)");
    const like = `%${f.q.trim().toLowerCase().replace(/[%_]/g, "")}%`;
    args.push(like, like, like);
  }
  const limit = Math.max(1, Math.min(1000, f.limit ?? 300));
  return query<TxnRow & { account_name: string; category_name: string | null }>(
    `SELECT t.*, a.name AS account_name, c.name AS category_name
       FROM fin_bank_transactions t
       JOIN fin_accounts a ON a.id = t.account_id
       LEFT JOIN fin_categories c ON c.id = t.category_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.posted_date DESC, t.created_at DESC LIMIT ${limit}`,
    args,
  );
}

// ── manual entry ─────────────────────────────────────────────────────────

export async function createManualTransaction(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  const v = validateTransactionInput(raw);
  if (!v.ok) throw new FinanceInputError(v.error);
  const account = await registerAccount(entity, text(raw.account_id, 120) || accountId(entity.id, SYS.chequing));
  const categoryId = v.value.categoryId;
  const category = categoryId ? await requireCategoryOf(entity.id, categoryId) : null;
  const id = newId("txn");
  const row = {
    id,
    entity_id: entity.id,
    account_id: account.id,
    posted_date: v.value.postedDate,
    description: v.value.description,
    amount_cents: v.value.amountCents,
    currency: v.value.currency,
    contact_id: null,
  };
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO fin_bank_transactions (id, entity_id, account_id, posted_date, description, payee, amount_cents, currency,
              category_id, status, dedupe_hash, source, memo, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, 'manual', ?, ?)`,
      args: [id, entity.id, account.id, v.value.postedDate, v.value.description, v.value.payee, v.value.amountCents, v.value.currency, category?.id ?? null, manualDedupeHash({ ...v.value, nonce: id }), v.value.memo, viewerLabel(viewer)],
    },
  ];
  if (category) {
    const posting = await buildPosting(txnPostingInput(row, category, viewerLabel(viewer), id));
    statements.push(...posting.statements, { sql: `UPDATE fin_bank_transactions SET entry_id = ?, status = 'posted' WHERE id = ?`, args: [posting.entryId, id] });
  }
  statements.push(auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "txn.manual_created", objectType: "transaction", objectId: id, detail: { amount: v.value.amountCents } }));
  await writeBatch(statements);
  return id;
}

// ── categorise / exclude ─────────────────────────────────────────────────

async function statementsToPost(txn: TxnRow, category: CategoryRow, actor: string): Promise<{ statements: InStatement[]; entryId: string }> {
  const statements: InStatement[] = [];
  const old = txn.entry_id || "";
  if (txn.entry_id) {
    const rev = await buildReversal({ entityId: txn.entity_id, entryId: txn.entry_id, date: txn.posted_date, memo: "Re-categorised", createdBy: actor });
    statements.push(...rev.statements);
  }
  const posting = await buildPosting({
    ...txnPostingInput(txn, category, actor, txn.entry_id ? `${txn.id}:${newId("r")}` : txn.id),
    gate: { sql: `(SELECT COALESCE(entry_id, '') FROM fin_bank_transactions WHERE id = ?) = ?`, args: [txn.id, old] },
  });
  statements.push(...posting.statements, {
    sql: `UPDATE fin_bank_transactions SET category_id = ?, entry_id = ?, status = 'posted'
           WHERE id = ? AND COALESCE(entry_id, '') = ? AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
    args: [category.id, posting.entryId, txn.id, old, posting.entryId],
  });
  return { statements, entryId: posting.entryId };
}

/** The entry a line points at when it is NOT the line's own (a linked expense / bill payment), else null. */
async function linkedEntryOf(txn: Pick<TxnRow, "entry_id">): Promise<{ id: string; memo: string } | null> {
  if (!txn.entry_id) return null;
  const e = await queryOne<{ id: string; source: string; memo: string }>(`SELECT id, source, memo FROM fin_journal_entries WHERE id = ?`, [txn.entry_id]);
  return e && e.source !== REGISTER_ENTRY_SOURCE ? { id: e.id, memo: e.memo } : null;
}

/**
 * Why posting this line would put money on the books a SECOND time, or null.
 * A line that owns its entry is only ever re-categorised (the old entry is
 * reversed first), so only a line with no entry, or a linked one, can double.
 */
async function alreadyOnTheBooks(txn: TxnRow): Promise<string | null> {
  const linked = await linkedEntryOf(txn);
  if (linked) return `this bank line is matched to "${linked.memo}", which is already on the books; exclude the line to unmatch it first`;
  if (txn.entry_id) return null;
  const wise = parseWiseFitid(txn.fitid);
  if (!wise) return null;
  if (wise.direction === "CREDIT") {
    const paid = await queryOne<{ memo: string }>(
      `SELECT memo FROM fin_journal_entries WHERE entity_id = ? AND source = ? AND source_ref = ? AND status = 'posted'`,
      [txn.entity_id, WISE_PAYMENT_SOURCE, wise.ref],
    );
    if (paid) return `Wise deposit ${wise.ref} is already recorded as an invoice payment ("${paid.memo}"); categorising it too would count it twice`;
  }
  // An opening balance posted BEFORE this line arrived, for a day on or after it, already absorbed its money.
  const opening = await queryOne<{ entry_date: string }>(
    `SELECT e.entry_date FROM fin_journal_entries e
      WHERE e.entity_id = ? AND e.source = ? AND e.status = 'posted' AND e.entry_date >= ? AND e.created_at < ?
        AND EXISTS (SELECT 1 FROM fin_journal_lines l WHERE l.entry_id = e.id AND l.account_id = ? AND l.currency = ?)
      ORDER BY e.entry_date DESC LIMIT 1`,
    [txn.entity_id, OPENING_BALANCE_SOURCE, txn.posted_date, txn.created_at, txn.account_id, txn.currency],
  );
  if (opening) {
    return `this Wise line is dated on or before the opening balance of ${opening.entry_date}, which was posted before the line arrived and so already contains it; re-post the opening balance on the Wise card first`;
  }
  return null;
}

export async function categorizeTransaction(viewer: FinanceViewer, txnId: string, categoryId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_bank_transactions", txnId);
  const category = await requireCategoryOf(entity.id, categoryId);
  const txn = await loadTxn(txnId);
  if (!txn) throw new FinanceNotFound();
  if (txn.status === "posted" && txn.category_id === category.id && txn.entry_id) return;
  const twice = await alreadyOnTheBooks(txn);
  if (twice) throw new FinanceInputError(twice);
  const { statements } = await statementsToPost(txn, category, viewerLabel(viewer));
  statements.push(auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "txn.categorized", objectType: "transaction", objectId: txnId, detail: { category: category.name } }));
  try {
    await writeBatch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) throw new FinanceInputError("this transaction changed while you were editing it; reload and try again");
    throw e;
  }
}

export async function excludeTransaction(viewer: FinanceViewer, txnId: string): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_bank_transactions", txnId);
  const txn = await loadTxn(txnId);
  if (!txn) throw new FinanceNotFound();
  const statements: InStatement[] = [];
  // A linked line is only unlinked: the expense it points at stays on the books.
  if (txn.entry_id && !(await linkedEntryOf(txn))) {
    const rev = await buildReversal({ entityId: entity.id, entryId: txn.entry_id, date: txn.posted_date, memo: "Excluded", createdBy: viewerLabel(viewer) });
    statements.push(...rev.statements);
  }
  statements.push(
    { sql: `UPDATE fin_bank_transactions SET status = 'excluded', entry_id = NULL WHERE id = ? AND COALESCE(entry_id, '') = ?`, args: [txnId, txn.entry_id || ""] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "txn.excluded", objectType: "transaction", objectId: txnId }),
  );
  await writeBatch(statements);
}

// ── rules ────────────────────────────────────────────────────────────────

type RuleRow = {
  id: string;
  entity_id: string;
  name: string;
  match_field: "description" | "payee";
  match_type: "contains" | "equals" | "starts_with";
  pattern: string;
  direction: "in" | "out" | "any";
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  set_category_id: string;
  set_contact_id: string | null;
  priority: number;
  active: number;
  created_at: string;
};

export function toRuleLike(r: RuleRow): RuleLike {
  return {
    id: r.id,
    matchField: r.match_field,
    matchType: r.match_type,
    pattern: r.pattern,
    direction: r.direction,
    amountMinCents: r.amount_min_cents,
    amountMaxCents: r.amount_max_cents,
    priority: r.priority,
    active: r.active === 1,
    setCategoryId: r.set_category_id,
    setContactId: r.set_contact_id,
    createdAt: r.created_at,
  };
}

export async function listRules(viewer: FinanceViewer, entityRef: string) {
  const entity = await requireEntity(viewer, entityRef);
  return query<RuleRow & { category_name: string }>(
    `SELECT r.*, c.name AS category_name FROM fin_rules r JOIN fin_categories c ON c.id = r.set_category_id
      WHERE r.entity_id = ? ORDER BY r.active DESC, r.priority, r.created_at`,
    [entity.id],
  );
}

async function activeRules(entityId: string): Promise<RuleLike[]> {
  const rows = await query<RuleRow>(`SELECT * FROM fin_rules WHERE entity_id = ? AND active = 1`, [entityId]);
  return rows.map(toRuleLike);
}

export async function createRule(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  const priority = raw.priority === undefined || raw.priority === "" ? 100 : Number(raw.priority);
  const input = {
    name: text(raw.name, 120),
    pattern: text(raw.pattern, 120),
    matchField: text(raw.match_field, 20) || "description",
    matchType: text(raw.match_type, 20) || "contains",
    direction: text(raw.direction, 10) || "any",
    priority,
  };
  const v = validateRuleInput(input);
  if (!v.ok) throw new FinanceInputError(v.error);
  const category = await requireCategoryOf(entity.id, text(raw.category_id, 120));
  const id = newId("rule");
  await writeBatch([
    {
      sql: `INSERT INTO fin_rules (id, entity_id, name, match_field, match_type, pattern, direction, set_category_id, priority, active, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [id, entity.id, input.name || `${input.pattern} -> ${category.name}`, input.matchField, input.matchType, normalizeText(input.pattern), input.direction, category.id, priority, viewerLabel(viewer)],
    },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "rule.created", objectType: "rule", objectId: id, detail: { pattern: input.pattern } }),
  ]);
  return id;
}

export async function setRuleActive(viewer: FinanceViewer, ruleId: string, active: boolean): Promise<void> {
  const entity = await requireRowEntity(viewer, "fin_rules", ruleId);
  await writeBatch([
    { sql: `UPDATE fin_rules SET active = ? WHERE id = ? AND entity_id = ?`, args: [active ? 1 : 0, ruleId, entity.id] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: active ? "rule.enabled" : "rule.disabled", objectType: "rule", objectId: ruleId }),
  ]);
}

/** "Create a rule from this transaction", then apply it to everything still unreviewed. */
export async function createRuleFromTransaction(
  viewer: FinanceViewer,
  txnId: string,
  raw: Record<string, unknown>,
): Promise<{ ruleId: string; applied: number }> {
  const entity = await requireRowEntity(viewer, "fin_bank_transactions", txnId);
  const txn = await loadTxn(txnId);
  if (!txn) throw new FinanceNotFound();
  const categoryId = text(raw.category_id, 120) || txn.category_id || "";
  const ruleId = await createRule(viewer, entity.id, {
    pattern: text(raw.pattern, 120) || suggestRulePattern(txn.description),
    category_id: categoryId,
    direction: txn.amount_cents > 0 ? "in" : "out",
    match_field: "description",
    match_type: "contains",
    priority: 100,
  });
  if (txn.status !== "posted" || txn.category_id !== categoryId) await categorizeTransaction(viewer, txnId, categoryId);
  const applied = await applyRulesToUnreviewed(viewer, entity.id);
  return { ruleId, applied };
}

export async function applyRulesToUnreviewed(viewer: FinanceViewer, entityRef: string): Promise<number> {
  const entity = await requireEntity(viewer, entityRef);
  const rules = await activeRules(entity.id);
  if (rules.length === 0) return 0;
  // A line the bank feed holds for a founder is never a rule's to book (see HELD lines above).
  const rows = await query<TxnRow>(
    `SELECT * FROM fin_bank_transactions WHERE entity_id = ? AND status = 'unreviewed' AND substr(memo, 1, ?) <> ? LIMIT 2000`,
    [entity.id, FEED_HOLD_MARK.length, FEED_HOLD_MARK],
  );
  let applied = 0;
  for (const t of rows) {
    const hit = firstMatchingRule(rules, { description: t.description, payee: t.payee, amountCents: t.amount_cents });
    if (!hit) continue;
    try {
      await categorizeTransaction(viewer, t.id, hit.setCategoryId);
      applied += 1;
    } catch (e) {
      console.error("[finances:rules] could not apply rule", hit.id, "to", t.id, e instanceof Error ? e.message : e);
    }
  }
  return applied;
}

// ── statement import ─────────────────────────────────────────────────────

export type ImportArgs = { accountId: string; filename: string; text: string; dateOrder?: DateOrder; currency?: string };

async function parseForImport(entity: EntityRow, a: ImportArgs) {
  if (Buffer.byteLength(a.text, "utf8") > MAX_IMPORT_BYTES) throw new FinanceInputError("file is larger than 5 MB");
  const account = await registerAccount(entity, a.accountId);
  const parsed = parseStatement(a.filename, a.text, { dateOrder: a.dateOrder });
  const currency = (parsed.currency || a.currency || "CAD").toUpperCase();
  if (!isCurrency(currency)) throw new FinanceInputError(`statement currency ${currency} is not supported (CAD or USD)`);
  const hashes = dedupeHashes(parsed.rows);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += 200) {
    const chunk = hashes.slice(i, i + 200);
    const rows = await query<{ dedupe_hash: string }>(
      `SELECT dedupe_hash FROM fin_bank_transactions WHERE entity_id = ? AND account_id = ? AND dedupe_hash IN (${chunk.map(() => "?").join(",")})`,
      [entity.id, account.id, ...chunk],
    );
    for (const r of rows) existing.add(r.dedupe_hash);
  }
  const rules = await activeRules(entity.id);
  const categories = new Map((await query<{ id: string; name: string }>(`SELECT id, name FROM fin_categories WHERE entity_id = ?`, [entity.id])).map((c) => [c.id, c.name]));
  const rows = parsed.rows.map((r, i) => {
    const hit = firstMatchingRule(rules, { description: r.description, payee: r.payee, amountCents: r.amountCents });
    return {
      ...r,
      hash: hashes[i],
      duplicate: existing.has(hashes[i]),
      ruleId: hit?.id ?? null,
      suggestedCategoryId: hit?.setCategoryId ?? null,
      suggestedCategoryName: hit ? categories.get(hit.setCategoryId) ?? null : null,
    };
  });
  return { account, parsed, currency, rows };
}

export async function previewImport(viewer: FinanceViewer, entityRef: string, a: ImportArgs) {
  const entity = await requireEntity(viewer, entityRef);
  const { parsed, currency, rows } = await parseForImport(entity, a);
  return {
    format: parsed.format,
    currency,
    errors: parsed.errors.slice(0, 50),
    notes: parsed.notes,
    total: rows.length,
    duplicates: rows.filter((r) => r.duplicate).length,
    rows: rows.slice(0, 500),
  };
}

/**
 * What a bank feed tells the import. `hold`: FITIDs the caller resolves
 * itself (a line that is an expense already on the books, a deposit already
 * recorded against an invoice, a Stripe payout, a currency conversion). Those
 * rows are inserted UNREVIEWED and no rule touches them — a rule posting them
 * first is exactly how money got counted twice.
 */
export type ImportHooks = { hold?: ReadonlySet<string> };

/**
 * Commit an import. The file is re-parsed here — rows from the browser are
 * never trusted. Inserts are OR IGNORE against UNIQUE(entity, account,
 * dedupe_hash): re-importing the same file inserts nothing.
 */
export async function commitImport(viewer: FinanceViewer, entityRef: string, a: ImportArgs, hooks: ImportHooks = {}) {
  const entity = await requireEntity(viewer, entityRef);
  const parsedImport = await parseForImport(entity, a);
  const { account, parsed, currency } = parsedImport;
  const held = (r: { fitid: string | null }) => r.fitid !== null && (hooks.hold?.has(r.fitid) ?? false);
  const rows = parsedImport.rows.map((r) => (held(r) ? { ...r, ruleId: null, suggestedCategoryId: null } : r));
  if (parsed.errors.length > 0 && rows.length === 0) throw new FinanceInputError(`nothing importable: ${parsed.errors.slice(0, 3).join("; ")}`);
  const importId = newId("imp");
  const format = parsed.format;
  const ids = rows.map(() => newId("txn"));
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO fin_imports (id, entity_id, account_id, filename, format, file_sha256, rows_total, rows_inserted, rows_duplicate, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      args: [importId, entity.id, account.id, a.filename.slice(0, 200), format, sha256Hex(a.text), rows.length, viewerLabel(viewer)],
    },
    ...rows.map((r, i) => ({
      sql: `INSERT OR IGNORE INTO fin_bank_transactions (id, entity_id, account_id, import_id, posted_date, description, payee, amount_cents,
              currency, status, dedupe_hash, fitid, source, rule_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?, 'import', ?, ?)`,
      args: [ids[i], entity.id, account.id, importId, r.postedDate, r.description, r.payee, r.amountCents, currency, r.hash, r.fitid, r.ruleId, viewerLabel(viewer)],
    })),
  ];
  const results = await writeBatch(statements);
  const insertedIdx = rows.map((_, i) => i).filter((i) => results[i + 1]?.rowsAffected === 1);
  const inserted = insertedIdx.length;
  const duplicates = rows.length - inserted;
  await writeBatch([
    { sql: `UPDATE fin_imports SET rows_inserted = ?, rows_duplicate = ? WHERE id = ?`, args: [inserted, duplicates, importId] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "import.committed", objectType: "import", objectId: importId, detail: { inserted, duplicates, format } }),
  ]);
  let posted = 0;
  for (const i of insertedIdx) {
    const catId = rows[i].suggestedCategoryId;
    if (!catId) continue;
    try {
      await categorizeTransaction(viewer, ids[i], catId);
      posted += 1;
    } catch (e) {
      console.error("[finances:import] auto-categorise failed", ids[i], e instanceof Error ? e.message : e);
    }
  }
  return { importId, total: rows.length, inserted, duplicates, posted, errors: parsed.errors.slice(0, 50) };
}

// ── bank-line <-> entry matching (the Wise feed) ─────────────────────────

/** An audit row written only when `txnId` ended up pointing at `entryId` in the same batch. */
function auditIfLinked(a: { entityId: string; actor: string; action: string; txnId: string; entryId: string; detail: Record<string, unknown> }): InStatement {
  return {
    sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
          SELECT ?, ?, ?, ?, 'transaction', ?, ? WHERE EXISTS (SELECT 1 FROM fin_bank_transactions WHERE id = ? AND entry_id = ?)`,
    args: [newId("aud"), a.entityId, a.actor.slice(0, 200), a.action, a.txnId, JSON.stringify(a.detail).slice(0, 8000), a.txnId, a.entryId],
  };
}

/**
 * Mark an UNREVIEWED line as posted against an entry that ALREADY exists (a
 * paid expense, a bill payment): nothing new is posted, so the money is on
 * the books once. Gated: the line must still be unreviewed and unposted, the
 * entry must be live, and no other line may already point at it — one bill is
 * never matched twice, even by two syncs at once. rowsAffected of the first
 * statement is 1 when it linked.
 */
export function linkLineToEntryStatements(a: {
  entityId: string;
  txnId: string;
  entryId: string;
  categoryId: string | null;
  memo: string;
  actor: string;
  detail?: Record<string, unknown>;
}): InStatement[] {
  return [
    {
      sql: `UPDATE fin_bank_transactions SET status = 'posted', entry_id = ?, category_id = COALESCE(?, category_id), memo = ?
             WHERE id = ? AND entity_id = ? AND status = 'unreviewed' AND entry_id IS NULL
               AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ? AND entity_id = ? AND status = 'posted')
               AND NOT EXISTS (SELECT 1 FROM fin_bank_transactions WHERE entity_id = ? AND entry_id = ?)`,
      args: [a.entryId, a.categoryId, a.memo.slice(0, 500), a.txnId, a.entityId, a.entryId, a.entityId, a.entityId, a.entryId],
    },
    auditIfLinked({ entityId: a.entityId, actor: a.actor, action: "txn.linked", txnId: a.txnId, entryId: a.entryId, detail: { entry: a.entryId, ...(a.detail || {}) } }),
  ];
}

/**
 * Post an UNREVIEWED line with journal lines a caller built (a Stripe payout,
 * a currency conversion). The entry is the line's OWN — source bank_txn, ref
 * the line id — so exclude and re-categorise reverse it like any categorised
 * line. `posting` must run before `link` in the batch; with `together`, every
 * listed line must still be unreviewed for ANY of the entries to be written
 * (a conversion's two legs land together or not at all).
 */
export async function buildLinePosting(a: {
  txn: Pick<TxnRow, "id" | "entity_id" | "posted_date" | "description">;
  lines: JournalLineInput[];
  categoryId: string | null;
  memo: string;
  actor: string;
  fixedRates?: Record<string, string>;
  together?: string[];
  detail?: Record<string, unknown>;
}): Promise<{ entryId: string; posting: InStatement[]; link: InStatement[] }> {
  const ids = [...new Set([a.txn.id, ...(a.together || [])])];
  const sourceRef = (await findEntryBySource(a.txn.entity_id, REGISTER_ENTRY_SOURCE, a.txn.id)) ? `${a.txn.id}:${newId("r")}` : a.txn.id;
  const built = await buildPosting({
    entityId: a.txn.entity_id,
    entryDate: a.txn.posted_date,
    memo: a.memo.slice(0, 200),
    source: REGISTER_ENTRY_SOURCE,
    sourceRef,
    createdBy: a.actor,
    fixedRates: a.fixedRates,
    lines: a.lines,
    gate: {
      sql: `(SELECT COUNT(*) FROM fin_bank_transactions WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'unreviewed' AND entry_id IS NULL) = ?`,
      args: [...ids, ids.length],
    },
  });
  return {
    entryId: built.entryId,
    posting: built.statements,
    link: [
      {
        sql: `UPDATE fin_bank_transactions SET category_id = COALESCE(?, category_id), entry_id = ?, status = 'posted', memo = ?
               WHERE id = ? AND status = 'unreviewed' AND entry_id IS NULL AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
        args: [a.categoryId, built.entryId, a.memo.slice(0, 500), a.txn.id, built.entryId],
      },
      auditIfLinked({ entityId: a.txn.entity_id, actor: a.actor, action: "txn.posted_by_feed", txnId: a.txn.id, entryId: built.entryId, detail: { entry: built.entryId, ...(a.detail || {}) } }),
    ],
  };
}

// ── Atlas drafts ─────────────────────────────────────────────────────────

/**
 * Bulk-insert DRAFT transactions for review (e.g. receipts Atlas extracted
 * from email). Business book only. Never posted here: a founder approves each
 * (which categorises and posts it). An `external_ref` makes a resend of the
 * same receipt a no-op; without one, identical date+amount+description is
 * treated as the same draft.
 */
export async function insertDraftTransactions(
  viewer: FinanceViewer,
  entity: EntityRow,
  items: Array<{ index: number; value: TransactionInput }>,
): Promise<Array<{ index: number; id: string | null; status: "inserted" | "duplicate" | "rejected"; error?: string }>> {
  const accounts = await query<{ id: string; code: string; subtype: string }>(`SELECT id, code, subtype FROM fin_accounts WHERE entity_id = ?`, [entity.id]);
  const categories = await query<{ id: string; name: string }>(`SELECT id, name FROM fin_categories WHERE entity_id = ? AND archived = 0`, [entity.id]);
  const rules = await activeRules(entity.id);
  const out: Array<{ index: number; id: string | null; status: "inserted" | "duplicate" | "rejected"; error?: string }> = [];
  const statements: InStatement[] = [];
  const pending: Array<{ index: number; id: string }> = [];
  for (const { index, value } of items) {
    const acct = accounts.find((a) => a.code === (value.accountCode || SYS.chequing));
    if (!acct || !REGISTER_SUBTYPES.has(acct.subtype)) {
      out.push({ index, id: null, status: "rejected", error: `account_code ${value.accountCode} is not a register account` });
      continue;
    }
    let categoryId: string | null = null;
    if (value.categoryId) categoryId = categories.find((c) => c.id === value.categoryId)?.id ?? null;
    else if (value.categoryName) categoryId = categories.find((c) => normalizeText(c.name) === normalizeText(value.categoryName))?.id ?? null;
    if ((value.categoryId || value.categoryName) && !categoryId) {
      out.push({ index, id: null, status: "rejected", error: "unknown category" });
      continue;
    }
    if (!categoryId) categoryId = firstMatchingRule(rules, { description: value.description, payee: value.payee, amountCents: value.amountCents })?.setCategoryId ?? null;
    const id = newId("txn");
    pending.push({ index, id });
    statements.push({
      sql: `INSERT OR IGNORE INTO fin_bank_transactions (id, entity_id, account_id, posted_date, description, payee, amount_cents, currency,
              category_id, status, dedupe_hash, source, memo, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 'atlas', ?, ?)`,
      args: [
        id,
        entity.id,
        acct.id,
        value.postedDate,
        value.description,
        value.payee,
        value.amountCents,
        value.currency,
        categoryId,
        manualDedupeHash({ postedDate: value.postedDate, amountCents: value.amountCents, description: value.description, sourceRef: value.externalRef ? `atlas:${value.externalRef}` : null }),
        value.memo,
        viewerLabel(viewer),
      ],
    });
  }
  if (statements.length > 0) {
    statements.push(auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "txn.drafts_inserted", objectType: "transaction", objectId: null, detail: { count: pending.length } }));
    const results = await writeBatch(statements);
    pending.forEach((p, i) => {
      out.push({ index: p.index, id: results[i].rowsAffected === 1 ? p.id : null, status: results[i].rowsAffected === 1 ? "inserted" : "duplicate" });
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Approve a draft (or any unreviewed row): categorise + post. */
export async function approveDraft(viewer: FinanceViewer, txnId: string, categoryId?: string): Promise<void> {
  const txn = await loadTxn(txnId);
  if (!txn) throw new FinanceNotFound();
  const cat = categoryId || txn.category_id;
  if (!cat) throw new FinanceInputError("choose a category before approving");
  await categorizeTransaction(viewer, txnId, cat);
}

export async function importHistory(viewer: FinanceViewer, entityRef: string) {
  const entity = await requireEntity(viewer, entityRef);
  return query<{ id: string; filename: string; format: string; rows_total: number; rows_inserted: number; rows_duplicate: number; created_at: string; created_by: string }>(
    `SELECT id, filename, format, rows_total, rows_inserted, rows_duplicate, created_at, created_by FROM fin_imports WHERE entity_id = ? ORDER BY created_at DESC LIMIT 20`,
    [entity.id],
  );
}

