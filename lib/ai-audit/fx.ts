/**
 * lib/ai-audit/fx.ts — the Bank of Canada's USD/CAD rate, for CC to fill into AI audit settings with one press.
 *
 * It only suggests. A proposal is converted at the rate CC SAVED in settings (lib/ai-audit/store.ts fx_usd_cad),
 * never at one fetched while a proposal is drafted, saved or sent, so a price never moves under a draft by itself.
 * The Bank of Canada's Valet API is public and needs no key; it publishes one rate per business day.
 */
import "server-only";
import { FX_RATE_MAX_PPM, FX_RATE_MIN_PPM, type FxRate } from "@/lib/ai-audit/proposal";

export const BANK_OF_CANADA_USD_CAD = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1";

/** The newest observation in Valet's answer, as a rate; null when the answer is not the shape the Bank publishes. */
export function parseBankOfCanadaRate(body: unknown): FxRate | null {
  const observations = body && typeof body === "object" ? (body as { observations?: unknown }).observations : null;
  if (!Array.isArray(observations) || !observations.length) return null;
  const latest = observations[observations.length - 1] as { d?: unknown; FXUSDCAD?: { v?: unknown } } | null;
  const day = typeof latest?.d === "string" ? latest.d : "";
  const value = typeof latest?.FXUSDCAD?.v === "string" ? Number(latest.FXUSDCAD.v) : NaN;
  const ppm = Math.round(value * 1_000_000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(value) || ppm < FX_RATE_MIN_PPM || ppm > FX_RATE_MAX_PPM) return null;
  return { rate_ppm: ppm, as_of: day, source: "bank_of_canada" };
}

export async function fetchBankOfCanadaRate(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; rate: FxRate } | { ok: false; error: "unreachable" | "unreadable" }> {
  let res: Response;
  try {
    res = await fetchImpl(BANK_OF_CANADA_USD_CAD, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    console.error("[ai-audit.fx] the Bank of Canada could not be reached", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "unreachable" };
  }
  if (!res.ok) {
    console.error("[ai-audit.fx] the Bank of Canada answered", res.status);
    return { ok: false, error: "unreachable" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err) {
    console.error("[ai-audit.fx] the Bank of Canada's answer is not JSON", err instanceof Error ? err.message : String(err));
  }
  const rate = parseBankOfCanadaRate(body);
  if (!rate) {
    console.error("[ai-audit.fx] the Bank of Canada's answer holds no USD/CAD rate");
    return { ok: false, error: "unreadable" };
  }
  return { ok: true, rate };
}
