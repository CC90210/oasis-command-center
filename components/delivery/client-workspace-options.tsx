/**
 * The options of the "Client portal workspace" select on a ticket and on a
 * project (OASIS's desk only).
 *
 * `options` holds the workspaces a row may be linked to now, and a retired
 * business is never one of them (lib/os/customers/retired.ts). A row linked
 * before its business was retired still names that workspace, so it gets an
 * option of its own: shown, so the select says what the row is linked to, and
 * disabled, so it is never chosen again. Choosing the "none" option clears the
 * link. Without it the browser would show the "none" option while the row
 * stays linked, and choosing "none" would change nothing.
 */
import type { Option } from "@/components/delivery/useDeliveryAction";

export function ClientWorkspaceOptions({
  current,
  options,
  noneLabel,
}: {
  /** The row's stored link (client_tenant_id), or null. */
  current: string | null | undefined;
  options: Option[];
  noneLabel: string;
}) {
  return (
    <>
      <option value="">{noneLabel}</option>
      {current && !options.some((o) => o.value === current) && (
        <option value={current} disabled>
          Former client workspace
        </option>
      )}
      {options.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </>
  );
}
