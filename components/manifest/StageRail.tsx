import type { StageMeta } from "@/lib/sunbiz-stage-meta";
import { StagePipelineBar } from "./StagePipelineBar";
import { StageVerticalRail } from "./StageVerticalRail";

type Props = {
  tenantSlug: string;
  stages: StageMeta[];
  activeKey: string | null;
  basePath: string;
  counts?: Record<string, number>;
  paramName?: string;
};

export function StageRail({ tenantSlug, ...rest }: Props) {
  if (tenantSlug === "sun") {
    return <StageVerticalRail {...rest} />;
  }
  return <StagePipelineBar {...rest} />;
}
