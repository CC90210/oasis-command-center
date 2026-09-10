export type AddressSuggestion = {
  label: string;
  value: string;
  placeId?: string;
};

/** Accept legacy string responses as well as structured provider responses. */
export function normalizeAddressSuggestions(value: unknown): AddressSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: AddressSuggestion[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ label: text, value: text });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const resolved = typeof raw.value === "string" ? raw.value.trim() : label;
    const placeId = typeof raw.placeId === "string" ? raw.placeId.trim() : "";
    if (label && resolved) out.push({ label, value: resolved, ...(placeId ? { placeId } : {}) });
  }
  return out;
}

export function googleAutocompleteSuggestions(payload: unknown, limit = 8): AddressSuggestion[] {
  if (!payload || typeof payload !== "object") return [];
  const predictions = (payload as { predictions?: unknown }).predictions;
  if (!Array.isArray(predictions)) return [];
  return predictions.flatMap((prediction) => {
    if (!prediction || typeof prediction !== "object") return [];
    const p = prediction as Record<string, unknown>;
    const label = typeof p.description === "string" ? p.description.trim() : "";
    const placeId = typeof p.place_id === "string" ? p.place_id.trim() : "";
    return label && placeId ? [{ label, value: label, placeId }] : [];
  }).slice(0, limit);
}
