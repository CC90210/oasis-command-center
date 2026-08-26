#!/usr/bin/env node
/**
 * scripts/dwd_check.mjs — prove domain-wide delegation actually works.
 *
 *   node scripts/dwd_check.mjs rep@yourdomain.com
 *
 * Mints a delegated token for that person, creates a throwaway event on THEIR
 * calendar, reads it back, deletes it, and reports each step. It cleans up
 * after itself even when a later step fails.
 *
 * WHY THIS EXISTS RATHER THAN "the variables are set, so it works". Three
 * environment variables being present proves nothing: the admin-console grant
 * can be missing, the scope can be wrong, the key can be for a deleted service
 * account, and every one of those looks identical from outside until a worker
 * hits it. This asks Google.
 *
 * Prints no secrets. The private key and the minted token never reach stdout.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const subject = (process.argv[2] || '').trim().toLowerCase();
if (!subject) {
  console.error('usage: node scripts/dwd_check.mjs <someone@yourdomain.com>');
  process.exit(2);
}

const clientEmail = (process.env.GOOGLE_DWD_CLIENT_EMAIL || '').trim();
const privateKey = (process.env.GOOGLE_DWD_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const domains = (process.env.GOOGLE_DWD_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function fail(step, detail) {
  console.error(`\n  FAILED at: ${step}\n  ${detail}\n`);
  process.exit(1);
}

// BLOCKED is not FAILED: a missing credential is a person's job, and exiting
// non-zero here would make a wrapper retry something no retry can fix.
if (!clientEmail || !privateKey || domains.length === 0) {
  console.log(JSON.stringify({
    blocked: true,
    reason: 'dwd_not_configured',
    detail: 'set GOOGLE_DWD_CLIENT_EMAIL, GOOGLE_DWD_PRIVATE_KEY and GOOGLE_DWD_DOMAINS',
    have: {
      GOOGLE_DWD_CLIENT_EMAIL: Boolean(clientEmail),
      GOOGLE_DWD_PRIVATE_KEY: Boolean(privateKey),
      GOOGLE_DWD_DOMAINS: domains,
    },
  }, null, 2));
  process.exit(0);
}

const domain = subject.slice(subject.lastIndexOf('@') + 1);
if (!domains.includes(domain)) {
  fail('domain allowlist',
    `${subject} is not on an authorised domain (${domains.join(', ')}). ` +
    'This is the guard working: add the domain to GOOGLE_DWD_DOMAINS if it is genuinely yours.');
}

const b64 = (input) => Buffer.from(input).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(`\nDelegation check for ${subject}`);
console.log(`  service account : ${clientEmail}`);
console.log(`  domains allowed : ${domains.join(', ')}`);
console.log(`  scope           : ${SCOPE}\n`);

// ---- 1. mint -------------------------------------------------------------
const iat = Math.floor(Date.now() / 1000);
const signingInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
  b64(JSON.stringify({ iss: clientEmail, sub: subject, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
let assertion;
try {
  assertion = `${signingInput}.${b64(createSign('RSA-SHA256').update(signingInput).sign(privateKey))}`;
} catch (e) {
  fail('signing the assertion', `${e.message} — GOOGLE_DWD_PRIVATE_KEY is not a usable PEM key.`);
}

const tokenResp = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString(),
});
if (!tokenResp.ok) {
  const body = await tokenResp.text().catch(() => '');
  fail('minting a delegated token',
    `HTTP ${tokenResp.status} ${body.slice(0, 300)}\n  ` +
    'unauthorized_client usually means the admin-console grant is missing, has a different\n  ' +
    'client id, or lists a different scope. It can also mean the grant has not propagated yet.');
}
const { access_token: accessToken } = await tokenResp.json();
if (!accessToken) fail('minting a delegated token', 'Google returned no access_token');
console.log('  [1/4] minted a delegated access token          OK');

const authed = (path, init = {}) => fetch(`${CALENDAR_API}${path}`, {
  ...init,
  headers: { ...(init.headers || {}), authorization: `Bearer ${accessToken}` },
});

// ---- 2. create -----------------------------------------------------------
const startAt = new Date(Date.now() + 24 * 3600 * 1000);
const endAt = new Date(startAt.getTime() + 15 * 60 * 1000);
const createResp = await authed('/calendars/primary/events?sendUpdates=none', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    summary: 'OASIS delegation check (safe to ignore)',
    description: 'Created by scripts/dwd_check.mjs. It deletes itself immediately.',
    start: { dateTime: startAt.toISOString() },
    end: { dateTime: endAt.toISOString() },
    visibility: 'private',
    reminders: { useDefault: false, overrides: [] },
  }),
});
if (!createResp.ok) {
  const body = await createResp.text().catch(() => '');
  fail('creating a test event', `HTTP ${createResp.status} ${body.slice(0, 300)}`);
}
const created = await createResp.json();
if (!created.id) fail('creating a test event', 'Google returned no event id');
console.log(`  [2/4] created a private event on their calendar OK  (${created.id})`);

// Everything after this point must clean up, whatever happens.
let exitCode = 0;
try {
  // ---- 3. read back ------------------------------------------------------
  const readResp = await authed(`/calendars/primary/events/${encodeURIComponent(created.id)}`);
  if (!readResp.ok) {
    console.error(`  [3/4] read the event back                      FAILED (HTTP ${readResp.status})`);
    exitCode = 1;
  } else {
    const read = await readResp.json();
    const organizer = read.organizer?.email || '(unknown)';
    console.log(`  [3/4] read the event back                      OK  (organizer ${organizer})`);
    if (organizer.toLowerCase() !== subject) {
      console.error(
        `\n  WARNING: the event landed on ${organizer}, not ${subject}.\n` +
        '  A reminder that is not on the rep\'s own calendar will not reach their phone.',
      );
      exitCode = 1;
    }
  }
} finally {
  // ---- 4. delete ---------------------------------------------------------
  const delResp = await authed(
    `/calendars/primary/events/${encodeURIComponent(created.id)}?sendUpdates=none`,
    { method: 'DELETE' },
  );
  if (delResp.ok || delResp.status === 404 || delResp.status === 410) {
    console.log('  [4/4] deleted the test event                   OK');
  } else {
    console.error(
      `  [4/4] deleted the test event                   FAILED (HTTP ${delResp.status})\n` +
      `  Remove "${created.id}" from ${subject}'s calendar by hand.`,
    );
    exitCode = 1;
  }
}

console.log(
  exitCode === 0
    ? `\n  Delegation is working for ${subject}. Reps on ${domain} need no setup.\n`
    : '\n  Delegation is NOT fully working. Do not tell the team reminders are live.\n',
);
process.exit(exitCode);
