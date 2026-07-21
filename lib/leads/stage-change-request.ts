export type StageChangeRequest =
  | { endpoint: "decline"; body: Record<string, never> }
  | { endpoint: "set-stage"; body: { stage: string; entity: "lead" | "application" } };

export function stageChangeRequest(entity: "lead" | "application", stage: string): StageChangeRequest {
  if (entity === "lead" && stage === "declined") {
    return { endpoint: "decline", body: {} };
  }
  return { endpoint: "set-stage", body: { stage, entity } };
}
