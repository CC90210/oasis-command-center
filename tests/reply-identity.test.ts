/**
 * tests/reply-identity.test.ts
 *
 * WHO a client's automated replies come from is a decision with a blast radius,
 * and these pin the ways that decision quietly stops being made: a mode that
 * defaults instead of failing, an address filed under a mode it does not belong
 * to, and a client domain switched live before its DNS says OASIS may send as
 * it. The last one is the expensive failure — unauthenticated mail claiming to
 * be the client gets the CLIENT's domain blacklisted, not OASIS's, and no amount
 * of fixing it afterwards un-sends the mail.
 *
 * The vocabulary is asserted against migration 149 in both dialects, because a
 * mode this file accepts and the database rejects is an insert that dies in
 * production with a constraint name for a message.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OASIS_SENDING_DOMAIN,
  REPLY_IDENTITY_MODES,
  REPLY_IDENTITY_MODE_IDS,
  REPLY_IDENTITY_MODES_REQUIRING_DNS,
  isReplyIdentityMode,
  resolveReplyIdentity,
  canActivateProfile,
} from "../lib/reply-identity";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

assert.deepEqual(
  REPLY_IDENTITY_MODE_IDS,
  ["shared_oasis", "per_client_subaddress", "per_client_domain"],
  "three modes, cheapest first",
);
for (const id of REPLY_IDENTITY_MODE_IDS) {
  const spec = REPLY_IDENTITY_MODES[id];
  assert.equal(spec.id, id, "the record key and the id are one value");
  assert.ok(spec.label.length > 0, `${id} has an operator-facing label`);
  // The tradeoff line is the whole reason this is a record and not a union: an
  // operator picking a mode with no idea what it costs is the state this
  // replaces.
  assert.ok(spec.tradeoff.length > 40, `${id} states its deliverability tradeoff`);
}
// Only the client's own domain isolates reputation, and only it needs DNS. If
// these ever diverge, the activation gate is guarding the wrong mode.
assert.equal(REPLY_IDENTITY_MODES.shared_oasis.requiresClientDns, false);
assert.equal(REPLY_IDENTITY_MODES.shared_oasis.isolatesReputation, false);
assert.equal(REPLY_IDENTITY_MODES.per_client_subaddress.requiresClientDns, false);
assert.equal(
  REPLY_IDENTITY_MODES.per_client_subaddress.isolatesReputation,
  false,
  "a subaddress still shares the domain's reputation — claiming otherwise is the whole trap",
);
assert.equal(REPLY_IDENTITY_MODES.per_client_domain.requiresClientDns, true);
assert.equal(REPLY_IDENTITY_MODES.per_client_domain.isolatesReputation, true);

assert.ok(isReplyIdentityMode("shared_oasis"));
assert.ok(!isReplyIdentityMode("shared"));
assert.ok(!isReplyIdentityMode(""));
assert.ok(!isReplyIdentityMode(undefined));
assert.ok(!isReplyIdentityMode("toString"), "prototype keys are not modes");

// The TS vocabulary and the shipped CHECK constraints must be the same list. A
// mode accepted here and rejected by the column is an insert that dies in
// production naming a constraint instead of the problem.
const repoRoot = path.resolve(__dirname, "..");
for (const rel of [
  "database/149_reply_identity_mode.sql",
  "database/turso/149_reply_identity_mode.turso.sql",
]) {
  const sql = readFileSync(path.join(repoRoot, rel), "utf8");
  // Parse the enum out of the CHECK rather than searching the whole file. Every
  // id also appears in the DNS guard and in the header prose, so a substring
  // search reports full coverage even after an id is dropped from the
  // constraint — a hole this assertion had until a mutation run found it.
  const enumClause = /reply_identity_mode"?\s+in\s*\(([^)]*)\)/i.exec(sql);
  assert.ok(enumClause, `${rel} constrains reply_identity_mode to a list`);
  const constrained = enumClause![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
  assert.deepEqual(
    constrained,
    REPLY_IDENTITY_MODE_IDS,
    `${rel} constrains exactly the modes this module defines — no more, no fewer`,
  );
  assert.ok(sql.includes("dns_verified_at"), `${rel} adds dns_verified_at`);
  // The guard that keeps an unverified client domain off the wire.
  assert.ok(
    /status.{0,4}<>.{0,4}'active'/s.test(sql),
    `${rel} guards activation rather than merely recording the mode`,
  );
  // No DEFAULT on the mode column: a default IS the silent decision.
  assert.ok(
    !/reply_identity_mode["\s]*(TEXT|text)\s+[^;]*\bdefault\b/i.test(sql),
    `${rel} must not default reply_identity_mode`,
  );
}

// ---------------------------------------------------------------------------
// A missing or unknown mode is REJECTED, never defaulted
// ---------------------------------------------------------------------------

for (const missing of [undefined, null, "", "   ", 0, {}]) {
  const r = resolveReplyIdentity({ mode: missing, address: `support@${OASIS_SENDING_DOMAIN}` });
  assert.equal(r.ok, false, `mode ${JSON.stringify(missing)} is refused, not defaulted`);
  assert.ok(!r.ok && /required/.test(r.error), "the error says it is required");
  // The failure mode this whole change exists to prevent: silently picking one.
  assert.ok(!r.ok && !/^shared_oasis/.test(r.error), "no mode is assumed");
}

const unknown = resolveReplyIdentity({
  mode: "per_client_ip",
  address: `support@${OASIS_SENDING_DOMAIN}`,
});
assert.equal(unknown.ok, false);
assert.ok(!unknown.ok && unknown.error.includes("per_client_ip"), "names the bad value");
assert.ok(!unknown.ok && unknown.error.includes("shared_oasis"), "names the legal ones");

// ---------------------------------------------------------------------------
// All three modes resolve when the address matches
// ---------------------------------------------------------------------------

const shared = resolveReplyIdentity({
  mode: "shared_oasis",
  address: `  Support@${OASIS_SENDING_DOMAIN.toUpperCase()}  `,
});
assert.ok(shared.ok, "shared address on the OASIS domain resolves");
assert.equal(shared.ok && shared.address, `support@${OASIS_SENDING_DOMAIN}`, "normalized + lowercased");
assert.equal(shared.ok && shared.mode, "shared_oasis");
assert.equal(shared.ok && shared.requiresDns, false, "no client DNS for a shared OASIS address");

const sub = resolveReplyIdentity({
  mode: "per_client_subaddress",
  address: `support+acmehvac@${OASIS_SENDING_DOMAIN}`,
});
assert.ok(sub.ok, "subaddress on the OASIS domain resolves");
assert.equal(sub.ok && sub.requiresDns, false, "subaddressing needs no client DNS");

const own = resolveReplyIdentity({
  mode: "per_client_domain",
  address: "hello@acmehvac.com",
  websiteDomain: "acmehvac.com",
});
assert.ok(own.ok, "the client's own domain resolves");
assert.equal(own.ok && own.address, "hello@acmehvac.com");
assert.equal(own.ok && own.requiresDns, true, "per_client_domain reports that DNS is owed");

// A sending subdomain of the client's own domain is still the client's domain.
assert.ok(
  resolveReplyIdentity({
    mode: "per_client_domain",
    address: "hello@mail.acmehvac.com",
    websiteDomain: "acmehvac.com",
  }).ok,
  "mail.acmehvac.com belongs to acmehvac.com",
);
// The stored website_domain is bare, but an operator may hand-type the www form.
assert.ok(
  resolveReplyIdentity({
    mode: "per_client_domain",
    address: "hello@acmehvac.com",
    websiteDomain: "WWW.AcmeHVAC.com",
  }).ok,
  "the client's domain is compared bare and lowercased",
);

// ---------------------------------------------------------------------------
// Address must match the mode — the mismatch is specific, not generic
// ---------------------------------------------------------------------------

// Shared/subaddress on somebody else's domain: OASIS cannot send as a domain it
// does not control, and this is the exact typo that would try.
for (const mode of ["shared_oasis", "per_client_subaddress"]) {
  const r = resolveReplyIdentity({ mode, address: "support@acmehvac.com" });
  assert.equal(r.ok, false, `${mode} refuses a non-OASIS domain`);
  assert.ok(!r.ok && r.error.includes(OASIS_SENDING_DOMAIN), "names the domain it needed");
  assert.ok(!r.ok && r.error.includes("per_client_domain"), "names the mode that WOULD accept it");
}
// A lookalike domain must not pass as OASIS-owned.
assert.equal(
  resolveReplyIdentity({ mode: "shared_oasis", address: `support@evil-${OASIS_SENDING_DOMAIN}` }).ok,
  false,
  "a suffix match is not ownership",
);
// A subdomain of the OASIS domain is OASIS-owned.
assert.ok(
  resolveReplyIdentity({ mode: "shared_oasis", address: `support@mail.${OASIS_SENDING_DOMAIN}` }).ok,
);

// per_client_domain pointed back at oasisai.work gets none of the isolation the
// mode was chosen for, so it is a mis-filing, not a working alternative.
const backwards = resolveReplyIdentity({
  mode: "per_client_domain",
  address: `support@${OASIS_SENDING_DOMAIN}`,
  websiteDomain: "acmehvac.com",
});
assert.equal(backwards.ok, false, "per_client_domain refuses an oasisai.work address");
assert.ok(!backwards.ok && backwards.error.includes(OASIS_SENDING_DOMAIN));
assert.ok(
  !backwards.ok && backwards.error.includes("shared_oasis"),
  "points at the modes that do own that domain",
);

// The two OASIS modes are distinguished by the +tag, and neither may impersonate
// the other: one would over-report isolation, the other would lose the analytics
// lane the client is on.
const taggedAsShared = resolveReplyIdentity({
  mode: "shared_oasis",
  address: `support+acmehvac@${OASIS_SENDING_DOMAIN}`,
});
assert.equal(taggedAsShared.ok, false);
assert.ok(!taggedAsShared.ok && taggedAsShared.error.includes("per_client_subaddress"));

const untaggedAsSub = resolveReplyIdentity({
  mode: "per_client_subaddress",
  address: `support@${OASIS_SENDING_DOMAIN}`,
});
assert.equal(untaggedAsSub.ok, false);
assert.ok(!untaggedAsSub.ok && untaggedAsSub.error.includes("+"), "shows the shape it wanted");

// A third party's domain is neither OASIS's nor the client's. This is the one
// that borrows a reputation nobody granted.
const thirdParty = resolveReplyIdentity({
  mode: "per_client_domain",
  address: "hello@some-other-shop.com",
  websiteDomain: "acmehvac.com",
});
assert.equal(thirdParty.ok, false);
assert.ok(!thirdParty.ok && thirdParty.error.includes("acmehvac.com"), "names the client's domain");

// per_client_domain with nothing to check against must not fall through to "ok".
assert.equal(
  resolveReplyIdentity({ mode: "per_client_domain", address: "hello@acmehvac.com" }).ok,
  false,
  "no website_domain means nothing proves OASIS may send as that domain",
);

// Address shapes that are not addresses.
for (const bad of ["", "   ", "support", `support@`, `@${OASIS_SENDING_DOMAIN}`, "support@oasisai", null]) {
  assert.equal(
    resolveReplyIdentity({ mode: "shared_oasis", address: bad }).ok,
    false,
    `address ${JSON.stringify(bad)} is refused`,
  );
}
// The display-name form corrupted a Message-Id on every send once already.
const display = resolveReplyIdentity({
  mode: "shared_oasis",
  address: `OASIS Support <support@${OASIS_SENDING_DOMAIN}>`,
});
assert.equal(display.ok, false, "a display name is not stored in this column");
assert.ok(!display.ok && /display name/.test(display.error), "says what to store instead");

// ---------------------------------------------------------------------------
// Activation: per_client_domain waits for DNS, the other two do not
// ---------------------------------------------------------------------------

const blocked = canActivateProfile({ mode: "per_client_domain", dnsVerifiedAt: null });
assert.equal(blocked.ok, false, "no going live from an unverified client domain");
assert.ok(!blocked.ok && /SPF/.test(blocked.error), "names the records that are missing");
assert.ok(!blocked.ok && /DKIM/.test(blocked.error));
assert.ok(!blocked.ok && /DMARC/.test(blocked.error));
// Blank and whitespace are the same "never verified" as null — a truthy check
// alone would let an empty string through as proof.
for (const empty of [undefined, "", "   "]) {
  assert.equal(
    canActivateProfile({ mode: "per_client_domain", dnsVerifiedAt: empty }).ok,
    false,
    `dns_verified_at ${JSON.stringify(empty)} is not verification`,
  );
}
assert.equal(
  canActivateProfile({
    mode: "per_client_domain",
    dnsVerifiedAt: "2026-08-20T12:00:00.000Z",
  }).ok,
  true,
  "verified DNS unblocks the client's own domain",
);

// The OASIS-owned modes send from a domain OASIS already authenticates, so
// there is nothing for the client to publish and nothing to wait for.
for (const mode of ["shared_oasis", "per_client_subaddress"]) {
  assert.equal(
    canActivateProfile({ mode, dnsVerifiedAt: null }).ok,
    true,
    `${mode} activates without client DNS`,
  );
}

// A profile that predates the mode column cannot be activated on a guess.
for (const mode of [null, undefined, "", "per_client_ip"]) {
  const r = canActivateProfile({ mode, dnsVerifiedAt: "2026-08-20T12:00:00.000Z" });
  assert.equal(r.ok, false, `mode ${JSON.stringify(mode)} cannot activate`);
  assert.ok(!r.ok && /reply identity mode/.test(r.error));
}

// The DNS-requiring set is DERIVED, so a mode added to the vocabulary cannot be
// missed by the gate. Pinned against requiresClientDns rather than hardcoded, or
// the derivation could rot into a second hand-maintained list.
assert.deepEqual(
  [...REPLY_IDENTITY_MODES_REQUIRING_DNS],
  REPLY_IDENTITY_MODE_IDS.filter((id) => REPLY_IDENTITY_MODES[id].requiresClientDns),
  "the DNS set is derived from the specs, not maintained beside them",
);
assert.ok(REPLY_IDENTITY_MODES_REQUIRING_DNS.has("per_client_domain"));
assert.ok(!REPLY_IDENTITY_MODES_REQUIRING_DNS.has("shared_oasis"));
// Anything the gate blocks must be something the set knows about, or a profile
// is blocked by a rule nothing can ever satisfy.
for (const id of REPLY_IDENTITY_MODE_IDS) {
  assert.equal(
    canActivateProfile({ mode: id, dnsVerifiedAt: null }).ok,
    !REPLY_IDENTITY_MODES_REQUIRING_DNS.has(id),
    `${id} blocks on DNS exactly when it requires it`,
  );
}

console.log(`reply-identity ok (${REPLY_IDENTITY_MODE_IDS.length} modes)`);
