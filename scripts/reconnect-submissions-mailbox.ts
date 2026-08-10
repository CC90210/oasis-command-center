/**
 * scripts/reconnect-submissions-mailbox.ts
 *
 * Install a new Google app password for submissions@sunbizfunding.com and prove
 * it works.
 *
 * ORDER MATTERS: it authenticates against Gmail BEFORE writing anything. Storing
 * an unverified credential is how the mailbox sat dead from 2026-08-06 while
 * every drip email reported itself as sent — the system believed a password it
 * had never actually tried.
 *
 * The password is read from .env.agents (key GWS_APP_PASSWORD_NEW), never from
 * the command line, so it does not land in shell history or a process listing.
 * It is never printed.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/reconnect-submissions-mailbox.ts          # verify only
 *   node --conditions=react-server --import tsx scripts/reconnect-submissions-mailbox.ts --apply  # verify then store
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const require_ = createRequire("C:/Users/echel/oasis-drip-fix/package.json");
const nodemailer = require_("nodemailer");

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

const APPLY = process.argv.includes("--apply");
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const FROM = "submissions@sunbizfunding.com";

async function vercelValue(key: string): Promise<string | null> {
  const token = process.env.CC_VERCEL_TOKEN || process.env.VERCEL_TOKEN;
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch("https://api.vercel.com/v9/projects?limit=100", { headers: H })).json();
  const proj = (projects.projects || []).find((p: { name: string }) => p.name === "agent-dashboard");
  const envs = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env?limit=500`, { headers: H })).json();
  const row = (envs.envs || []).find(
    (e: { key: string; target?: string[] }) => e.key === key && (e.target || []).includes("production"),
  );
  if (!row) return null;
  const j = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${row.id}`, { headers: H })).json();
  return typeof j?.value === "string" && !/^eyJ2Ijoi/.test(j.value) ? j.value : null;
}

async function main(): Promise<void> {
  // Google displays app passwords in four spaced groups. The spaces are
  // presentation only; SMTP wants the bare 16 characters, and a pasted value
  // that keeps them is the most common reason a correct password "fails".
  const raw = process.env.GWS_APP_PASSWORD_NEW ?? "";
  const pass = raw.replace(/\s+/g, "");
  if (!pass) {
    console.log("No GWS_APP_PASSWORD_NEW found in .env.agents.");
    console.log("Add the line, save the file, then re-run. The value is never printed or logged.");
    process.exit(2);
  }
  if (pass.length !== 16) {
    console.log(`Password is ${pass.length} characters after removing spaces; a Google app password is 16.`);
    console.log("Check for a partial copy or a stray character.");
    process.exit(2);
  }
  console.log("read a 16-character app password from .env.agents");

  // 1) PROVE IT BEFORE STORING IT.
  console.log("\n1) authenticating against smtp.gmail.com …");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: FROM, pass },
  });
  try {
    await transport.verify();
    console.log("   SMTP AUTH: SUCCESS");
  } catch (err) {
    const msg = String((err as Error)?.message || err).split("\n")[0];
    console.log("   SMTP AUTH: FAILED —", msg.slice(0, 220));
    if (/535/.test(msg)) {
      console.log("   535 means Google rejected it. Usual causes, in order:");
      console.log("     - 2-Step Verification is not ON for submissions@ itself");
      console.log("     - the app password was generated on a DIFFERENT account");
      console.log("     - it was copied incompletely");
    }
    console.log("\nNothing was written. Fix and re-run.");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nVerified but NOT stored. Re-run with --apply to install it.");
    return;
  }

  // 2) Store it, encrypted with the same key the app decrypts with.
  console.log("\n2) storing the credential …");
  const passphrase = await vercelValue("BRAVO_FIELD_ENCRYPTION_KEY");
  if (!passphrase) throw new Error("could not read BRAVO_FIELD_ENCRYPTION_KEY from Vercel production");
  const key = scryptSync(passphrase, "oasis-bravo-v1", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(pass, "utf8"), cipher.final()]);
  const packed = `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;

  const { createClient } = require_("@supabase/supabase-js");
  const db = createClient(process.env.BRAVO_SUPABASE_URL, process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const upd = await db
    .from("tenant_integration_credentials")
    .update({ encrypted_value: packed, updated_at: new Date().toISOString() })
    .eq("tenant_id", TENANT)
    .eq("service", "gws")
    .eq("field_key", "app_password")
    .select("field_key");
  if (upd.error) throw new Error(`store failed: ${upd.error.message}`);
  if (!upd.data?.length) throw new Error("no gws/app_password row matched — nothing was updated");
  console.log("   stored and re-encrypted with the production key");

  // 3) Read it back the way the app does and authenticate again. Writing and
  //    assuming is the whole failure mode this script exists to avoid.
  console.log("\n3) reading back and re-authenticating …");
  const back = await db
    .from("tenant_integration_credentials")
    .select("encrypted_value")
    .eq("tenant_id", TENANT)
    .eq("service", "gws")
    .eq("field_key", "app_password")
    .maybeSingle();
  if (back.error || !back.data) throw new Error("read-back failed");
  const [bIv, bTag, bCt] = String(back.data.encrypted_value).split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(bIv, "base64"));
  d.setAuthTag(Buffer.from(bTag, "base64"));
  const roundTripped = Buffer.concat([d.update(Buffer.from(bCt, "base64")), d.final()]).toString("utf8");
  if (roundTripped !== pass) throw new Error("round-trip mismatch — stored value does not decrypt to what we verified");

  const t2 = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: FROM, pass: roundTripped },
  });
  await t2.verify();
  console.log("   SUCCESS — the value the app will read authenticates against Gmail");
  console.log("\nsubmissions@sunbizfunding.com is reconnected.");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
