/**
 * lib/meet/ice.ts - the ICE servers a participant's browser connects with.
 *
 * STUN (stun.cloudflare.com) finds a direct path; TURN relays media when a network
 * blocks one (a hotel, a company firewall), which a prospect on their office wifi
 * will hit. TURN credentials are short-lived and minted here per join from the
 * workspace's Cloudflare TURN key (CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN), so the
 * key itself never leaves the server. TURN used with the Realtime SFU is not billed
 * (https://developers.cloudflare.com/realtime/turn/).
 *
 * TURN is best effort: no key, or Cloudflare not answering, still returns STUN, and
 * most calls connect on STUN alone. The failure is logged, never hidden.
 */
import "server-only";

export const TURN_KEY_ID_ENV = "CF_TURN_KEY_ID";
export const TURN_KEY_TOKEN_ENV = "CF_TURN_KEY_API_TOKEN";
export const STUN_ONLY: RTCIceServerLike[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
/** As long as a participant token: a credential must outlast the longest call. */
const TURN_TTL_S = 12 * 60 * 60;
const TURN_TIMEOUT_MS = 5_000;

export type RTCIceServerLike = { urls: string[]; username?: string; credential?: string };

/** Port 53 is blocked by browsers (Cloudflare's own note): an entry there only makes a browser wait for a timeout. */
function usable(url: string): boolean {
  return !/:53(\?|$)/.test(url);
}

export async function meetIceServers(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<RTCIceServerLike[]> {
  const keyId = env[TURN_KEY_ID_ENV];
  const token = env[TURN_KEY_TOKEN_ENV];
  if (!keyId || !token) return STUN_ONLY;
  try {
    const res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TURN credentials answered ${res.status}`);
    const json = (await res.json()) as { iceServers?: Array<{ urls?: unknown; username?: unknown; credential?: unknown }> };
    const servers = (json.iceServers ?? [])
      .map((s) => ({
        urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u): u is string => typeof u === "string" && usable(u)),
        ...(typeof s.username === "string" ? { username: s.username } : {}),
        ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
      }))
      .filter((s) => s.urls.length > 0);
    if (!servers.length) throw new Error("TURN credentials carried no usable server");
    return servers;
  } catch (err) {
    console.error("[meet.ice] TURN credentials unavailable; STUN only", err instanceof Error ? err.message : String(err));
    return STUN_ONLY;
  }
}
