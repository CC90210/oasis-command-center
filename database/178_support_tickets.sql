-- 178: Support ticketing with SLA tracking.

CREATE TABLE IF NOT EXISTS support_tickets (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id    TEXT NOT NULL,
  reporter_id  TEXT,
  title        TEXT NOT NULL,
  description  TEXT,
  severity     TEXT DEFAULT 'medium',
  status       TEXT DEFAULT 'open',
  assigned_to  TEXT,
  resolution   TEXT,
  sla_target   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  resolved_at  TEXT,
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_st_tenant   ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_st_status   ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_st_severity ON support_tickets(severity);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ticket_id    TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  author       TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_internal  INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tc_ticket ON ticket_comments(ticket_id);
