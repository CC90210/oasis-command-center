/**
 * LocalModelsCard - Settings > AI brain's "Local models" category (AI1).
 *
 * HONEST BY DESIGN. The paired-computer inventory (lib/bridge-cli-status.ts,
 * from app/api/bridge/cli-status) reports only the three CLIs (Claude Code,
 * Codex, Gemini CLI) today -- no bridge build yet reports an Ollama or LM
 * Studio model list. This card says exactly that, with how to connect one,
 * instead of inventing a model list or a picker that would do nothing: the
 * engine choice already supports `{ kind: "local", model }` end to end
 * (lib/ai/agent-engine.ts, lib/ai/bridge-turn.ts), it is just never offered
 * here until a device actually reports a model.
 */
import { HardDrive } from "lucide-react";
import { Card } from "@/components/Card";

export function LocalModelsCard() {
  return (
    <Card title="Local models" subtitle="A model served on one of your paired computers, through the same bridge your other apps use.">
      <div className="flex items-start gap-3 rounded-lg border border-hairline bg-bg-elev/40 p-3">
        <HardDrive className="h-4 w-4 shrink-0 text-fg-dim mt-0.5" aria-hidden />
        <div className="text-sm text-fg-muted leading-relaxed">
          <p className="font-semibold text-fg">No local model reported by your devices yet.</p>
          <p className="mt-1">
            Run Ollama or LM Studio on a paired computer and keep it running; the bridge there will report its models the
            next time it checks in, and this card will list them with a choice to use one for your departments.
          </p>
        </div>
      </div>
    </Card>
  );
}
