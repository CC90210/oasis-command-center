/**
 * Parse the operator's provisioning choices from an untrusted request body.
 * Unknown departments, modules and chat apps are dropped (and Chief of Staff is
 * always included); Jev is "shadow" only when asked for by that exact word.
 */

import { MANIFEST_CHAT_APPS, type ManifestChatApp, type ManifestJevMode } from "@/lib/manifest/schema";
import type { DepartmentKey, ModuleKey } from "@/lib/os/types";
import { normalizeDepartments, normalizeModules } from "@/lib/provisioning/team";

const CHAT_APPS: ReadonlySet<string> = new Set(MANIFEST_CHAT_APPS);

export function normalizeChatApps(input: unknown): ManifestChatApp[] {
  if (!Array.isArray(input)) return [];
  const picked = input.filter((v): v is ManifestChatApp => typeof v === "string" && CHAT_APPS.has(v));
  // "Email only" means exactly that: it cannot sit beside a chat app.
  if (picked.includes("email")) return ["email"];
  return MANIFEST_CHAT_APPS.filter((a) => picked.includes(a));
}

export function parseProvisionBody(body: Record<string, unknown>): {
  departments: DepartmentKey[];
  modules: ModuleKey[];
  chatApps: ManifestChatApp[];
  jev: ManifestJevMode;
} {
  return {
    departments: normalizeDepartments(body.departments),
    modules: normalizeModules(body.modules),
    chatApps: normalizeChatApps(body.chat_apps),
    jev: body.jev === "shadow" ? "shadow" : "off",
  };
}
