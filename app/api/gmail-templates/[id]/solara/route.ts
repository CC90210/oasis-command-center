/**
 * POST /api/gmail-templates/[id]/solara — generate a Solara copy variant for a
 * base plain-text Gmail template and ATTACH it to the template's variants.
 *
 * Mirrors the /api/agents/generate pattern (streamChat + JSON-only contract +
 * strict validation) with Solara's persona framing. The generated copy passes
 * the same fail-closed plain-text + compliance validation as human writes —
 * a variant that mentions lenders or emits HTML is rejected, never stored.
 *
 * Provider resolution: the tenant's "solara" agent config first, then the
 * tenant's "bravo" default, then the operator platform fallback.
 */

import { NextResponse, type NextRequest } from "next/server";
import { decryptField } from "@/lib/field-encryption";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { streamChat, type ChatMessage, type Provider } from "@/lib/providers";
import { getAgentModelForUser } from "@/lib/agent-resolver";
import { isOperatorEmail, operatorPlatformFallback } from "@/lib/operator-credentials";
import { validateGmailTemplateFields } from "@/lib/gmail-templates-server";
import {
  GMAIL_VARIANTS_MAX,
  gmailStageLabel,
  type GmailTemplate,
  type GmailTemplateVariant,
} from "@/lib/gmail-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_PROMPT = `You are SOLARA — the SunBiz operations agent who owns template production (variants are your lane, not Helios's).

You will receive a BASE plain-text Gmail template (name, pipeline stage, subject, body) and optional operator guidance. Produce ONE alternate copy variation of it.

Reply with EXACTLY ONE JSON object — no prose before or after, no code fences.

Schema:
{
  "label": string,    // short handle for this variant, max 60 chars, e.g. "Shorter + urgency" or "Warm follow-up angle"
  "subject": string,  // subject line, max 200 chars, plain text
  "body": string      // the email body, PLAIN TEXT ONLY, max 8000 chars
}

Hard rules:
- PLAIN TEXT ONLY. No HTML tags, no markdown, no rich formatting. Line breaks are fine.
- Keep every {{merge_token}} from the base template intact and in sensible positions. Do not invent new tokens.
- SunBiz is presented as a DIRECT funder. Never mention lenders, a lender network, funding partners, shopping a file, or brokering. Never name any lender.
- No em dashes or en dashes anywhere. Use commas, periods, or hyphens.
- Never claim "no credit pull/check". Eligibility, if mentioned: "$15,000+ in monthly revenue, 6+ months in business, U.S. business checking account".
- Keep the variant genuinely different from the base (angle, length, hook, or tone) while matching the pipeline stage's intent.
- Match the sender's human voice: concise, specific, no AI-sounding fluff openers.

Return the JSON only. No commentary.`;

function extractJson(s: string): string | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let guidance = "";
  try {
    const body = ((await req.json()) ?? {}) as { guidance?: unknown };
    if (typeof body.guidance === "string") guidance = body.guidance.trim().slice(0, 500);
  } catch {
    // No body is fine — guidance is optional.
  }

  const db = getServiceSupabase();
  const row = await db
    .from("gmail_templates")
    .select("*")
    .eq("tenant_id", sess.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (row.error) {
    return NextResponse.json(
      { ok: false, error: "fetch_failed", message: row.error.message },
      { status: 500 },
    );
  }
  if (!row.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const template = row.data as GmailTemplate;
  const variants = (template.variants ?? []) as GmailTemplateVariant[];
  if (variants.length >= GMAIL_VARIANTS_MAX) {
    return NextResponse.json(
      { ok: false, error: "variant_limit", message: `Max ${GMAIL_VARIANTS_MAX} variants per template — delete one first.` },
      { status: 400 },
    );
  }

  // Provider resolution: solara config → bravo default → operator fallback.
  let cfg = await getAgentModelForUser({
    tenantId: sess.tenantId,
    userId: sess.userId,
    agentKey: "solara",
  });
  if (!cfg?.encrypted_api_key) {
    cfg = await getAgentModelForUser({
      tenantId: sess.tenantId,
      userId: sess.userId,
      agentKey: "bravo",
    });
  }
  let provider: Provider;
  let model: string;
  let apiKey = "";
  if (cfg && cfg.encrypted_api_key) {
    provider = cfg.provider as Provider;
    model = cfg.model;
    try {
      apiKey = decryptField(cfg.encrypted_api_key);
    } catch {
      return NextResponse.json({ ok: false, error: "key_decrypt_failed" }, { status: 500 });
    }
  } else {
    const fallback = isOperatorEmail(sess.email || "") ? operatorPlatformFallback() : null;
    if (!fallback) {
      return NextResponse.json(
        { ok: false, error: "agent_not_configured", hint: "Configure the Solara (or Bravo) provider in Settings to generate variants." },
        { status: 412 },
      );
    }
    provider = fallback.provider;
    model = fallback.model;
    apiKey = fallback.apiKey;
  }

  const userMessage = [
    `BASE TEMPLATE`,
    `Name: ${template.name}`,
    `Pipeline stage: ${template.stage} (${gmailStageLabel(template.stage)})`,
    `Subject: ${template.subject || "(none)"}`,
    `Body:`,
    template.body,
    ``,
    `EXISTING VARIANT LABELS (make something different): ${variants.map((v) => v.label).join("; ") || "none yet"}`,
    guidance ? `OPERATOR GUIDANCE: ${guidance}` : ``,
  ].join("\n");

  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const isOllama = provider === "ollama";
  let aiText = "";
  let streamError: string | null = null;
  try {
    for await (const ev of streamChat({
      provider,
      model,
      apiKey: isOllama ? "" : apiKey,
      baseUrl: isOllama ? apiKey : undefined,
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: 1500,
    })) {
      if (ev.type === "delta") aiText += ev.text;
      else if (ev.type === "error") streamError = ev.message;
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : "stream_failed";
  }
  if (streamError) {
    return NextResponse.json({ ok: false, error: "llm_call_failed", message: streamError }, { status: 502 });
  }

  const candidate = extractJson(aiText);
  if (!candidate) {
    return NextResponse.json({ ok: false, error: "no_json" }, { status: 502 });
  }
  let parsed: { label?: unknown; subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(candidate) as typeof parsed;
  } catch {
    return NextResponse.json({ ok: false, error: "json_parse" }, { status: 502 });
  }

  const label =
    typeof parsed.label === "string" && parsed.label.trim()
      ? parsed.label.trim().slice(0, 60)
      : `Variant ${variants.length + 1}`;

  // The generated copy goes through the SAME fail-closed validation as a
  // human write: plain text only + compliance denylist.
  const validated = validateGmailTemplateFields(
    { name: label, stage: template.stage, subject: parsed.subject, body: parsed.body },
    { partial: false },
  );
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: "generated_copy_rejected", reason: validated.error, hits: validated.hits },
      { status: 422 },
    );
  }

  const variant: GmailTemplateVariant = {
    id: crypto.randomUUID(),
    label: validated.fields.name ?? label,
    subject: validated.fields.subject ?? "",
    body: validated.fields.body ?? "",
    source: "solara",
    created_at: new Date().toISOString(),
  };

  const res = await db
    .from("gmail_templates")
    .update({
      variants: [...variants, variant],
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", sess.tenantId)
    .eq("id", id)
    .select("*")
    .single();
  if (res.error) {
    return NextResponse.json(
      { ok: false, error: "attach_failed", message: res.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, template: res.data as GmailTemplate, variant });
}
