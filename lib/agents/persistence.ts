/**
 * Persistence for user-created custom agents. Mirrors the patterns used for
 * tenant_manifests in lib/manifest/persistence.ts: service-role writes,
 * defensive validation, structured error type.
 *
 * Platform-managed seeds (is_oasis_managed=true) are NEVER created or
 * mutated through this layer — they live in lib/agents/library.ts under
 * tsc supervision. This layer only handles user customs (is_oasis_managed
 * is forced to false on every write).
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { isHouseAgentSlug } from "@/lib/agents";
import { dbBool } from "@/lib/db-bool";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { getSeedAgent } from "./library";
import type {
  AgentCategory,
  AgentLibraryEntry,
  AgentPricing,
} from "./library";

export class AgentPersistenceError extends Error {
  constructor(
    public code: "validation" | "duplicate_slug" | "not_found" | "forbidden" | "db",
    message: string
  ) {
    super(message);
    this.name = "AgentPersistenceError";
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Slugs a custom agent cannot take. A teammate's chat is /agents/<slug> and the
 * builder is /agents/new (app/agents/new); Next serves the static segment
 * first, so a teammate named "new" would have a chat nobody could open.
 *
 * An OASIS house agent's slug or alias (lib/agents.ts isHouseAgentSlug) is
 * taken too: outside OASIS's own workspace no surface shows a teammate under
 * one (lib/os/teammates.ts, lib/os/agent-names.ts), so a teammate a client
 * built on it would vanish the moment it was saved.
 *
 * And every built-in library agent's slug (lib/agents/library.ts SEED_AGENTS:
 * sdr, customer-support, qa-reviewer, research-analyst, ...). The loader reads
 * the database before the seeds, so a row under "sdr" stood in for the Sales
 * agent; published, in every workspace, running that workspace's department
 * turns on a prompt one admin wrote (2026-10-19 audit; no such row existed).
 */
export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = new Set(["new"]);

/** A slug no custom agent may take: reserved, a house agent, or a built-in library agent. */
export function isReservedAgentSlug(slug: string): boolean {
  const key = slug.trim().toLowerCase();
  return RESERVED_AGENT_SLUGS.has(key) || isHouseAgentSlug(key) || getSeedAgent(key) !== null;
}

/**
 * Who is writing. Publishing puts an agent in EVERY workspace's library (the
 * loader serves public rows to all of them), so it is OASIS's call: a route
 * passes `mayPublish: true` only for a session it verified as a platform
 * operator. The default publishes nothing.
 */
export type AgentWriter = { mayPublish: boolean };
const NOT_A_PUBLISHER: AgentWriter = { mayPublish: false };

export const PUBLISH_REFUSED = "Only OASIS can publish an agent to every workspace.";
export const PUBLISH_FROM_OASIS = "Publish an agent from OASIS's own workspace: it is the only one whose public agents every workspace sees.";
export const PUBLISHED_CHANGE_REFUSED =
  "This agent is published to every workspace, so only OASIS can change or delete it. You can still unpublish it.";

/**
 * The is_public a write may store. Absent stays absent; anything but a boolean
 * is refused; true needs a writer who may publish, writing in OASIS's own
 * workspace (the loader serves no other workspace's public rows to anyone
 * else, lib/agents/loader.ts servedTo). Decided here, in the one module that
 * writes agents, because the routes used to check `body.is_public === true`
 * and then write the raw value, so a PATCH with `is_public: 1` published
 * (independent review of #713: SQLite stores 1, which the public filter matches).
 */
function checkedPublish(raw: unknown, writer: AgentWriter, tenantId: string | null): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new AgentPersistenceError("validation", "is_public must be true or false");
  if (raw && !writer.mayPublish) throw new AgentPersistenceError("forbidden", PUBLISH_REFUSED);
  if (raw && tenantId !== OASIS_OPERATOR_TENANT_ID) throw new AgentPersistenceError("validation", PUBLISH_FROM_OASIS);
  return raw;
}

const ALLOWED_CATEGORIES = new Set<AgentCategory>([
  "ceo", "cfo", "cmo", "coo", "operations", "sales", "support",
  "research", "content", "engineering", "finance", "legal",
  "industry_real_estate", "industry_funding", "industry_ecommerce",
  "industry_agency", "custom",
]);

export type CreateAgentInput = {
  slug: string;
  name: string;
  category: AgentCategory;
  short_description: string;
  description?: string;
  base_prompt: string;
  required_tools?: string[];
  suggested_model?: string;
  pricing?: AgentPricing;
  is_public?: boolean;
  created_by: string;
  tenant_id: string;
};

function validateAgentInput(input: CreateAgentInput): void {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new AgentPersistenceError("validation", "slug must match /^[a-z0-9][a-z0-9-]{1,62}$/");
  }
  if (isReservedAgentSlug(slug)) {
    throw new AgentPersistenceError("validation", `slug "${slug}" is reserved; choose another URL slug`);
  }
  if (!input.name.trim()) {
    throw new AgentPersistenceError("validation", "name is required");
  }
  if (!ALLOWED_CATEGORIES.has(input.category)) {
    throw new AgentPersistenceError("validation", `unknown category "${input.category}"`);
  }
  if (!input.short_description.trim()) {
    throw new AgentPersistenceError("validation", "short_description is required");
  }
  if (!input.base_prompt.trim() || input.base_prompt.length < 30) {
    throw new AgentPersistenceError("validation", "base_prompt is required (minimum 30 characters)");
  }
  if (input.base_prompt.length > 16000) {
    throw new AgentPersistenceError("validation", "base_prompt too long (max 16000 characters)");
  }
  if (input.required_tools && input.required_tools.length > 32) {
    throw new AgentPersistenceError("validation", "required_tools capped at 32");
  }
}

export async function createCustomAgent(
  input: CreateAgentInput,
  writer: AgentWriter = NOT_A_PUBLISHER,
): Promise<AgentLibraryEntry> {
  validateAgentInput(input);
  // Always written: the production column defaults to public.
  const isPublic = checkedPublish(input.is_public, writer, input.tenant_id) ?? false;
  const slug = input.slug.trim().toLowerCase();
  const db = getServiceSupabase();

  const existing = await db.from("agents").select("slug").eq("slug", slug).maybeSingle();
  if (existing.error) throw new AgentPersistenceError("db", existing.error.message);
  if (existing.data) throw new AgentPersistenceError("duplicate_slug", `slug "${slug}" already taken`);

  const row = {
    slug,
    name: input.name.trim(),
    category: input.category,
    short_description: input.short_description.trim(),
    description: input.description?.trim() || null,
    base_prompt: input.base_prompt.trim(),
    required_tools: input.required_tools || [],
    suggested_model: input.suggested_model || null,
    pricing: (input.pricing || { tier: "free" }) as unknown as Record<string, unknown>,
    is_public: isPublic,
    is_oasis_managed: false,
    created_by: input.created_by,
    tenant_id: input.tenant_id,
  };
  const inserted = await db.from("agents").insert(row).select("*").single();
  if (inserted.error) throw new AgentPersistenceError("db", inserted.error.message);
  return inserted.data as AgentLibraryEntry;
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "slug" | "tenant_id" | "created_by">> & {
  slug: string;
  tenant_id: string;
};

export async function updateCustomAgent(
  input: UpdateAgentInput,
  writer: AgentWriter = NOT_A_PUBLISHER,
): Promise<AgentLibraryEntry> {
  const slug = input.slug.trim().toLowerCase();
  const db = getServiceSupabase();
  const existing = await db
    .from("agents")
    .select("id, tenant_id, is_oasis_managed, is_public")
    .eq("slug", slug)
    .maybeSingle();
  if (existing.error) throw new AgentPersistenceError("db", existing.error.message);
  if (!existing.data) throw new AgentPersistenceError("not_found", `agent "${slug}" not found`);
  const row = existing.data as { id: string; tenant_id: string | null; is_oasis_managed: unknown; is_public: unknown };
  if (dbBool(row.is_oasis_managed)) {
    throw new AgentPersistenceError("forbidden", "platform-managed agents cannot be edited through this endpoint");
  }
  if (row.tenant_id !== input.tenant_id) {
    throw new AgentPersistenceError("forbidden", "this agent belongs to a different tenant");
  }
  const isPublic = checkedPublish(input.is_public, writer, row.tenant_id);

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.category !== undefined) {
    if (!ALLOWED_CATEGORIES.has(input.category)) {
      throw new AgentPersistenceError("validation", `unknown category "${input.category}"`);
    }
    patch.category = input.category;
  }
  if (input.short_description !== undefined) patch.short_description = input.short_description.trim();
  if (input.description !== undefined) patch.description = input.description.trim() || null;
  if (input.base_prompt !== undefined) {
    if (input.base_prompt.length < 30 || input.base_prompt.length > 16000) {
      throw new AgentPersistenceError("validation", "base_prompt must be 30-16000 characters");
    }
    patch.base_prompt = input.base_prompt.trim();
  }
  if (input.required_tools !== undefined) {
    if (input.required_tools.length > 32) {
      throw new AgentPersistenceError("validation", "required_tools capped at 32");
    }
    patch.required_tools = input.required_tools;
  }
  if (input.suggested_model !== undefined) patch.suggested_model = input.suggested_model || null;
  if (input.pricing !== undefined) patch.pricing = input.pricing as unknown as Record<string, unknown>;
  if (isPublic !== undefined) patch.is_public = isPublic;

  // A published agent is in every workspace's library, so changing it is
  // publishing again: OASIS's call. Its own workspace may still take it down
  // (is_public false and nothing else). Only the flag used to be gated, so an
  // OASIS admin who is not a platform operator could rewrite a published prompt
  // (independent review of #713).
  const unpublishOnly = Object.keys(patch).length === 1 && patch.is_public === false;
  if (dbBool(row.is_public) && !writer.mayPublish && Object.keys(patch).length > 0 && !unpublishOnly) {
    throw new AgentPersistenceError("forbidden", PUBLISHED_CHANGE_REFUSED);
  }

  if (Object.keys(patch).length === 0) {
    return (await db.from("agents").select("*").eq("id", row.id).single()).data as AgentLibraryEntry;
  }

  const updated = await db.from("agents").update(patch).eq("id", row.id).select("*").single();
  if (updated.error) throw new AgentPersistenceError("db", updated.error.message);
  return updated.data as AgentLibraryEntry;
}

export async function deleteCustomAgent(
  slug: string,
  tenantId: string,
  writer: AgentWriter = NOT_A_PUBLISHER,
): Promise<void> {
  const db = getServiceSupabase();
  const existing = await db
    .from("agents")
    .select("id, tenant_id, is_oasis_managed, is_public")
    .eq("slug", slug)
    .maybeSingle();
  if (existing.error) throw new AgentPersistenceError("db", existing.error.message);
  if (!existing.data) throw new AgentPersistenceError("not_found", `agent "${slug}" not found`);
  const row = existing.data as { id: string; tenant_id: string | null; is_oasis_managed: unknown; is_public: unknown };
  if (dbBool(row.is_oasis_managed)) {
    throw new AgentPersistenceError("forbidden", "platform-managed agents cannot be deleted");
  }
  if (row.tenant_id !== tenantId) {
    throw new AgentPersistenceError("forbidden", "this agent belongs to a different tenant");
  }
  // Deleting a published agent takes it out of every workspace's library.
  if (dbBool(row.is_public) && !writer.mayPublish) {
    throw new AgentPersistenceError("forbidden", PUBLISHED_CHANGE_REFUSED);
  }
  const deleted = await db.from("agents").delete().eq("id", row.id);
  if (deleted.error) throw new AgentPersistenceError("db", deleted.error.message);
}
