"use client";

/**
 * One way for every Projects/Tickets control to call the API: JSON in, the
 * route's own sentence out on failure, and a server refresh on success so the
 * page re-reads through the scoped store instead of trusting local state.
 */
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

export type ActionResult = Record<string, unknown>;

export function useDeliveryAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (url: string, method: "POST" | "PATCH", body: unknown): Promise<ActionResult | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => null)) as ActionResult | null;
        if (!res.ok || !data || data.ok !== true) {
          setError(
            (data && typeof data.message === "string" && data.message) ||
              (data && typeof data.error === "string" && data.error) ||
              `The request failed (HTTP ${res.status}). Nothing was saved.`,
          );
          return null;
        }
        router.refresh();
        return data;
      } catch {
        setError("Network error. Nothing was saved.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return { run, busy, error, setError };
}

export type Option = { value: string; label: string };
