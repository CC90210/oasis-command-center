/**
 * gen_app_pdf_from_json.ts — generate a SunBiz application PDF from REAL merged
 * form data supplied as JSON. Pure (no DB/server-only) so it runs under tsx and
 * can be driven by a backfill orchestrator.
 *
 * Reuses the exact production primitives (mapApplicationFieldsFromSteps +
 * generateApplicationPdf) so the backfilled PDF is byte-for-byte what the live
 * maybeGenerateApplicationDocument path would have produced.
 *
 * Usage: npx tsx scripts/gen_app_pdf_from_json.ts <input.json> <output.pdf>
 * input.json = { steps: FormStep[], merged: Record<string,unknown>,
 *                lead: Record<string,unknown>, signatureDataUri?: string,
 *                signedAt?: string }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mapApplicationFieldsFromSteps, generateApplicationPdf } from "../lib/forms/application-pdf";
import type { FormStep } from "../lib/forms/types";

type Input = {
  steps: FormStep[];
  merged: Record<string, unknown>;
  lead: Record<string, unknown>;
  signatureDataUri?: string;
  signedAt?: string;
};

(async () => {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error("usage: tsx gen_app_pdf_from_json.ts <input.json> <output.pdf>");
    process.exit(2);
  }
  const input = JSON.parse(readFileSync(inPath, "utf8")) as Input;
  const signatureDataUri =
    typeof input.merged.applicant_signature === "string"
      ? (input.merged.applicant_signature as string)
      : input.signatureDataUri || "";
  const { sections, signatureName } = mapApplicationFieldsFromSteps(
    input.steps,
    input.merged,
    input.lead,
  );
  const bytes = await generateApplicationPdf({
    sections,
    signatureName,
    signatureDataUri,
    signedAt: input.signedAt || new Date().toISOString(),
  });
  writeFileSync(outPath, Buffer.from(bytes));
  console.log(
    JSON.stringify({
      ok: true,
      out: outPath,
      bytes: bytes.length,
      signatureName,
      has_signature: !!(signatureDataUri && signatureDataUri.startsWith("data:image")),
      sections: sections.length,
    }),
  );
})();
