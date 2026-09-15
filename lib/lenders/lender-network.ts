export type LenderNetwork = "sunbiz" | "funmate";

/** Canonicalize historical FundMate spellings stored in lender JSON. */
export function lenderNetworkOf(data: Record<string, unknown>): LenderNetwork {
  const value = String(data.lender_network || data.network || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return value === "funmate" || value === "fundmate" ? "funmate" : "sunbiz";
}

export function activeLenderIdsForNetwork(
  lenders: Array<{ id: string; data: Record<string, unknown> }>,
  network: LenderNetwork,
): string[] {
  return lenders
    .filter((lender) => lender.data.active !== false && lenderNetworkOf(lender.data) === network)
    .map((lender) => lender.id)
    .filter(Boolean);
}
