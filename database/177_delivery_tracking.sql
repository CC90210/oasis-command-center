-- 177: Project delivery tracking — Kanban-style AI implementation tracker.

CREATE TABLE IF NOT EXISTS delivery_projects (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  stage        TEXT DEFAULT 'discovery',
  priority     TEXT DEFAULT 'medium',
  assigned_to  TEXT,
  due_date     TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dp_tenant   ON delivery_projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dp_stage    ON delivery_projects(stage);
CREATE INDEX IF NOT EXISTS idx_dp_assigned ON delivery_projects(assigned_to);

CREATE TABLE IF NOT EXISTS delivery_tasks (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT DEFAULT 'todo',
  assigned_to  TEXT,
  notes        TEXT,
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dt_project ON delivery_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_dt_tenant  ON delivery_tasks(tenant_id);

CREATE TABLE IF NOT EXISTS delivery_updates (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  author       TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_du_project ON delivery_updates(project_id);
