import "server-only";

/** Dedicated transactional sender for account-security mail. */
export type AuthEmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
};

type AuthEmailEnvironment = Record<string, string | undefined>;
type AuthEmailTransport = {
  sendMail(input: Record<string, unknown>): Promise<{
    accepted?: Array<string | { address?: string }>;
    rejected?: Array<string | { address?: string }>;
  }>;
};

export type AuthEmailResult =
  | { ok: true }
  | { ok: false; error: string; code: "not_configured" | "unsafe_sender" | "send_failed" };

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
]);

function emailDomain(value: string): string | null {
  const match = value.trim().toLowerCase().match(/^[^\s@]+@([^\s@]+)$/);
  return match?.[1] || null;
}

function hasHeaderBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * Resolve dedicated AUTH_* credentials first, then the existing company-domain
 * Google Workspace identity. E-sign, outreach, tenant SMTP, and consumer Gmail
 * identities are intentionally not password-reset fallbacks.
 */
export function resolveAuthEmailConfig(
  env: AuthEmailEnvironment = process.env,
): { ok: true; config: AuthEmailConfig } | { ok: false; error: string; code: "not_configured" | "unsafe_sender" } {
  let host = (env.AUTH_SMTP_HOST || "").trim();
  let portText = (env.AUTH_SMTP_PORT || "").trim();
  let user = (env.AUTH_SMTP_USER || "").trim();
  let password = env.AUTH_SMTP_PASSWORD || "";
  let fromEmail = (env.AUTH_FROM_EMAIL || "").trim().toLowerCase();
  const fromName = (env.AUTH_FROM_NAME || "").trim() || "OASIS AI Account Security";
  const hasDedicatedConfiguration = [
    env.AUTH_SMTP_HOST,
    env.AUTH_SMTP_PORT,
    env.AUTH_SMTP_USER,
    env.AUTH_SMTP_PASSWORD,
    env.AUTH_FROM_EMAIL,
    env.AUTH_SMTP_SECURE,
  ].some((value) => !!value?.trim());
  let usingWorkspaceFallback = false;

  // Existing production bridge: a Google Workspace mailbox on the company's
  // custom domain. This fallback is intentionally exact and cannot consume
  // GMAIL_FROM_ADDRESS, ESIGN_*, or any tenant/outreach sender identity.
  if (!hasDedicatedConfiguration) {
    const workspaceUser = (env.GMAIL_USER || "").trim().toLowerCase();
    const workspacePassword = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
    if (workspaceUser && workspacePassword) {
      usingWorkspaceFallback = true;
      host = "smtp.gmail.com";
      portText = "465";
      user = workspaceUser;
      password = workspacePassword;
      fromEmail = workspaceUser;
    }
  }

  const port = Number(portText);

  if (!host || !portText || !user || !password.trim() || !fromEmail) {
    return {
      ok: false,
      code: "not_configured",
      error: "Dedicated account-security email is not configured.",
    };
  }
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    hasHeaderBreak(host) ||
    hasHeaderBreak(user) ||
    hasHeaderBreak(fromEmail) ||
    hasHeaderBreak(fromName) ||
    (env.AUTH_SMTP_SECURE != null &&
      !["true", "false"].includes(env.AUTH_SMTP_SECURE.trim().toLowerCase())) ||
    !emailDomain(fromEmail)
  ) {
    return { ok: false, code: "unsafe_sender", error: "Account-security sender is invalid." };
  }
  const fromDomain = emailDomain(fromEmail);
  const userDomain = emailDomain(user);
  const allowedDomains = new Set(
    (env.AUTH_ALLOWED_FROM_DOMAINS || "oasisai.work")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    (fromDomain && PERSONAL_EMAIL_DOMAINS.has(fromDomain)) ||
    (userDomain && PERSONAL_EMAIL_DOMAINS.has(userDomain)) ||
    !fromDomain ||
    !allowedDomains.has(fromDomain) ||
    (userDomain !== null && !allowedDomains.has(userDomain))
  ) {
    return {
      ok: false,
      code: "unsafe_sender",
      error: "Account-security mail must use an allowlisted company-domain sender.",
    };
  }
  if (
    usingWorkspaceFallback &&
    (fromDomain !== "oasisai.work" || userDomain !== "oasisai.work")
  ) {
    return {
      ok: false,
      code: "unsafe_sender",
      error: "The Google Workspace fallback must use an oasisai.work mailbox.",
    };
  }

  const secure = hasDedicatedConfiguration && env.AUTH_SMTP_SECURE
    ? env.AUTH_SMTP_SECURE.trim().toLowerCase() === "true"
    : port === 465;
  return {
    ok: true,
    config: { host, port, secure, user, password, fromEmail, fromName },
  };
}

function acceptedAddress(value: string | { address?: string }): string {
  return (typeof value === "string" ? value : value.address || "").trim().toLowerCase();
}

/**
 * Sends a password-reset/account-security message from the dedicated system
 * identity. The optional dependency injection is for offline tests only.
 */
export async function sendAuthEmail(
  input: { to: string; subject: string; text: string },
  deps: { env?: AuthEmailEnvironment; transport?: AuthEmailTransport } = {},
): Promise<AuthEmailResult> {
  const resolved = resolveAuthEmailConfig(deps.env ?? process.env);
  if (!resolved.ok) {
    console.error(`[auth-email] ${resolved.code}: ${resolved.error}`);
    return resolved;
  }
  const recipient = input.to.trim().toLowerCase();
  if (!emailDomain(recipient) || hasHeaderBreak(input.subject)) {
    return { ok: false, code: "send_failed", error: "Invalid auth-email envelope." };
  }

  try {
    let transport = deps.transport;
    if (!transport) {
      const nodemailer = await import("nodemailer");
      transport = nodemailer.createTransport({
        host: resolved.config.host,
        port: resolved.config.port,
        secure: resolved.config.secure,
        requireTLS: !resolved.config.secure,
        auth: { user: resolved.config.user, pass: resolved.config.password },
      });
    }
    const receipt = await transport.sendMail({
      from: { name: resolved.config.fromName, address: resolved.config.fromEmail },
      to: recipient,
      subject: input.subject,
      text: input.text,
    });
    const rejected = (receipt.rejected || []).map(acceptedAddress);
    const accepted = (receipt.accepted || []).map(acceptedAddress);
    if (rejected.includes(recipient) || !accepted.includes(recipient)) {
      throw new Error("recipient_not_accepted");
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "send_failed";
    console.error(`[auth-email] send_failed: ${message}`);
    return { ok: false, code: "send_failed", error: "Account-security email could not be sent." };
  }
}
