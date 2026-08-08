/**
 * Do the invite call sites send what the Turso shim requires?
 *
 * redeem_tenant_invite's Postgres original read the redeemer's email from
 * auth.users inside a SECURITY DEFINER function. There is no auth.users under
 * Turso, so the port takes p_redeemer_email as an argument and fails closed
 * without it — returning "auth_user_not_found", which is the SAME string the
 * preceding user lookup returns on failure. That collision is why a broken
 * join looked like a missing user and went unnoticed.
 *
 * Reading the source is not enough: the argument object is built inline at each
 * call site, so this extracts the ACTUAL keys each one passes and asserts the
 * required ones are present.
 *
 *   node lib/__tests__/invite-redeem-args.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** Keys of the object literal passed to rpc("redeem_tenant_invite", {...}). */
function rpcArgKeys(src) {
  const i = src.indexOf('rpc("redeem_tenant_invite"');
  if (i < 0) return null;
  const open = src.indexOf("{", i);
  let depth = 0, end = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  return [...body.matchAll(/(?:^|\n)\s*(p_[a-z_]+)\s*:/g)].map((m) => m[1]);
}

const SITES = [
  { file: "lib/team.ts", required: ["p_token_hash", "p_redeemer_auth_id", "p_redeemer_email"] },
  { file: "lib/auth-routing.ts", required: ["p_token_hash", "p_redeemer_auth_id", "p_redeemer_email"] },
];

console.log("every redeem_tenant_invite call site supplies the required args");
for (const site of SITES) {
  const src = readFileSync(new URL(`../../${site.file}`, import.meta.url), "utf8");
  const keys = rpcArgKeys(src);
  check(`${site.file}: call site found`, keys !== null);
  if (!keys) continue;
  for (const req of site.required) {
    check(`${site.file}: passes ${req}`, keys.includes(req), `sends ${JSON.stringify(keys)}`);
  }
}

console.log("\nthe shim still fails closed when the email is absent");
{
  const shim = readFileSync(new URL("../turso-rpc-shim.ts", import.meta.url), "utf8");
  const i = shim.indexOf("redeem_tenant_invite");
  const window = shim.slice(i, i + 4000);
  check("shim rejects a missing redeemer email",
        /redeemerEmail\s*===?\s*null/.test(window) && /auth_user_not_found/.test(window),
        "the guard this test exists to satisfy is gone");
}

console.log("\nadminGetUser supplies a display name, so profiles are not named by email");
{
  const admin = readFileSync(new URL("../turso-auth-admin.ts", import.meta.url), "utf8");
  check("AuthUserRecord carries fullName", /fullName\s*:\s*string \| null/.test(admin));
  check("it reads raw_user_meta_data", /raw_user_meta_data/.test(admin));
  // Email signups store full_name; Google OAuth stores name. Checking one
  // silently loses half the users.
  check("it handles BOTH metadata shapes",
        /"full_name",\s*"name"/.test(admin) || /'full_name',\s*'name'/.test(admin));
  const team = readFileSync(new URL("../team.ts", import.meta.url), "utf8");
  check("team.ts forwards it as p_redeemer_full_name",
        /p_redeemer_full_name:\s*authUser\.value\.fullName/.test(team));
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
