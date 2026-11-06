export const VAULT_SERVICE_IDS = ["shopify", "wise", "higgsfield"] as const;
export type VaultServiceId = (typeof VAULT_SERVICE_IDS)[number];
export type VaultServiceState = "not_configured" | "connected" | "error" | "unreachable";

export type VaultKeyGroup = { label: string; aliases: readonly string[] };
export type VaultServiceDefinition = {
  id: VaultServiceId;
  label: string;
  description: string;
  keyGroups: readonly VaultKeyGroup[];
};

export const VAULT_SERVICE_DEFINITIONS: readonly VaultServiceDefinition[] = [
  {
    id: "shopify",
    label: "Shopify",
    description: "Checks the Storefront API by reading the connected shop name.",
    keyGroups: [
      { label: "SHOPIFY_STORE_DOMAIN", aliases: ["shopify_store_domain", "shopify_store"] },
      { label: "SHOPIFY_STOREFRONT_ACCESS_TOKEN", aliases: ["shopify_storefront_access_token", "shopify_access_token"] },
    ],
  },
  {
    id: "wise",
    label: "Wise",
    description: "Checks the profiles endpoint with the saved personal API token.",
    keyGroups: [{ label: "WISE_API_TOKEN", aliases: ["wise_api_token"] }],
  },
  {
    id: "higgsfield",
    label: "Higgsfield",
    description: "Checks API authentication without starting a generation or spending credits.",
    keyGroups: [{ label: "HIGGSFIELD_API_KEY", aliases: ["higgsfield_api_key"] }],
  },
] as const;

export type VaultServiceCheck = {
  provider: VaultServiceId;
  label: string;
  state: VaultServiceState;
  detail: string;
  required_keys: string[];
  present: Record<string, boolean>;
  checked_at: string;
};

export function vaultServiceDefinition(raw: unknown): VaultServiceDefinition | null {
  if (typeof raw !== "string") return null;
  return VAULT_SERVICE_DEFINITIONS.find((item) => item.id === raw.trim().toLowerCase()) ?? null;
}
