"use client";

/**
 * CCCrudTable — shared instrument-cluster chrome for the Constant Contact
 * "settings" CRUD tabs (Lists / Tags / Custom fields): create-row toolbar
 * slot, content-shaped skeleton loader, purposeful empty state, hairline
 * table with group-hover rows, and a standardized Actions cell (rename +
 * inline-confirm delete). Callers own all data fetching/mutation and hand
 * this component pre-rendered cells — it only owns the visual chrome, never
 * the fetch/notice/mutation logic (that stays in each tab per the
 * load()+notice pattern).
 */

import type { ReactNode } from "react";
import { Pencil, Trash2, Loader2 } from "lucide-react";
import { Card, EmptyState } from "@/components/Card";

export type CCCrudColumn<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
};

export type CCCrudNotice = { kind: "ok" | "err"; text: string } | null;

export type CCCrudActions<T> = {
  getId: (row: T) => string;
  /** Omit to hide the rename affordance entirely (e.g. custom fields). */
  onEditStart?: (row: T) => void;
  editingId?: string | null;
  /** Current value of the row being renamed — used only to gate the Save button. */
  editValue?: string;
  onEditSave?: (row: T) => void;
  onEditCancel?: () => void;
  saving?: boolean;
  onDelete: (row: T) => void;
  deleting?: boolean;
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
};

export function CCCrudTable<T,>({
  columns,
  rows,
  loading,
  error,
  notice,
  emptyMessage,
  renderCreate,
  onRefresh,
  actions,
  skeletonRows = 4,
}: {
  columns: CCCrudColumn<T>[];
  rows: T[];
  loading: boolean;
  error: string | null;
  notice: CCCrudNotice;
  emptyMessage: string;
  renderCreate: ReactNode;
  onRefresh: () => void;
  actions: CCCrudActions<T>;
  skeletonRows?: number;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {renderCreate}
        <button type="button" onClick={onRefresh} className="ml-auto text-[11px] text-fg-dim underline hover:text-fg-muted">
          Refresh
        </button>
      </div>

      {notice && (
        <div className={`text-[12px] ${notice.kind === "ok" ? "text-fg-muted" : "text-status-warm"}`}>{notice.text}</div>
      )}

      {loading ? (
        <Card noPadding>
          <div aria-busy="true" aria-live="polite" className="overflow-hidden rounded-xl">
            <div className="h-9 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 h-12 border-b border-bg-border/40 last:border-0"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="h-3.5 w-40 rounded-md bg-bg-elev animate-pulse-slow" />
                <div className="ml-auto h-5 w-12 rounded-md bg-bg-elev animate-pulse-slow" />
                <div className="h-6 w-16 rounded-md bg-bg-elev/70 animate-pulse-slow" />
              </div>
            ))}
          </div>
        </Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : rows.length === 0 ? (
        <Card noPadding><EmptyState message={emptyMessage} /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-fg-dim border-b border-bg-border">
                  {columns.map((c) => (
                    <th key={c.key} className={`px-4 py-2.5 font-medium ${c.align === "right" ? "text-right" : ""}`}>
                      {c.header}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const id = actions.getId(row);
                  const isEditing = actions.editingId === id;
                  const isConfirming = actions.confirmId === id;
                  return (
                    <tr key={id} className="group border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/40 transition-colors">
                      {columns.map((c) => (
                        <td key={c.key} className={`px-4 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                          {c.render(row)}
                        </td>
                      ))}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => actions.onEditSave?.(row)}
                                disabled={actions.saving || !actions.editValue?.trim()}
                                className="btn-secondary !py-1 !px-2.5 !text-[12px] inline-flex items-center gap-1.5 disabled:opacity-50"
                              >
                                {actions.saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={actions.onEditCancel}
                                disabled={actions.saving}
                                className="text-[12px] text-fg-dim hover:text-fg-muted disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : isConfirming ? (
                            <>
                              <span className="text-[12px] text-status-warm mr-1">Delete?</span>
                              <button
                                type="button"
                                onClick={() => actions.onDelete(row)}
                                disabled={actions.deleting}
                                className="btn-danger inline-flex items-center gap-1.5 disabled:opacity-50"
                              >
                                {actions.deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => actions.setConfirmId(null)}
                                disabled={actions.deleting}
                                className="text-[12px] text-fg-dim hover:text-fg-muted disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              {actions.onEditStart && (
                                <button
                                  type="button"
                                  onClick={() => actions.onEditStart?.(row)}
                                  aria-label="Rename"
                                  title="Rename"
                                  className="rounded-md border border-bg-border p-1.5 text-fg-dim transition-colors hover:text-fg hover:border-accent/40"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => actions.setConfirmId(id)}
                                aria-label="Delete"
                                title="Delete"
                                className="rounded-md border border-bg-border p-1.5 text-fg-dim transition-colors hover:text-status-hot hover:border-status-hot/40"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
