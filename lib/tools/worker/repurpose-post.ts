/**
 * lib/tools/worker/repurpose-post.ts - "Repurpose a post": one post in, a
 * LinkedIn, an Instagram and a Threads version out, from ONE model call on the
 * workspace's own AI account (lib/tools/worker/ai.ts).
 *
 * The platform rules are the marketing team's (CMO-Agent
 * scripts/content_repurposer.py:46-71, max_chars and style; its em dash is a
 * hyphen here, the source stays ASCII), with its anti-slop line (:137-139). Its
 * "friend at 2am" brand voice is CC's own and is NOT used: this tool writes in
 * the author's voice, for any workspace. That script made one call per
 * platform; this makes one call that returns all three.
 *
 * A version over its platform's limit is shown with "Over the limit", never cut
 * short where nobody can see it.
 */
import "server-only";
import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { runToolModelCall, type ToolModelDeps } from "@/lib/tools/worker/ai";

export const REPURPOSE_PLATFORMS = ["linkedin", "instagram", "threads"] as const;
export type RepurposePlatform = (typeof REPURPOSE_PLATFORMS)[number];

const PLATFORM_RULES: Record<RepurposePlatform, { maxChars: number; style: string }> = {
  linkedin: {
    maxChars: 3000,
    style:
      "Professional but still authentic - write like a founder reflecting, not a corporate memo. " +
      "Put a line break after every 1-2 sentences for white-space readability. " +
      "Business-focused angle: frame the lesson or story in terms of building, growing, or running a business. " +
      "End with a takeaway or question to prompt comments. " +
      "Add 3-5 professional hashtags on a new line at the end.",
  },
  instagram: {
    maxChars: 2200,
    style:
      "Longer storytelling format. Open with a single hook line that stops the scroll. " +
      "Then tell the story in short paragraphs with line breaks between each. " +
      "End with a question or call to action. " +
      "Add 5-10 relevant hashtags on a new line at the very end, separated by spaces.",
  },
  threads: {
    maxChars: 500,
    style:
      "Slightly more conversational than X. One or two short paragraphs. " +
      "1-2 hashtags are fine at the end. Still tight and punchy.",
  },
};

export function repurposeSystemPrompt(): string {
  const rules = REPURPOSE_PLATFORMS.map(
    (p) => `${p.toUpperCase()}\n- Max ${PLATFORM_RULES[p].maxChars} characters\n- Style: ${PLATFORM_RULES[p].style}`,
  ).join("\n\n");
  return [
    "You adapt one social media post into three versions, one per platform below.",
    rules,
    "Keep the author's facts; add no claims.",
    "Write in the author's own voice: no hustle-culture jargon, no phrases like 'Unlock the power of' or 'Transform your'.",
    'Return STRICT JSON and nothing else, with exactly these keys: {"linkedin": string, "instagram": string, "threads": string}.',
    INJECTION_GUARD,
  ].join("\n\n");
}

export type Variant = { text: string; chars: number; max_chars: number; over_limit: boolean };
export type RepurposeResult = { variants: Record<RepurposePlatform, Variant>; provider: string; model: string };

/** Characters as a person counts them (code points, not UTF-16 units). */
const charCount = (s: string) => [...s].length;

/** The model's JSON, or null when any of the three is missing or not text. */
export function parseVariants(text: string): Record<RepurposePlatform, Variant> | null {
  const parsed = safeJsonExtract(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const out = {} as Record<RepurposePlatform, Variant>;
  for (const p of REPURPOSE_PLATFORMS) {
    const v = obj[p];
    if (typeof v !== "string" || !v.trim()) return null;
    const t = v.trim();
    const chars = charCount(t);
    out[p] = { text: t, chars, max_chars: PLATFORM_RULES[p].maxChars, over_limit: chars > PLATFORM_RULES[p].maxChars };
  }
  return out;
}

export async function runRepurposePost(
  input: { post: string },
  ctx: { tenantId: string; userId: string | null; jobId: string },
  ai?: ToolModelDeps,
): Promise<{ ok: true; result: RepurposeResult } | { ok: false; code: string }> {
  const r = await runToolModelCall(
    {
      ...ctx,
      surface: "tools.repurpose_post",
      system: repurposeSystemPrompt(),
      prompt: `Adapt this post for LinkedIn, Instagram and Threads.\n\n${wrapUntrusted(input.post, { label: "post", maxLen: 3000 })}`,
      maxTokens: 2500,
    },
    ai,
  );
  if (!r.ok) return r;
  const variants = parseVariants(r.text);
  if (!variants) return { ok: false, code: "ai_failed" };
  return { ok: true, result: { variants, provider: r.provider, model: r.model } };
}
