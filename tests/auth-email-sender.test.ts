import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAuthEmailConfig, sendAuthEmail } from "@/lib/auth-email";

const validEnv = {
  AUTH_SMTP_HOST: "smtp.transactional.example",
  AUTH_SMTP_PORT: "587",
  AUTH_SMTP_USER: "account-security-service",
  AUTH_SMTP_PASSWORD: "test-only-password",
  AUTH_FROM_EMAIL: "security@oasisai.work",
  AUTH_FROM_NAME: "OASIS AI Account Security",
};

async function main() {
  assert.deepEqual(
    resolveAuthEmailConfig({
      ESIGN_FROM_EMAIL: "personal@gmail.com",
      ESIGN_FROM_APP_PASSWORD: "legacy-secret",
      ESIGN_FROM_NAME: "OASIS E-Sign",
    }),
    {
      ok: false,
      code: "not_configured",
      error: "Dedicated account-security email is not configured.",
    },
    "e-sign credentials must never be a password-reset fallback",
  );

  const personalFrom = resolveAuthEmailConfig({
    ...validEnv,
    AUTH_SMTP_USER: "personal@gmail.com",
    AUTH_FROM_EMAIL: "personal@gmail.com",
  });
  assert.equal(personalFrom.ok, false);
  if (!personalFrom.ok) assert.equal(personalFrom.code, "unsafe_sender");

  const workspaceFallback = resolveAuthEmailConfig({
    GMAIL_USER: "conaugh@oasisai.work",
    GMAIL_APP_PASSWORD: "offline test credential",
  });
  assert.equal(workspaceFallback.ok, true, "company Google Workspace is a valid compatibility path");
  if (workspaceFallback.ok) {
    assert.equal(workspaceFallback.config.host, "smtp.gmail.com");
    assert.equal(workspaceFallback.config.port, 465);
    assert.equal(workspaceFallback.config.secure, true);
    assert.equal(workspaceFallback.config.fromEmail, "conaugh@oasisai.work");
    assert.equal(workspaceFallback.config.fromName, "OASIS AI Account Security");
  }

  const personalWorkspaceFallback = resolveAuthEmailConfig({
    GMAIL_USER: "personal@gmail.com",
    GMAIL_APP_PASSWORD: "offline test credential",
  });
  assert.equal(personalWorkspaceFallback.ok, false);
  if (!personalWorkspaceFallback.ok) {
    assert.equal(personalWorkspaceFallback.code, "unsafe_sender");
  }

  const customWorkspaceFallback = resolveAuthEmailConfig({
    GMAIL_USER: "security@subsidiary.example",
    GMAIL_APP_PASSWORD: "offline test credential",
    AUTH_ALLOWED_FROM_DOMAINS: "oasisai.work, subsidiary.example",
  });
  assert.equal(
    customWorkspaceFallback.ok,
    false,
    "the compatibility fallback stays pinned to oasisai.work even when AUTH_* approves another sender",
  );

  const arbitraryCustomDomain = resolveAuthEmailConfig({
    ...validEnv,
    AUTH_SMTP_USER: "service-account",
    AUTH_FROM_EMAIL: "security@attacker.example",
  });
  assert.equal(
    arbitraryCustomDomain.ok,
    false,
    "a non-consumer domain is still rejected unless it is explicitly allowlisted",
  );

  const explicitlyAllowedDomain = resolveAuthEmailConfig({
    ...validEnv,
    AUTH_FROM_EMAIL: "security@subsidiary.example",
    AUTH_ALLOWED_FROM_DOMAINS: "oasisai.work, subsidiary.example",
  });
  assert.equal(explicitlyAllowedDomain.ok, true);

  assert.equal(
    resolveAuthEmailConfig({ ...validEnv, AUTH_FROM_NAME: "OASIS\r\nBcc: attacker@test" }).ok,
    false,
    "header injection is rejected before transport construction",
  );

  const resolved = resolveAuthEmailConfig(validEnv);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.config.fromEmail, "security@oasisai.work");
    assert.equal(resolved.config.fromName, "OASIS AI Account Security");
    assert.equal(resolved.config.secure, false, "port 587 uses required STARTTLS");
  }

  let envelope: Record<string, unknown> | null = null;
  const delivery = await sendAuthEmail(
    {
      to: "owner@oasisai.work",
      subject: "Reset your OASIS AI password",
      text: "offline fixture — no live send",
    },
    {
      env: validEnv,
      transport: {
        async sendMail(input) {
          envelope = input;
          return { accepted: ["owner@oasisai.work"], rejected: [] };
        },
      },
    },
  );
  assert.deepEqual(delivery, { ok: true });
  assert.deepEqual(envelope?.from, {
    name: "OASIS AI Account Security",
    address: "security@oasisai.work",
  });
  assert.equal(envelope?.to, "owner@oasisai.work");

  const originalError = console.error;
  console.error = () => {};
  try {
    const rejected = await sendAuthEmail(
      { to: "owner@oasisai.work", subject: "Reset", text: "fixture" },
      {
        env: validEnv,
        transport: {
          async sendMail() {
            return { accepted: [], rejected: ["owner@oasisai.work"] };
          },
        },
      },
    );
    assert.equal(rejected.ok, false, "a rejected SMTP receipt is not reported as sent");

    const missingReceipt = await sendAuthEmail(
      { to: "owner@oasisai.work", subject: "Reset", text: "fixture" },
      {
        env: validEnv,
        transport: {
          async sendMail() {
            return {};
          },
        },
      },
    );
    assert.equal(
      missingReceipt.ok,
      false,
      "a missing provider acceptance receipt is not reported as sent",
    );

    let transportCalled = false;
    const legacyOnly = await sendAuthEmail(
      { to: "owner@oasisai.work", subject: "Reset", text: "fixture" },
      {
        env: {
          ESIGN_FROM_EMAIL: "personal@gmail.com",
          ESIGN_FROM_APP_PASSWORD: "legacy-secret",
        },
        transport: {
          async sendMail() {
            transportCalled = true;
            return { accepted: ["owner@oasisai.work"] };
          },
        },
      },
    );
    assert.equal(legacyOnly.ok, false);
    assert.equal(transportCalled, false, "unsafe fallback is blocked before any network call");
  } finally {
    console.error = originalError;
  }

  const route = readFileSync(
    resolve(process.cwd(), "app/api/auth/turso-reset-request/route.ts"),
    "utf8",
  );
  assert.match(route, /const delivery = await sendAuthEmail/);
  assert.match(route, /if \(!delivery\.ok\)[\s\S]*?SET used_at = \?/);
  assert.match(route, /isAuthenticatedSelf[\s\S]*?status: 503/);
  assert.doesNotMatch(route, /ESIGN_FROM_|adonyess@gmail\.com/i);

  const authEmailSource = readFileSync(resolve(process.cwd(), "lib/auth-email.ts"), "utf8");
  assert.doesNotMatch(authEmailSource, /ESIGN_FROM_|adonyess@gmail\.com/i);
  assert.match(authEmailSource, /AUTH_SMTP_HOST/);
  assert.match(authEmailSource, /GMAIL_USER/);
  assert.match(authEmailSource, /PERSONAL_EMAIL_DOMAINS/);
  assert.match(authEmailSource, /connectionTimeout:\s*10_000/);
  assert.match(authEmailSource, /greetingTimeout:\s*10_000/);
  assert.match(authEmailSource, /socketTimeout:\s*20_000/);

  console.log("auth email sender isolation: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
