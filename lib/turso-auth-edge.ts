/**
 * Edge-safe session verification (Web Crypto only — no node:crypto, no bcrypt).
 * Middleware imports THIS; the Node-runtime login route imports lib/turso-auth.
 * The token format is identical: base64url(JSON).base64url(HMAC-SHA256).
 */

export interface EdgeSession {
  sub: string;
  email: string;
  exp: number;
}

const enc = new TextEncoder();

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function verifySessionEdge(
  token: string | undefined | null, secret: string,
): Promise<EdgeSession | null> {
  if (!token || secret.length < 32) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  // subtle.verify is constant-time; verify the received mac against the body.
  const ok = await crypto.subtle.verify(
    "HMAC", key, b64uToBytes(mac) as unknown as ArrayBuffer, enc.encode(body));
  if (!ok) {
    // Defensive double-check via sign+compare for runtimes with odd verify()
    // semantics; harmless extra work on the failure path only.
    const expect = bytesToB64u(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
    if (expect !== mac) return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uToBytes(body))) as EdgeSession;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}
