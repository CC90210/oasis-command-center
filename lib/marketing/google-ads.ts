export const GOOGLE_ADS_TAG_ID = "AW-18509362419";

const PURCHASE_DESTINATION_RE = /^AW-18509362419\/[A-Za-z0-9_-]{4,128}$/;

export function googleAdsPurchaseDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const destination = value.trim();
  return PURCHASE_DESTINATION_RE.test(destination) ? destination : null;
}

export function purchaseConversionPayload(input: {
  valueCad: number;
  transactionId: string;
  sendTo: string;
}) {
  const sendTo = googleAdsPurchaseDestination(input.sendTo);
  if (!sendTo) return null;
  return {
    send_to: sendTo,
    value: input.valueCad,
    currency: "CAD" as const,
    transaction_id: input.transactionId,
  };
}
