import Link from "next/link";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";

type Props = {
  stages: StageMeta[];
  activeKey: string | null;
  basePath: string;
  counts?: Record<string, number>;
  paramName?: string;
};

export function StageVerticalRail({
  stages,
  activeKey,
  basePath,
  counts,
  paramName = "stage",
}: Props) {
  return (
    <nav aria-label="Pipeline stages" className="w-full">
      <ul className="flex flex-col gap-1.5">
        <li>
          <Link
            href={basePath}
            aria-current={activeKey === null ? "page" : undefined}
            className={`flex items-center justify-between w-full px-3 h-9 rounded-md border text-[12px] font-semibold uppercase tracking-wider ${
              activeKey === null
                ? "bg-bg-elev text-fg border-bg-border"
                : "bg-bg-deep/40 text-fg-muted border-bg-border hover:text-fg"
            }`}
          >
            <span>All</span>
          </Link>
        </li>
        {stages.map((stage) => {
          const isActive = stage.key === activeKey;
          const count = counts?.[stage.key];
          return (
            <li key={stage.key}>
              <Link
                href={`${basePath}?${paramName}=${encodeURIComponent(stage.key)}`}
                aria-current={isActive ? "page" : undefined}
                className="flex items-center justify-between w-full px-3 h-9 rounded-md text-[12.5px] font-semibold whitespace-nowrap transition-transform hover:translate-x-[1px]"
                style={{
                  background: stage.bg,
                  color: stage.fg,
                  opacity: activeKey === null || isActive ? 1 : 0.78,
                }}
              >
                <span className={isActive ? "underline underline-offset-4 decoration-2" : ""}>
                  {stage.label}
                </span>
                {typeof count === "number" && (
                  <span
                    className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
                    style={{ background: "rgba(0,0,0,0.32)", color: stage.fg }}
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
