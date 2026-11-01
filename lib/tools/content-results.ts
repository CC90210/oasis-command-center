/** Bounded reports from the content runner. No raw model output reaches the UI. */
export const CONTENT_TOOL_KEYS = ["video_remix", "hook_rewriter", "broll_matcher"] as const;
export type ContentToolKey = typeof CONTENT_TOOL_KEYS[number];
export const isContentTool = (v: unknown): v is ContentToolKey => typeof v === "string" && (CONTENT_TOOL_KEYS as readonly string[]).includes(v);
export type Hook = { platform: string; hook: string; script: string; caption: string };
export type BrollMatch = { keyword: string; title: string; url: string; license: string; score: number };
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

export function publicSourceUrl(v: unknown): v is string {
  if (!text(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) &&
      !/(^|\.)(localhost|local|internal|test|example|invalid)$/i.test(u.hostname);
  } catch { return false; }
}

export function parseContentResult(tool: ContentToolKey, value: unknown): { hooks: Hook[] } | { matches: BrollMatch[]; note: string } | null {
  const r = obj(value);
  if (!r) return null;
  if (tool === "hook_rewriter") {
    if (!Array.isArray(r.hooks) || r.hooks.length !== 5) return null;
    const hooks: Hook[] = [];
    for (const raw of r.hooks) {
      const h = obj(raw);
      if (!h || !["tiktok", "instagram", "youtube", "linkedin", "threads"].includes(String(h.platform)) ||
          !text(h.hook, 300) || !text(h.script, 3000) || !text(h.caption, 2200)) return null;
      hooks.push({ platform: String(h.platform), hook: h.hook, script: h.script, caption: h.caption });
    }
    if (new Set(hooks.map(h => h.platform)).size !== 5) return null;
    return { hooks };
  }
  if (tool === "broll_matcher") {
    if (!Array.isArray(r.matches) || r.matches.length > 20) return null;
    const matches: BrollMatch[] = [];
    for (const raw of r.matches) {
      const m = obj(raw);
      if (!m || !text(m.keyword, 180) || !text(m.title, 300) || !publicSourceUrl(m.url) || !text(m.license, 300) ||
          typeof m.score !== "number" || !Number.isFinite(m.score) || m.score < -1 || m.score > 1) return null;
      matches.push({ keyword: m.keyword, title: m.title, url: m.url, license: m.license, score: m.score });
    }
    return { matches, note: "Review source licensing before publishing. Similarity scores describe visual matches, not predicted performance." };
  }
  return null;
}

export type RemixUpload = { asset_id: string; storage_path: string; size_bytes: number; sha256: string; md5: string; title: string };
export type RemixManifest = { pending_uploads: RemixUpload[]; lease_id: string; retired_uploads?: string[] };
export function remixManifest(v: unknown): RemixManifest | null {
  const r = obj(v);
  if (!r || typeof r.lease_id !== "string" || !Array.isArray(r.pending_uploads) || r.pending_uploads.length !== 3) return null;
  return r as unknown as RemixManifest;
}
/** Only server-reserved paths, also tenant-checked by the storage cleanup caller. */
export function contentUploadPaths(v: unknown): string[] {
  const manifest = remixManifest(v);
  return manifest ? [...manifest.pending_uploads.map(f => f.storage_path), ...(manifest.retired_uploads ?? [])].filter((p): p is string => typeof p === "string") : [];
}
