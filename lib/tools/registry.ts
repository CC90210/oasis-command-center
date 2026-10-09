/**
 * lib/tools/registry.ts - the Toolkit's tools: what each one is called, what it
 * asks for, where it runs, and the ONE validator for its input.
 *
 * PURE. No server imports: the client grid (components/tools/ToolGrid.tsx)
 * imports this file to draw each card's fields and to run the same validator
 * before it enables Run, and the server routes import it to refuse anything
 * else. Only a key in TOOL_REGISTRY can ever be queued (POST /api/tools/run)
 * or claimed by a runner (POST /api/internal/tools/claim).
 *
 * Two places a tool runs:
 *   worker  inside the request that asked for it (app/api/tools/run), with
 *           an executor in lib/tools/worker/index.ts;
 *   runner  on a computer that checks in with a signed request and claims the
 *           job (lib/tools/runner-handlers.ts). Today one runner exists: the
 *           video downloader on OASIS's own PC.
 *
 * A validator returns the cleaned value that is stored and run, never the raw
 * input, and a dedupe key when two runs of the same thing must not be in flight
 * at once (tool_jobs.uq_tool_jobs_tenant_inflight).
 */
import {
  CORPUS_LABELS,
  CORPUS_LABEL_COPY,
  normalizeUrl,
  parseIngestUrl,
  type CorpusLabel,
} from "@/lib/founders/ingest-core";

export type ToolKey = "video_download" | "learn_from_link" | "score_hook" | "repurpose_post";

export type ToolField = {
  name: string;
  label: string;
  kind: "url" | "text" | "textarea" | "select";
  required: boolean;
  maxLength?: number;
  minLength?: number;
  options?: { value: string; label: string }[];
  /** The value a select starts on. */
  defaultValue?: string;
};

export type ToolValidation =
  | { ok: true; value: Record<string, unknown>; dedupeKey: string | null }
  | { ok: false; field: string; code: string };

export type ToolDef = {
  key: ToolKey;
  title: string;
  description: string;
  runLabel: string;
  runsOn: "worker" | "runner";
  needsAiAccount: boolean;
  produces: "library_asset" | "training_note" | "score" | "text";
  fields: ToolField[];
  validate(input: unknown): ToolValidation;
};

/** The longest link either URL tool accepts, before and after canonicalising. */
export const MAX_URL_LENGTH = 2048;
export const HOOK_MAX = 500;
export const CAPTION_MAX = 2200;
export const POST_MIN = 20;
export const POST_MAX = 3000;

function fieldsOf(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** No control characters except tab and line breaks (a pasted caption keeps its lines). */
function hasControlCharacters(s: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}

type UrlCheck = { ok: true; url: URL } | { ok: false; code: string };

/**
 * The checks both URL tools share, on the link as a person pasted it: present,
 * not over the cap, http(s), not aimed inside a network (ingest-core's
 * normalizeUrl), and with no user name, password or port. A port or a user in a
 * link is never how a post or an article is shared, and both are how a fetch
 * gets aimed somewhere it should not go.
 */
function checkPastedUrl(raw: unknown): UrlCheck {
  const s = text(raw);
  if (!s) return { ok: false, code: "required" };
  if (s.length > MAX_URL_LENGTH) return { ok: false, code: "too_long" };
  const u = normalizeUrl(s);
  if (!u) return { ok: false, code: "invalid_url" };
  if (u.username || u.password || u.port) return { ok: false, code: "invalid_url" };
  return { ok: true, url: u };
}

const VIDEO_KINDS = new Set(["youtube", "instagram", "tiktok"]);

const videoDownload: ToolDef = {
  key: "video_download",
  title: "Download a video",
  description: "Paste an Instagram, TikTok or YouTube link. The video is saved to the Library.",
  runLabel: "Download",
  runsOn: "runner",
  needsAiAccount: false,
  produces: "library_asset",
  fields: [{ name: "url", label: "Link", kind: "url", required: true, maxLength: MAX_URL_LENGTH }],
  validate(input) {
    const f = fieldsOf(input);
    if (!f) return { ok: false, field: "url", code: "required" };
    const pasted = checkPastedUrl(f.url);
    if (!pasted.ok) return { ok: false, field: "url", code: pasted.code };
    const parsed = parseIngestUrl(pasted.url.toString());
    if (!parsed.ok) return { ok: false, field: "url", code: "unsupported_url" };
    const t = parsed.target;
    // A profile link parses as Instagram but is not a post: only a link to ONE
    // video can be downloaded.
    if (!VIDEO_KINDS.has(t.kind) || t.extractor !== "video") return { ok: false, field: "url", code: "unsupported_url" };
    // The canonical link, always https. A TikTok short link keeps its own URL
    // (ingest-core cannot resolve it without a network hop), so its scheme is
    // forced here; the runner follows the short link itself.
    const canonical = new URL(t.canonicalUrl);
    canonical.protocol = "https:";
    const url = canonical.toString();
    if (url.length > MAX_URL_LENGTH) return { ok: false, field: "url", code: "too_long" };
    return { ok: true, value: { url, platform: t.kind }, dedupeKey: `video_download:${url}` };
  },
};

const learnFromLink: ToolDef = {
  key: "learn_from_link",
  title: "Learn from a link",
  description: "Reads a web page or GitHub repo and writes down its hook, pacing and tone as a training note.",
  runLabel: "Learn",
  runsOn: "worker",
  needsAiAccount: true,
  produces: "training_note",
  fields: [
    { name: "url", label: "Link", kind: "url", required: true, maxLength: MAX_URL_LENGTH },
    {
      name: "label",
      label: "This is",
      kind: "select",
      required: true,
      options: CORPUS_LABELS.map((l) => ({ value: l, label: CORPUS_LABEL_COPY[l].title })),
      defaultValue: "exemplar",
    },
  ],
  validate(input) {
    const f = fieldsOf(input);
    if (!f) return { ok: false, field: "url", code: "required" };
    const pasted = checkPastedUrl(f.url);
    if (!pasted.ok) return { ok: false, field: "url", code: pasted.code };
    const parsed = parseIngestUrl(pasted.url.toString());
    if (!parsed.ok) return { ok: false, field: "url", code: "invalid_url" };
    const t = parsed.target;
    // Reels, TikToks and YouTube videos need the downloader and a transcript,
    // not a page read: refused here rather than learned from an empty shell.
    if (VIDEO_KINDS.has(t.kind)) return { ok: false, field: "url", code: "video_link_not_supported" };
    if (t.kind !== "web" && t.kind !== "github") return { ok: false, field: "url", code: "invalid_url" };
    if (t.canonicalUrl.length > MAX_URL_LENGTH) return { ok: false, field: "url", code: "too_long" };
    const rawLabel = text(f.label) || "exemplar";
    if (!(CORPUS_LABELS as readonly string[]).includes(rawLabel)) return { ok: false, field: "label", code: "invalid_choice" };
    return {
      ok: true,
      value: {
        url: t.canonicalUrl,
        label: rawLabel as CorpusLabel,
        source_kind: t.kind,
        extractor: t.extractor,
        external_id: t.externalId,
        title: t.label,
      },
      dedupeKey: `learn_from_link:${t.canonicalUrl}`,
    };
  },
};

const scoreHook: ToolDef = {
  key: "score_hook",
  title: "Score a hook",
  description: "Scores an opening line and says what it is missing.",
  runLabel: "Score",
  runsOn: "worker",
  needsAiAccount: false,
  produces: "score",
  fields: [
    { name: "hook", label: "Hook", kind: "text", required: true, minLength: 1, maxLength: HOOK_MAX },
    { name: "caption", label: "Caption (optional)", kind: "textarea", required: false, maxLength: CAPTION_MAX },
  ],
  validate(input) {
    const f = fieldsOf(input);
    if (!f) return { ok: false, field: "hook", code: "required" };
    const hook = text(f.hook);
    if (!hook) return { ok: false, field: "hook", code: "required" };
    if (hook.length > HOOK_MAX) return { ok: false, field: "hook", code: "too_long" };
    if (hasControlCharacters(hook)) return { ok: false, field: "hook", code: "invalid_characters" };
    if (f.caption !== undefined && f.caption !== null && typeof f.caption !== "string") {
      return { ok: false, field: "caption", code: "invalid" };
    }
    const caption = text(f.caption);
    if (caption.length > CAPTION_MAX) return { ok: false, field: "caption", code: "too_long" };
    if (hasControlCharacters(caption)) return { ok: false, field: "caption", code: "invalid_characters" };
    return { ok: true, value: { hook, caption }, dedupeKey: null };
  },
};

const repurposePost: ToolDef = {
  key: "repurpose_post",
  title: "Repurpose a post",
  description: "Turns one post into versions for LinkedIn, Instagram and Threads.",
  runLabel: "Repurpose",
  runsOn: "worker",
  needsAiAccount: true,
  produces: "text",
  fields: [{ name: "post", label: "Post", kind: "textarea", required: true, minLength: POST_MIN, maxLength: POST_MAX }],
  validate(input) {
    const f = fieldsOf(input);
    if (!f) return { ok: false, field: "post", code: "required" };
    const post = text(f.post);
    if (!post) return { ok: false, field: "post", code: "required" };
    if (post.length < POST_MIN) return { ok: false, field: "post", code: "too_short" };
    if (post.length > POST_MAX) return { ok: false, field: "post", code: "too_long" };
    if (hasControlCharacters(post)) return { ok: false, field: "post", code: "invalid_characters" };
    return { ok: true, value: { post }, dedupeKey: null };
  },
};

/** Every tool, in the order the grid shows them. */
export const TOOL_REGISTRY: readonly ToolDef[] = [scoreHook, repurposePost, learnFromLink, videoDownload];

export function toolByKey(k: unknown): ToolDef | null {
  return typeof k === "string" ? (TOOL_REGISTRY.find((t) => t.key === k) ?? null) : null;
}

/** The keys a runner may claim: registry tools that run on a runner. */
export function runnerToolKeys(): ToolKey[] {
  return TOOL_REGISTRY.filter((t) => t.runsOn === "runner").map((t) => t.key);
}
