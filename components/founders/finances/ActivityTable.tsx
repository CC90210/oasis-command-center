/**
 * ActivityTable — every recorded movement (lib/founders-finances/activity-io.ts):
 * bank lines, payments, refunds, bills and expenses, newest first. Used by the
 * Money overview's "Recent activity" and the Transactions tab's "All activity",
 * so both read the same rows the same way.
 *
 * Server component. Amounts are signed from the business's side; an unpaid
 * bill says so, so it is never read as money already gone.
 */
import { amountTone } from "@/components/founders/finances/ui";
import { ACTIVITY_KIND_LABEL, type ActivityRow } from "@/lib/founders-finances/activity-io";
import { formatCents } from "@/lib/founders-finances/money";

function statusText(r: ActivityRow): { text: string; warm: boolean } {
  switch (r.kind) {
    case "bank":
      return r.status === "unreviewed"
        ? { text: "Needs a category", warm: true }
        : r.status === "draft"
          ? { text: "Draft to approve", warm: true }
          : { text: "On the books", warm: false };
    case "payment":
    case "refund":
      return r.status === "not_posted" ? { text: "Not on the books yet", warm: true } : { text: "On the books", warm: false };
    case "bill":
      return r.status === "open" ? { text: r.due_date ? `Unpaid, due ${r.due_date}` : "Unpaid", warm: true } : { text: "Paid", warm: false };
    case "expense":
      return { text: "Paid", warm: false };
  }
}

export function ActivityTable({ rows }: { rows: readonly ActivityRow[] }) {
  const th = "px-4 py-2 text-left text-xs font-medium text-fg-dim";
  const td = "px-4 py-2.5 align-top";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline">
            <th className={th}>Date</th>
            <th className={th}>What</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((r) => {
            const s = statusText(r);
            const unpaid = r.kind === "bill" && r.status === "open";
            return (
              <tr key={`${r.kind}:${r.id}`}>
                <td className={`${td} whitespace-nowrap tabular-nums text-fg-muted`}>{r.date}</td>
                <td className={td}>
                  <div className="text-fg">{r.description}</div>
                  <div className="text-xs text-fg-dim">
                    {ACTIVITY_KIND_LABEL[r.kind]}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </div>
                </td>
                <td className={`${td} whitespace-nowrap text-xs ${s.warm ? "text-status-warm" : "text-fg-muted"}`}>{s.text}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums ${unpaid ? "text-fg-muted" : amountTone(r.amount_cents)}`}>
                  {formatCents(r.amount_cents, r.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
