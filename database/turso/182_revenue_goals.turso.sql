-- 182 - revenue goals: the Today countdown's single source of truth (2026-09-24).
--
-- The Today goal card read user_profiles.mrr_current_usd / mrr_target_usd /
-- mrr_target_date — numbers typed by hand ($6,263 against a $10,000 target on
-- 2026-09-30) with a silent $5,000 fallback when blank. CC reset OASIS to what
-- Stripe actually shows and set a new target: at least US$6,000 of revenue
-- COLLECTED between 2026-09-24 and 2026-10-24. A goal is now a row with a
-- period; progress is computed from the Finances ledger, never typed.
--
-- period_end is INCLUSIVE (the deadline day counts). One active goal per
-- tenant + metric, enforced by the partial unique index.

CREATE TABLE IF NOT EXISTS revenue_goals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  metric        TEXT NOT NULL DEFAULT 'revenue_collected'
                  CHECK (metric IN ('revenue_collected')),
  label         TEXT NOT NULL,
  target_cents  INTEGER NOT NULL CHECK (target_cents > 0),
  currency      TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'CAD')),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'closed', 'superseded')),
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  closed_at     TEXT,
  CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_goals_one_active
  ON revenue_goals (tenant_id, metric) WHERE status = 'active';

-- The October 2026 sprint for the OASIS workspace (tenant oasis-ai-cc).
INSERT OR IGNORE INTO revenue_goals
  (id, tenant_id, metric, label, target_cents, currency, period_start, period_end, status, created_by, created_at)
VALUES
  ('goal-oasis-2026-10', 'ef8d389e-3f15-43f2-ae00-3660f69a1452', 'revenue_collected',
   'October sprint — revenue collected', 600000, 'USD', '2026-09-24', '2026-10-24',
   'active', 'conaugh@oasisai.work', '2026-09-24T00:00:00.000Z');
