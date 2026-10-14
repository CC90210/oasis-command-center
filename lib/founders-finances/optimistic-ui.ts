export type CustomerMetadata = {
  id: string;
  name: string;
  email: string;
  company: string;
  address: string;
  archived: number;
};

function projectedText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Customer identity and lifecycle stay server-owned. Only editable display
 * metadata is projected while a save is in flight, with an exact snapshot for
 * rollback if the server rejects the write.
 */
export function customerMetadataProjection<T extends CustomerMetadata>(
  customer: T,
  values: Record<string, unknown>,
): { projected: T; rollback: T } {
  const rollback = { ...customer };
  const projected = {
    ...customer,
    name: projectedText(values.name, customer.name),
    email: projectedText(values.email, customer.email),
    company: projectedText(values.company, customer.company),
    address: projectedText(values.address, customer.address),
  };

  return { projected, rollback };
}
