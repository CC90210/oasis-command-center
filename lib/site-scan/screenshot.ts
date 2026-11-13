/**
 * lib/site-scan/screenshot.ts — the picture of a scanned home page (database/turso/bravo__261).
 *
 * The runner takes it while it matches (scripts/site_scan/screenshot.py) and posts it under its
 * job's lease (POST /api/internal/tools/scan-screenshot). Only a real JPEG within
 * MAX_SCREENSHOT_BYTES is kept; the public page reads it through GET /api/scan/:id/screenshot.
 */
import type { Client } from "@libsql/client";

export const MAX_SCREENSHOT_BYTES = 250_000;

/** A JPEG starts FF D8 FF and ends FF D9; anything else is refused. */
export function isJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}

/** Base64 to bytes, or null when it is not base64 or not a JPEG within the size limit. */
export function decodeScreenshot(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 8) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return bytes.length <= MAX_SCREENSHOT_BYTES && isJpeg(bytes) ? bytes : null;
}

export function screenshotPath(scanId: string): string {
  return `/api/scan/${scanId}/screenshot`;
}

/** Keep the picture on its scan; true when the scan exists in that workspace. */
export async function saveScreenshot(db: Client, input: { tenantId: string; scanId: string; bytes: Uint8Array; now: Date }): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE site_scans SET screenshot_jpeg = ?, screenshot_at = ? WHERE tenant_id = ? AND id = ?",
    args: [input.bytes, input.now.toISOString(), input.tenantId, input.scanId],
  });
  return rs.rowsAffected === 1;
}

/** The pictures of the walk (bravo__262): at most this many per scan, each at most MAX_SHOT_BYTES. */
export const MAX_SHOTS = 10;
export const MAX_SHOT_BYTES = 150_000;
const MAX_PAGE_URL = 2_048;

export function shotPath(scanId: string, seq: number): string {
  return `/api/scan/${scanId}/shot/${seq}`;
}

/** A picture's place in the walk and the page it shows, as the runner posted them; null when either is not right. */
export function parseShotRef(seq: unknown, pageUrl: unknown): { seq: number; pageUrl: string } | null {
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq >= MAX_SHOTS) return null;
  if (typeof pageUrl !== "string" || pageUrl.length > MAX_PAGE_URL) return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return { seq, pageUrl: u.toString() };
  } catch {
    return null;
  }
}

/** Keep one picture of the walk on its scan; a repeat of the same seq (a retried job) replaces it. */
export async function saveShot(db: Client, input: { tenantId: string; scanId: string; seq: number; pageUrl: string; bytes: Uint8Array; now: Date }): Promise<boolean> {
  if (input.bytes.length > MAX_SHOT_BYTES) return false;
  const rs = await db.execute({
    sql: `INSERT INTO site_scan_shots (tenant_id, scan_id, seq, page_url, jpeg, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, scan_id, seq) DO UPDATE SET page_url = excluded.page_url, jpeg = excluded.jpeg, created_at = excluded.created_at`,
    args: [input.tenantId, input.scanId, input.seq, input.pageUrl, input.bytes, input.now.toISOString()],
  });
  return rs.rowsAffected >= 1;
}

export async function readShot(db: Client, input: { tenantId: string; scanId: string; seq: number }): Promise<Uint8Array<ArrayBuffer> | null> {
  const rs = await db.execute({ sql: "SELECT jpeg FROM site_scan_shots WHERE tenant_id = ? AND scan_id = ? AND seq = ? LIMIT 1", args: [input.tenantId, input.scanId, input.seq] });
  return bytesOf(rs.rows[0]?.jpeg);
}

export function shotsTableMissing(err: unknown): boolean {
  return err instanceof Error && /no such table: site_scan_shots/i.test(err.message);
}

function bytesOf(v: unknown): Uint8Array<ArrayBuffer> | null {
  // libSQL hands a BLOB back as an ArrayBuffer; a local driver may give a Uint8Array view.
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (v instanceof Uint8Array) return new Uint8Array(v);
  return null;
}

/** The stored picture, copied into its own buffer (a Response body), or null. */
export async function readScreenshot(db: Client, input: { tenantId: string; scanId: string }): Promise<Uint8Array<ArrayBuffer> | null> {
  const rs = await db.execute({ sql: "SELECT screenshot_jpeg FROM site_scans WHERE tenant_id = ? AND id = ? LIMIT 1", args: [input.tenantId, input.scanId] });
  return bytesOf(rs.rows[0]?.screenshot_jpeg);
}
