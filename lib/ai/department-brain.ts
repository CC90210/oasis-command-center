/**
 * lib/ai/department-brain.ts - what powers this workspace's departments, as
 * one fact every screen shows the same way.
 *
 * ONE SOURCE (CC, 2026-10-09: "We should be able to switch the model and what
 * it's actually connected to via the settings in the AI brain section"). The
 * department brain is the workspace's AI account (lib/ai/workspace-account.ts
 * readWorkspaceAiAccount): its provider and its model, sent as
 * lib/ai/model-registry.ts resolveModelForCall sends it (a model the registry
 * knows is gone goes out as its replacement). Settings > AI brain shows and
 * switches it (components/settings/ProviderAccountsCard.tsx), and every
 * department channel header names it (components/os/department/channel.ts):
 * both through departmentBrain, so they cannot disagree with each other or
 * with the request lib/os/department-agent.ts builds.
 *
 * Nothing else chooses it: not a per-agent override row, not a manifest
 * model_override, and not the Local AI CLIs card, which picks the CLI for the
 * operator's own coding chat on a paired computer (components/settings/
 * LocalCliProvidersCard.tsx).
 *
 * PURE apart from the registry and provider tables, which are client-safe.
 */
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
import { modelInfo, resolveModelForCall } from "@/lib/ai/model-registry";

export type DepartmentBrain = {
  provider: Provider;
  /** The provider as Settings names it ("Google Gemini"). */
  providerLabel: string;
  /** The model id the requests send (the saved one, or its replacement). */
  model: string;
  /** The model's name ("Gemini 3.8 Flash"), or its id when the registry does not know it. */
  modelLabel: string;
  /** The saved model, when the registry sends a replacement for it; else null. */
  savedModel: string | null;
};

/** The brain an account powers the departments with, or null when no account answers. */
export function departmentBrain(account: { provider: string; model: string } | null | undefined): DepartmentBrain | null {
  if (!account || !account.provider || !account.model) return null;
  const provider = account.provider as Provider;
  const providerLabel = PROVIDER_LABEL[provider];
  if (!providerLabel) return null;
  const sent = resolveModelForCall(provider, account.model);
  return {
    provider,
    providerLabel,
    model: sent.model,
    modelLabel: modelInfo(provider, sent.model)?.label ?? sent.model,
    savedModel: sent.swap ? account.model : null,
  };
}

/** "Google Gemini, Gemini 3.8 Flash": the words every screen uses for it. */
export function brainLine(brain: DepartmentBrain): string {
  return `${brain.providerLabel}, ${brain.modelLabel}`;
}
