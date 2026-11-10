// SPDX-License-Identifier: Apache-2.0
import { getSetting, operatorCount } from "@rose/core/platform";
import type { PlatformWorkerEnv } from "@rose/core";

export interface SetupCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Why this matters, shown in the UI. */
  why: string;
}

export interface SetupStatus {
  checks: SetupCheck[];
  cloudflare: { connected: boolean; zone: string | null };
  github: { connected: boolean; repo: string | null; branch: string | null; hasToken: boolean; ci: { status: string; url: string } | null };
}

function masterKeyOk(env: PlatformWorkerEnv): boolean {
  try {
    return atob((env.ROSE_MASTER_KEY ?? "").replace(/-/g, "+").replace(/_/g, "/")).length === 32;
  } catch {
    return false;
  }
}

async function latestCi(repo: string, token: string | null): Promise<{ status: string; url: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=1`, {
      headers: { "User-Agent": "rose-starter-kit", Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) return null;
    const run = ((await res.json()) as { workflow_runs?: { status: string; conclusion: string | null; html_url: string }[] }).workflow_runs?.[0];
    return run ? { status: run.conclusion ?? run.status, url: run.html_url } : null;
  } catch {
    return null;
  }
}

/** Live health of this deployment. Every item says what is wrong and why it matters. */
export async function setupStatus(env: PlatformWorkerEnv): Promise<SetupStatus> {
  const prod = env.ENVIRONMENT === "production";
  const get = (k: string) => getSetting(env.DB, env.ROSE_MASTER_KEY, k).catch(() => null);
  const [zone, zoneName, repo, branch, ghToken, operators] = await Promise.all([
    get("cloudflare.zone_id"), get("cloudflare.zone_name"), get("github.repo"), get("github.branch"), get("github.token"), operatorCount(env.DB),
  ]);
  const ci = repo ? await latestCi(repo, ghToken) : null;
  const emailOk = env.EMAIL_PROVIDER === "resend" && !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
  const localDomain = /(^|\.)localhost$|\.test$|^example\.com$/.test(env.APP_BASE_DOMAIN);

  const checks: SetupCheck[] = [
    {
      id: "master-key", label: "Encryption master key",
      status: masterKeyOk(env) ? "ok" : "fail",
      detail: masterKeyOk(env) ? "A valid 256-bit key is configured." : "ROSE_MASTER_KEY is missing or malformed. Run `pnpm setup`.",
      why: "Sign-in codes and stored connection tokens are protected with keys derived from it.",
    },
    {
      id: "email", label: "Email delivery",
      status: emailOk ? "ok" : prod ? "fail" : "warn",
      detail: emailOk ? `Sending as ${env.EMAIL_FROM}.` : prod ? "No email provider is configured, so nobody can receive sign-in codes." : "Development mode: codes are printed in the terminal and shown on the sign-in screen.",
      why: "People sign in with a one-time code sent by email until they add a passkey.",
    },
    {
      id: "rate-limit", label: "Sign-in rate limiting",
      status: env.RL_AUTH ? "ok" : prod ? "fail" : "warn",
      detail: env.RL_AUTH ? "Rate limiter is bound." : "The RL_AUTH binding is missing.",
      why: "Slows down code guessing and email flooding.",
    },
    {
      id: "domain", label: "Base domain",
      status: localDomain ? (prod ? "fail" : "warn") : "ok",
      detail: localDomain ? `Using ${env.APP_BASE_DOMAIN}. Set your real domain with \`pnpm setup\` before going live.` : `Tenants live at <name>.${env.APP_BASE_DOMAIN}.`,
      why: "Each tenant gets its own subdomain; the browser isolates cookies and passkeys per host.",
    },
    {
      id: "operators", label: "More than one platform owner",
      status: operators >= 2 ? "ok" : "warn",
      detail: operators >= 2 ? `${operators} operators.` : "Only one operator. Add a second so you are not locked out.",
      why: "If the only operator loses access to their mailbox, nobody can administer the platform.",
    },
    {
      id: "cloudflare", label: "Cloudflare for SaaS connection",
      status: zone ? "ok" : "warn",
      detail: zone ? `Connected to zone ${zoneName ?? zone}.` : "Not connected. Tenants can use subdomains, but not their own domains.",
      why: "Needed only for customer-owned domains: Cloudflare issues and renews their certificates.",
    },
    {
      id: "github", label: "Source repository",
      status: repo ? (ci && ci.status !== "success" && ci.status !== "in_progress" && ci.status !== "queued" ? "warn" : "ok") : "warn",
      detail: repo ? (ci ? `${repo}: latest CI run ${ci.status}.` : `${repo} connected. No CI runs found yet.`) : "Not connected.",
      why: "Shows whether the security and isolation checks are passing on the code that is deployed.",
    },
  ];
  return {
    checks,
    cloudflare: { connected: !!zone, zone: zoneName },
    github: { connected: !!repo, repo, branch, hasToken: !!ghToken, ci },
  };
}
