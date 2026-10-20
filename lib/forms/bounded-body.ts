/**
 * lib/forms/bounded-body.ts - how a public form route reads its JSON body.
 *
 * The routes that use it are open to anyone (middleware PUBLIC_PATH_PREFIXES),
 * and `await req.json()` buffers the whole body, up to what the platform lets
 * through (tens of MB), before a single check can run. Here the limit comes
 * first:
 *   - a Content-Length over the cap is refused without reading one byte;
 *   - a body with no Content-Length, or one that lies, is read through a running
 *     BYTE count (never characters: a multi-byte body would undercount) and the
 *     reader is cancelled the moment the count passes the cap, so it is never
 *     held whole.
 * A body inside the cap is decoded and parsed exactly as `req.json()` did
 * (UTF-8, BOM dropped, any JSON value), so a request that was fine stays fine.
 *
 * WHAT THE CAPS ARE (measured, with the method in tests/public-forms-bounded.test.ts):
 *   - /api/forms/submit takes the 60 MiB of inline files the route has always
 *     accepted per request (PER_REQUEST_DECODED_CAP_BYTES), which is 80 MiB of
 *     base64, plus 8 MiB for the answers: 20 times the largest text-only request
 *     measured (a 30-field form at every limit and a heavy e-signature, about
 *     0.4 MB). No cap can sit under the files without refusing files the route
 *     takes today; the answers are bounded one by one instead
 *     (lib/forms/answer-limits.ts).
 *   - view and upload-url take a signed link (144 characters) and, for an
 *     upload, a file name and type: about 0.4 KB. 16 KiB is 40 times that.
 */
import { NextResponse } from "next/server";

/** /api/forms/submit: the route's file limit as base64, plus the answers (see above). */
export const SUBMIT_BODY_CAP_BYTES = 88 * 1024 * 1024;

/** /api/forms/view and /api/forms/upload-url (see above). */
export const SMALL_BODY_CAP_BYTES = 16 * 1024;

export type BoundedJson =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

const TOO_LARGE: BoundedJson = { ok: false, reason: "too_large" };
const INVALID_JSON: BoundedJson = { ok: false, reason: "invalid_json" };

/** The JSON body of `req`, or why it cannot be had: over `maxBytes`, or not JSON. */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<BoundedJson> {
  // A fast path only: the enforcement is the running count below, because a
  // header can be absent (chunked) or wrong.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_LARGE;
  if (!req.body) return INVALID_JSON;
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("body_too_large").catch(() => undefined);
        return TOO_LARGE;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { ok: true, body: JSON.parse(parts.join("")) as unknown };
  } catch {
    // A body that is not JSON, or a connection that died mid-body: what
    // `req.json()` rejecting always meant to these routes.
    return INVALID_JSON;
  }
}

/**
 * The answer for a body that could not be had: 413 with one stable code for
 * "this request is bigger than we take" (the code the submit route already
 * used for files, and the form pages already have a sentence for), or 400
 * invalid_json. The size is logged here, since nothing else records it.
 */
export function bodyRefusal(
  where: string,
  req: Request,
  refused: Extract<BoundedJson, { ok: false }>,
  maxBytes: number,
): NextResponse {
  if (refused.reason === "too_large") {
    console.warn(`[${where}] request body over the cap; refused`, {
      cap_bytes: maxBytes,
      declared_bytes: req.headers.get("content-length"),
    });
    return NextResponse.json({ ok: false, error: "request_payload_too_large" }, { status: 413 });
  }
  return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
}
