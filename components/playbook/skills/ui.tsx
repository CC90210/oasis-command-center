"use client";
/** Small shared pieces of the Skills tab (JARVIS plan 3). Tokens only, 44px targets, visible focus. */
import type { ButtonHTMLAttributes } from "react";
import {
  BarChart3, BookOpen, Calculator, Download, FileText, Film, GitBranch, Handshake, Layers, Lightbulb, Monitor, Puzzle,
  Rocket, ScanSearch, Search, Server, Wrench, type LucideIcon,
} from "lucide-react";
import { squares, testLine, type Rank } from "@/lib/skills/view";
import type { TestRecord } from "@/lib/skills/contract";

export const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const VARIANTS = {
  // `text-white` here is not a token: it is documented at app/globals.css's --c-accent-muted
  // definition ("filled buttons: white text clears AA"), so this is the one surface it is safe on.
  primary: "bg-accent-muted text-white hover:bg-accent",
  secondary: "border border-hairline bg-bg-raised text-fg hover:bg-bg-elev",
  ghost: "text-fg-muted hover:bg-bg-hover hover:text-fg",
  danger: "border border-status-hot/40 text-status-hot hover:bg-status-hot/10",
} as const;

export function Btn({ variant = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${focusRing} ${className}`}
    />
  );
}

export function RankTag({ rank }: { rank: Rank }) {
  return rank === "use-first" ? (
    <span className="rounded-md border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">Use first</span>
  ) : (
    <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[11px] text-fg-muted">Also helps</span>
  );
}

/** One square per test prompt; "not tested" draws none and is said in warning colour, never green. */
export function Squares({ tests }: { tests: TestRecord | null }) {
  const line = testLine(tests);
  const sq = squares(tests);
  return (
    <div>
      {sq.length > 0 && (
        <div className="flex flex-wrap gap-1" role="img" aria-label={line.text}>
          {sq.map((s, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-[3px] ${s === "ok" ? "bg-status-engaged" : "bg-status-hot/70"}`} />
          ))}
        </div>
      )}
      <p className={`mt-2 text-xs tabular-nums ${line.tested ? "text-fg-muted" : "text-status-warm"}`}>{line.text}</p>
    </div>
  );
}

export function Meter({ score }: { score: TestRecord | null }) {
  if (!score || score.n === 0) return <span className="block h-1.5 w-full rounded-full bg-bg-deep" aria-hidden="true" />;
  const pct = Math.round((score.ok / score.n) * 100);
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-bg-deep" role="img" aria-label={`${score.ok} of ${score.n} test prompts routed right`}>
      <span className={`block h-full rounded-full ${pct < 60 ? "bg-status-warm" : "bg-status-engaged"}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

const ICONS: Record<string, LucideIcon> = {
  "ui-build": Monitor, "data-viz": BarChart3, "backend-api": Server, "data-scrape": Download, research: Search,
  "analysis-stats": Calculator, "docs-report-deck": FileText, "video-media": Film, "sales-offer": Handshake,
  "deploy-infra": Rocket, debug: Wrench, "new-feature-plan": Lightbulb, "feature-teardown": ScanSearch,
  "repo-ingest": GitBranch, "skill-agent-authoring": Puzzle, "knowledge-recall": BookOpen,
};

export function KindIcon({ id }: { id: string }) {
  const Icon = ICONS[id] ?? Layers;
  return <Icon className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden="true" />;
}
