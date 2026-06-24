import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pipelineView = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
const inlineControl = readFileSync("components/manifest/InlineStageControl.tsx", "utf8");
const setStageRoute = readFileSync("app/api/leads/[id]/set-stage/route.ts", "utf8");

assert(
  pipelineView.includes('import { InlineStageControl } from "@/components/manifest/InlineStageControl";'),
  "LeadPipelineView imports the inline stage picker used on lender pipeline rows",
);
assert(
  pipelineView.includes("<InlineStageControl") &&
    pipelineView.includes("recordId={row.id}") &&
    pipelineView.includes("stage={stage.key}") &&
    pipelineView.includes("stageMap={stageMap}") &&
    pipelineView.includes("entity={entityName}"),
  "lead/application pipeline rows wire row id, current stage, stage map, and entity into InlineStageControl",
);
assert(
  pipelineView.includes('role="link"') &&
    pipelineView.includes("onClick={() => router.push(href)}") &&
    !pipelineView.includes("<Link\n      href={href}"),
  "SunBiz pipeline rows keep row navigation without nesting the stage button inside a Link",
);
assert(
  pipelineView.includes('className="overflow-visible rounded-lg border border-bg-border bg-bg-deep/30"'),
  "stage sections allow the inline stage dropdown to open without clipping",
);
assert(
  inlineControl.includes('menuAlign?: "left" | "right";') &&
    inlineControl.includes('menuAlign === "right" ? "right-0" : "left-0"'),
  "InlineStageControl supports right-aligned menus for mobile pipeline rows",
);
assert(
  setStageRoute.includes('const entity = body.entity === "application" ? "application" : "lead";') &&
    setStageRoute.includes('const field = entity === "application" ? "status" : "stage";'),
  "set-stage API updates application.status and lead.stage through the same endpoint",
);

console.log("pipeline-inline-stage ok");
