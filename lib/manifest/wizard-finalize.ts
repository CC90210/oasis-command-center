/**
 * Wizard finaliser — fold collected onboarding answers into a starter
 * template, producing a complete TenantManifest ready for persistence.
 *
 * Pure logic. The HTTP route handler calls this, validates the result via
 * parseManifest, then writes through saveManifest. Keeping the answer-→-
 * mutation mapping in one file makes it easy to add new wizard questions
 * (just extend WIZARD_QUESTIONS in templates.ts and add a case here).
 *
 * TEAM (2026-09-30). The team is built from the DEPARTMENTS the owner chose
 * (lib/provisioning/team.ts: neutral teammates named for their department),
 * never from a list of agent slugs. The old agent picker offered OASIS's own
 * house agents and SunBiz's, and a client workspace ended up with them.
 * The chat-app and fast-classifier answers are stored where the Slack/Jev
 * work reads them: manifest.integrations.chat_apps and .jev.
 */

import type { TenantManifest } from "./schema";
import { TEMPLATES, type TemplateKey } from "./templates";
import { addFieldToEntity, updateBrand } from "./mutators";
import {
  DEFAULT_DEPARTMENTS,
  modulesForSetup,
  neutralTeamFor,
  normalizeDepartments,
  normalizeModules,
} from "@/lib/provisioning/team";
import { normalizeChatApps } from "@/lib/provisioning/request";

export type WizardAnswers = Record<string, string | string[] | number | undefined>;

export type FinalizeInput = {
  template: TemplateKey;
  slug: string;
  answers: WizardAnswers;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/** Slugify a brand name into a URL-safe tenant slug. */
export function slugifyBrand(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62) || "tenant";
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function parseExtraFields(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, "_"))
    .filter((s) => /^[a-z][a-z0-9_]{0,62}$/.test(s));
}

/**
 * Apply answers to a template. The mapping is small and intentionally
 * declarative — each template owns which answer keys it consumes.
 */
export function finalizeManifestFromWizard(input: FinalizeInput): TenantManifest {
  const slug = input.slug.trim().toLowerCase();
  if (!isValidSlug(slug)) {
    throw new Error(`invalid_slug:${slug}`);
  }
  const base: TenantManifest = JSON.parse(JSON.stringify(TEMPLATES[input.template]));
  // Re-anchor the slug to the operator's chosen one.
  base.tenant_slug = slug;

  // Rewrite nav hrefs to point at /t/<slug>/<path>. Templates ship bare
  // paths ("/", "/leads", "/reasoning") which would otherwise route to
  // the OASIS legacy bare-path pages when a new tenant clicks around.
  // Maps:
  //   "/"                  → "/t/<slug>"
  //   "/leads"             → "/t/<slug>/leads"
  //   "/t/whatever/leads"  → "/t/<slug>/leads"  (re-prefixed)
  //   "https://..."        → left untouched (external link)
  base.nav = base.nav.map((n) => {
    if (/^[a-z]+:\/\//i.test(n.href)) return n;
    if (n.href === "/" || n.href === "") return { ...n, href: `/t/${slug}` };
    const tenantPrefixed = n.href.match(/^\/t\/[a-z0-9_-]+\/(.*)$/i);
    if (tenantPrefixed) return { ...n, href: `/t/${slug}/${tenantPrefixed[1]}` };
    if (n.href.startsWith("/")) return { ...n, href: `/t/${slug}${n.href}` };
    return { ...n, href: `/t/${slug}/${n.href}` };
  });

  const answers = input.answers;
  const brandName = typeof answers.brand_name === "string" ? answers.brand_name.trim() : "";
  const tagline = typeof answers.tagline === "string" ? answers.tagline.trim() : "";

  let manifest: TenantManifest = base;
  if (brandName) {
    manifest = updateBrand(manifest, {
      name: brandName,
      footer_label: `${brandName} · powered by OASIS AI`,
    });
  }
  if (tagline) {
    manifest = updateBrand(manifest, { footer_tagline: tagline });
  }

  if (input.template === "real_estate") {
    const extras = parseExtraFields(answers.extra_fields as string | undefined);
    for (const fieldName of extras) {
      // Skip names that already exist on the lead entity (mutator would throw).
      const lead = manifest.data_model?.find((e) => e.name === "lead");
      if (!lead || lead.fields.some((f) => f.name === fieldName)) continue;
      manifest = addFieldToEntity(manifest, {
        entity: "lead",
        field: { name: fieldName, type: "string" },
      });
    }
  }

  // The departments the owner chose (Chief of Staff always included), and the
  // neutral teammates they bring. No answer means the default set.
  const departments =
    answers.departments === undefined ? [...DEFAULT_DEPARTMENTS] : normalizeDepartments(answers.departments);
  const modules = modulesForSetup(departments, normalizeModules(answers.modules));
  manifest = {
    ...manifest,
    agents: neutralTeamFor(departments),
    os: { departments, modules },
    integrations: {
      ...(manifest.integrations ?? {}),
      chat_apps: normalizeChatApps(answers.chat_apps),
      // Off unless the owner explicitly chose shadow mode.
      jev: answers.jev === "shadow" ? "shadow" : "off",
    },
  };

  return manifest;
}
