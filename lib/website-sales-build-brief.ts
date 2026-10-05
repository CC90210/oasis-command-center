export const BUILD_BRIEF_VERSION = 1;

export type WebsiteBuildBrief = {
  version: 1;
  status: "ready_for_pricing";
  businessGoal: string;
  targetAudience: string;
  mustHavePages: string;
  requiredFeatures: string;
  integrations: string;
  contentAndAssets: string;
  domainAndAccess: string;
  launchTiming: string;
  decisionProcess: string;
  transcriptNotes: string;
  capturedAt: string;
  capturedBy: string;
};

type BuildBriefResult =
  | { ok: true; brief: WebsiteBuildBrief }
  | { ok: false; error: string };

const REQUIRED_TEXT_FIELDS = [
  "businessGoal",
  "targetAudience",
  "mustHavePages",
  "requiredFeatures",
  "contentAndAssets",
  "domainAndAccess",
  "launchTiming",
  "decisionProcess",
] as const;

const FIELD_LIMITS: Record<(typeof REQUIRED_TEXT_FIELDS)[number] | "integrations" | "transcriptNotes", number> = {
  businessGoal: 2_000,
  targetAudience: 2_000,
  mustHavePages: 4_000,
  requiredFeatures: 6_000,
  integrations: 4_000,
  contentAndAssets: 4_000,
  domainAndAccess: 3_000,
  launchTiming: 2_000,
  decisionProcess: 3_000,
  transcriptNotes: 20_000,
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Turn the closer's call notes into the minimum builder-ready handoff. The
 * transcript is deliberately optional: the structured facts are the contract,
 * while a pasted transcript remains supporting context rather than a blocker.
 */
export function normalizeWebsiteBuildBrief(
  value: unknown,
  actorUserId: string,
  capturedAt = new Date().toISOString(),
): BuildBriefResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "build_brief_required" };
  }
  const source = value as Record<string, unknown>;
  for (const field of REQUIRED_TEXT_FIELDS) {
    const text = cleanText(source[field]);
    if (!text) return { ok: false, error: `build_brief_${field}_required` };
    if (text.length > FIELD_LIMITS[field]) {
      return { ok: false, error: `build_brief_${field}_too_long` };
    }
  }
  for (const field of ["integrations", "transcriptNotes"] as const) {
    if (cleanText(source[field]).length > FIELD_LIMITS[field]) {
      return { ok: false, error: `build_brief_${field}_too_long` };
    }
  }

  return {
    ok: true,
    brief: {
      version: BUILD_BRIEF_VERSION,
      status: "ready_for_pricing",
      businessGoal: cleanText(source.businessGoal),
      targetAudience: cleanText(source.targetAudience),
      mustHavePages: cleanText(source.mustHavePages),
      requiredFeatures: cleanText(source.requiredFeatures),
      integrations: cleanText(source.integrations),
      contentAndAssets: cleanText(source.contentAndAssets),
      domainAndAccess: cleanText(source.domainAndAccess),
      launchTiming: cleanText(source.launchTiming),
      decisionProcess: cleanText(source.decisionProcess),
      transcriptNotes: cleanText(source.transcriptNotes),
      capturedAt,
      capturedBy: actorUserId,
    },
  };
}

export function websiteBuildBriefIsReady(value: unknown): value is WebsiteBuildBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== BUILD_BRIEF_VERSION || row.status !== "ready_for_pricing") return false;
  return REQUIRED_TEXT_FIELDS.every((field) => cleanText(row[field]).length > 0);
}

export function buildBriefForOnboarding(value: unknown): Record<string, unknown> {
  if (!websiteBuildBriefIsReady(value)) {
    throw new Error("builder_handoff_not_ready");
  }
  return {
    version: BUILD_BRIEF_VERSION,
    source: "founder_closing_call",
    status: "ready_for_builder",
    build_brief: value,
  };
}
