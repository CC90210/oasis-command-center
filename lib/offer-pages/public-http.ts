/**
 * lib/offer-pages/public-http.ts - the guards both public offer-page routes
 * (/api/offer-page/video, /api/offer-page/captions) run before they read
 * anything: same-origin, a rate cap per address, and strict ids.
 *
 * These routes are public (middleware PUBLIC_PATH_PREFIXES "/api/offer-page/")
 * because a visitor has no session. They give nothing away: every refusal of
 * a form, ref or asset is the same 404, so they cannot be used to find out
 * which forms, pages or videos exist.
 */
import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { VIDEO_REF_RE } from "./providers";

/** A form id: a UUID or the 32-hex shape older rows use. */
const FORM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const NOT_FOUND = () =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

/** Origin (or, failing that, Referer) names this host. Missing or unparseable: refused. */
export function sameOrigin(req: Request): boolean {
  let host = req.headers.get("host");
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      return false;
    }
  }
  if (!host) return false;
  for (const header of ["origin", "referer"]) {
    const value = req.headers.get(header);
    if (!value) continue;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

/** 30 requests, refilling one every two seconds, per address and route. */
export function limited(req: Request, route: string): boolean {
  const resolved = clientIpFromHeaders(req.headers);
  const ip = resolved === "unknown" ? "no-ip" : resolved;
  return !rateLimit({ key: `offer-page:${route}:${ip}`, capacity: 30, refillPerSec: 0.5 }).allowed;
}

export function validIds(formId: unknown, ref: unknown): { formId: string; ref: string } | null {
  if (typeof formId !== "string" || !FORM_ID_RE.test(formId)) return null;
  if (typeof ref !== "string" || !VIDEO_REF_RE.test(ref)) return null;
  return { formId, ref };
}

/** The body, read through a byte cap that aborts the moment it is crossed. */
export async function readCappedJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
