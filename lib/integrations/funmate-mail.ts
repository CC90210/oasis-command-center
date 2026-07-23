import "server-only";

export type FunmateMailCredentials = {
  email: string;
  appPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
};

export function getFunmateMailCredentials(): FunmateMailCredentials {
  const email = process.env.FUNMATE_EMAIL?.trim();
  const appPassword = process.env.FUNMATE_APP_PASSWORD?.replace(/\s+/g, "");
  if (!email) throw new Error("missing_creds:FUNMATE_EMAIL");
  if (!appPassword) throw new Error("missing_creds:FUNMATE_APP_PASSWORD");
  return {
    email,
    appPassword,
    smtpHost: process.env.FUNMATE_SMTP_HOST?.trim() || "smtp.gmail.com",
    smtpPort: Number(process.env.FUNMATE_SMTP_PORT) || 587,
    smtpSecure: process.env.FUNMATE_SMTP_SECURE === "true",
    imapHost: process.env.FUNMATE_IMAP_HOST?.trim() || "imap.gmail.com",
    imapPort: Number(process.env.FUNMATE_IMAP_PORT) || 993,
    imapSecure: process.env.FUNMATE_IMAP_SECURE !== "false",
  };
}

export async function verifyFunmateSmtp(): Promise<
  { ok: true; email: string } | { ok: false; error: string }
> {
  try {
    const c = getFunmateMailCredentials();
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpSecure,
      requireTLS: !c.smtpSecure,
      auth: { user: c.email, pass: c.appPassword },
    });
    await transport.verify();
    return { ok: true, email: c.email };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "funmate_smtp_failed" };
  }
}

