"use client";

/**
 * ImportClient — tabbed wrapper for the SunBiz import page.
 *
 * Provides two modes:
 *   Warm pipeline  — wraps LeadsImportClient (existing behavior, unchanged)
 *   Cold list      — wraps ColdListImportClient (new; stores in cold_lead_lists)
 *
 * Tab choice persists in the ?mode=warm|cold URL param so operators can
 * bookmark the cold-list tab directly and the back button works naturally.
 *
 * Only one client mounts at a time — the inactive tab is not rendered so
 * there are no background fetches from the non-active path.
 */

import { useCallback } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Users, Megaphone } from "lucide-react";
import { LeadsImportClient } from "@/components/leads/LeadsImportClient";
import { ColdListImportClient } from "@/components/import/ColdListImportClient";

type Tab = "warm" | "cold";

const TABS: { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: "warm", label: "Warm pipeline", Icon: Users },
  { id: "cold", label: "Cold list",     Icon: Megaphone },
];

export function ImportClient({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get("mode");
  const activeTab: Tab = raw === "cold" ? "cold" : "warm";

  const switchTab = useCallback(
    (tab: Tab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("mode", tab);
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-bg-border pb-0 -mb-2">
        {TABS.map(({ id, label, Icon }) => {
          const active = id === activeTab;
          return (
            <button
              key={id}
              type="button"
              onClick={() => switchTab(id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                active
                  ? "border-accent text-accent"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              <Icon className={`w-4 h-4 ${active ? "text-accent" : "text-fg-dim"}`} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Active panel — only one mounts at a time */}
      {activeTab === "warm" && <LeadsImportClient />}
      {activeTab === "cold" && <ColdListImportClient tenantSlug={tenantSlug} />}
    </div>
  );
}
