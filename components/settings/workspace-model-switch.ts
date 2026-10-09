/**
 * Settings > AI brain's model switch, as the browser calls it: the model the
 * departments send, on the workspace AI account's own provider and saved key
 * (app/api/agent-config/workspace-model). The route tests the new model with a
 * short department answer before it switches; its plain sentence comes back on
 * any failure. No React, so a test drives it without a browser.
 */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const FALLBACK = "The model couldn't be switched just now. Nothing was changed. Try again in a moment.";

export async function switchWorkspaceModel(
  model: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<{ ok: true; label: string } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl("/api/agent-config/workspace-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; label?: string; message?: string };
    if (res.ok && body.ok === true) return { ok: true, label: typeof body.label === "string" ? body.label : model };
    return { ok: false, message: typeof body.message === "string" && body.message.trim() ? body.message : FALLBACK };
  } catch {
    return { ok: false, message: FALLBACK };
  }
}
