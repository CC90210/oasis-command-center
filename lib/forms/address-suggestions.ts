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

/** One OSM/Photon feature's `properties` bag, as far as we rely on it. */
export type PhotonProperties = {
  countrycode?: string;
  housenumber?: string;
  street?: string;
  name?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
};

/**
 * Turn Photon/OSM features into suggestions that are actually usable as a
 * MAILING address, and drop everything else.
 *
 * Photon is a street-level geocoder. Its features frequently describe a whole
 * street or a point of interest rather than a building, and when they do they
 * carry `name` but no `housenumber`/`street`, and `county` but no `city`. A
 * real feature bag captured live on 2026-09-10 for the query "7930 Snow View
 * Drive":
 *
 *   { name: "Snow View Drive", county: "Summit",    state: "Utah",       postcode: "84098" }
 *   { name: "Snow View Drive", county: "Riverside", state: "California"                    }
 *   { housenumber: "7930", street: "Prairie View Drive", city: "Indianapolis", … }
 *
 * The first was rendered "Snow View Drive, Summit, Utah, 84098" — the
 * merchant's house number silently dropped and a COUNTY printed as the city.
 * The second additionally had no postcode, so selecting it from our dropdown
 * failed our own capture gate with "Include the ZIP code" and then offered the
 * identical entry again: a closed loop with no exit. Only the third is an
 * address. Measured across 12 live queries, 26 of 56 suggestions had lost the
 * house number the merchant typed.
 *
 * Hence: a housenumber AND a street AND a 5-digit postcode AND a real `city`.
 * `county` is never promoted to city. Returning FEWER suggestions is the
 * correct trade — an empty dropdown leaves a plain text input the merchant can
 * complete, while a confident wrong answer sends a lender an address the
 * merchant does not occupy.
 *
 * Lives here, not in the route, so the test suite pins the real implementation
 * rather than a copy of it.
 */
export function photonFeaturesToSuggestions(
  features: Array<{ properties?: PhotonProperties }> | undefined,
  limit = 8,
): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const f of features || []) {
    const p = f?.properties || {};
    // US ONLY — never offer a foreign address (CC 2026-06-22).
    if ((p.countrycode || "").toUpperCase() !== "US") continue;
    const housenumber = (p.housenumber || "").trim();
    const street = (p.street || "").trim();
    // No building on a street => not a mailing address.
    if (!housenumber || !street) continue;
    const postcode = (p.postcode || "").trim();
    if (!/^\d{5}(?:-\d{4})?$/.test(postcode)) continue;
    // `city` ONLY — promoting `county` is what printed "Summit"/"Kent"/
    // "Riverside" where the merchant's city belonged.
    const city = (p.city || "").trim();
    const state = (p.state || "").trim();
    if (!city || !state) continue;
    // Country omitted — every suggestion is US, so it is implied.
    const label = `${housenumber} ${street}, ${city}, ${state}, ${postcode}`;
    // Dedupe case/whitespace-insensitively so the same physical address cannot
    // appear twice from slightly different OSM features.
    const key = label.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value: label });
    if (out.length >= limit) break;
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
