import "server-only";
/**
 * Transactional mail for account-critical auth flows (password reset).
 *
 * Reuses the SMTP identity the e-sign path already uses (ESIGN_FROM_EMAIL /
 * ESIGN_FROM_APP_PASSWORD) rather than introducing a new sender — one
 * transactional identity, one place to rotate.
 *
 * Deliberately NOT routed through the marketing/outreach senders: a password
 * reset must never inherit unsubscribe handling, suppression lists, or send
 * throttling meant for campaigns.
 *
 * Fails LOUD. A silently-dropped reset email looks identical to "the user never
 * clicked", and the operator ends up locked out with no signal anywhere.
 */

export async function sendAuthEmail(input: {
    to: string;
    subject: string;
    text: string;
}): Promise<{ ok: boolean; error?: string }> {
    const user = (process.env.ESIGN_FROM_EMAIL || "").trim();
    const pass = (process.env.ESIGN_FROM_APP_PASSWORD || "").replace(/\s+/g, "");

    if (!user || !pass) {
        const msg =
            "auth email not configured: ESIGN_FROM_EMAIL / ESIGN_FROM_APP_PASSWORD absent. "
            + "Password reset cannot be delivered.";
        console.error(`[auth-email] ${msg} to=${input.to} subject=${input.subject}`);
        return { ok: false, error: msg };
    }

    try {
        const nodemailer = await import("nodemailer");
        const transport = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user, pass },
        });
        const fromName = (process.env.ESIGN_FROM_NAME || "").trim() || "OASIS AI";
        await transport.sendMail({
            from: `"${fromName}" <${user}>`,
            to: input.to,
            subject: input.subject,
            text: input.text,
        });
        return { ok: true };
    } catch (e) {
        const error = e instanceof Error ? e.message : "send_failed";
        console.error(`[auth-email] send failed to=${input.to}: ${error}`);
        return { ok: false, error };
    }
}
