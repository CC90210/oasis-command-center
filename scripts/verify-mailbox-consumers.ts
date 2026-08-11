/**
 * scripts/verify-mailbox-consumers.ts
 *
 * Prove the submissions@ mailbox works through the REAL application resolver,
 * the chain every consumer shares:
 *
 *   getSubmissionsCreds(tenant, brand)
 *     -> brands.ts credentialService ('gws' | 'gws_bluerise')
 *     -> tenant_integration_credentials row
 *     -> AES-256-GCM decrypt
 *     -> whitespace normalisation
 *     -> SMTP AUTH on 587 STARTTLS
 *
 * The reconnect script proved the password. This proves the PATH — that what
 * shop-out, drips, e-sign, renewals, form-completion and the IMAP crons will
 * each resolve is the working credential. Those are different claims, and a
 * 2026-08-06 outage that lasted days came from proving only the first.
 *
 * Authenticates only. Sends nothing to anyone.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-mailbox-consumers.ts
 */

import { readFileSync } from "node:fs";

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvFile("C:/Users/echel/JARVIS/.env.agents");

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

/**
 * The field-encryption key lives only on Vercel. Without it the credential store
 * logs a decrypt failure and FALLS THROUGH to env fallbacks rather than raising
 * — so running this locally without it would report "missing_creds" and look
 * like a broken rewire when it is only a missing local key.
 */
async function loadFieldKeyFromVercel(): Promise<void> {
  if (process.env.BRAVO_FIELD_ENCRYPTION_KEY) return;
  const token = process.env.CC_VERCEL_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) throw new Error("no Vercel token available to fetch BRAVO_FIELD_ENCRYPTION_KEY");
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch("https://api.vercel.com/v9/projects?limit=100", { headers: H })).json();
  const proj = (projects.projects || []).find((p: { name: string }) => p.name === "agent-dashboard");
  const envs = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env?limit=500`, { headers: H })).json();
  const row = (envs.envs || []).find(
    (e: { key: string; target?: string[] }) =>
      e.key === "BRAVO_FIELD_ENCRYPTION_KEY" && (e.target || []).includes("production"),
  );
  if (!row) throw new Error("BRAVO_FIELD_ENCRYPTION_KEY not found on the production target");
  const j = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${row.id}`, { headers: H })).json();
  if (typeof j?.value !== "string") throw new Error("could not read BRAVO_FIELD_ENCRYPTION_KEY");
  process.env.BRAVO_FIELD_ENCRYPTION_KEY = j.value;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  await loadFieldKeyFromVercel();
  const { getSubmissionsCreds, testConnection, invalidateSubmissionsCreds } = await import(
    "@/lib/integrations/submissions-gmail"
  );

  // The resolver caches for 5 minutes per warm instance. Clear it first or this
  // could pass on a value read before the rewire.
  try {
    (invalidateSubmissionsCreds as ((t?: string) => void) | undefined)?.(TENANT);
    console.log("cleared the credential cache\n");
  } catch {
    console.log("(no cache invalidator available; results may be up to 5 min stale)\n");
  }

  // ── SunBiz: the identity behind shop-out, lender replies, drips, e-sign,
  //    renewals, form-completion, and both IMAP crons.
  console.log("SunBiz ('gws') — shop-out, lender replies, drips, e-sign, renewals, alerts, IMAP crons");
  const sun = await getSubmissionsCreds(TENANT);
  check("resolver returned a from address", Boolean(sun.fromAddress), sun.fromAddress);
  check("from address is submissions@sunbizfunding.com", sun.fromAddress === "submissions@sunbizfunding.com");
  check("password carries no interior whitespace", !/\s/.test(sun.appPassword), `${sun.appPassword.length} chars`);
  check("password is 16 characters", sun.appPassword.length === 16);

  const sunConn = await testConnection(TENANT);
  check("testConnection() authenticates", sunConn.ok === true, sunConn.ok ? sunConn.email : JSON.stringify(sunConn).slice(0, 160));

  // ── Bluerise: the second brand must resolve to its OWN mailbox. If the cache
  //    key or the brand map were wrong, this would come back as SunBiz and the
  //    two brands would silently share an identity.
  console.log("\nBluerise ('gws_bluerise') — must resolve to a DIFFERENT mailbox");
  try {
    const blue = await getSubmissionsCreds(TENANT, "bluerise");
    check("resolved a Bluerise from address", Boolean(blue.fromAddress), blue.fromAddress);
    check("it is NOT the SunBiz mailbox", blue.fromAddress !== sun.fromAddress);
    const blueConn = await testConnection(TENANT, "bluerise");
    check("Bluerise authenticates", blueConn.ok === true, blueConn.ok ? blueConn.email : JSON.stringify(blueConn).slice(0, 160));
  } catch (err) {
    check("Bluerise resolved", false, err instanceof Error ? err.message : String(err));
  }

  // ── The brand separation the whole allocation rests on.
  console.log("\nseparation");
  const sun2 = await getSubmissionsCreds(TENANT);
  check("SunBiz still resolves to SunBiz after a Bluerise read", sun2.fromAddress === "submissions@sunbizfunding.com",
    "a shared cache key would have pinned one brand's mailbox onto the other");

  console.log(failures === 0 ? "\nALL CONSUMER PATHS VERIFIED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
