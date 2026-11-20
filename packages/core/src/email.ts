// SPDX-License-Identifier: Apache-2.0
import { type CoreEnv, isDev } from "./env";
import { misconfigured } from "./errors";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

// RFC 2606 / RFC 6761 names: nobody can receive mail there, so sending only burns quota
// and sender reputation on a bounce. Tests and the pentest use them for every address.
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/** True when the recipient's domain is reserved and can never accept mail. */
function isReservedRecipient(to: string): boolean {
  const domain = to.slice(to.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.+$/, "");
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** `Acme <login@acme.app>` → `{ name, email }`; a bare address stays a string. */
function parseFrom(from: string): string | { email: string; name: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  const email = m?.[2];
  if (!email) return from.trim();
  const name = (m[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
  return name ? { email, name } : email;
}

/**
 * Deliver a transactional email. Add a provider by adding a branch here; nothing else
 * in the codebase knows how mail is sent.
 */
export async function sendEmail(env: CoreEnv, mail: Email): Promise<void> {
  const provider = env.EMAIL_PROVIDER ?? "console";
  if (provider === "cloudflare" || provider === "resend") {
    if (provider === "cloudflare" && (!env.EMAIL || !env.EMAIL_FROM)) throw misconfigured("Add the EMAIL send_email binding and set EMAIL_FROM to send email.");
    if (provider === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) throw misconfigured("Set RESEND_API_KEY and EMAIL_FROM to send email.");
    if (isReservedRecipient(mail.to)) {
      // Logged without the address or content: both may be personal data.
      console.log(JSON.stringify({ level: "info", at: "email", skipped: "reserved-domain" }));
      return;
    }
    if (provider === "cloudflare") {
      try {
        await env.EMAIL!.send({ from: parseFrom(env.EMAIL_FROM!), to: mail.to, subject: mail.subject, text: mail.text });
      } catch (err) {
        // Provider messages can quote the recipient; keep only the code.
        const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : err instanceof TypeError ? "TypeError" : "unknown";
        throw new Error(`Email provider refused the message (${code})`);
      }
      return;
    }
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
