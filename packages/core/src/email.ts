// SPDX-License-Identifier: Apache-2.0
import { type CoreEnv, isDev } from "./env";
import { misconfigured } from "./errors";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/**
 * Deliver a transactional email. Add a provider by adding a branch here; nothing else
 * in the codebase knows how mail is sent.
 */
export async function sendEmail(env: CoreEnv, mail: Email): Promise<void> {
  const provider = env.EMAIL_PROVIDER ?? "console";
  if (provider === "resend") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw misconfigured("Set RESEND_API_KEY and EMAIL_FROM to send email.");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
    return;
  }
  // Console delivery prints sign-in codes, so it must never run in production.
  if (!isDev(env)) throw misconfigured("No email provider configured. Set EMAIL_PROVIDER.");
  if (env.ENVIRONMENT === "development") console.log(`\n✉  To: ${mail.to}\n   ${mail.subject}\n   ${mail.text.replace(/\n/g, "\n   ")}\n`);
}
