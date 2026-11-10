// SPDX-License-Identifier: Apache-2.0
// Shapes returned by the admin worker API (apps/admin/worker).

export interface Bootstrap {
  app: { name: string; baseDomain: string; appUrlTemplate: string };
  dev: boolean;
  session: { user: { id: string; email: string; name: string }; role: "owner" | "operator"; hasPasskey: boolean; method: string } | null;
}

export type TenantStatus = "active" | "suspended" | "deleting";
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  created_at: number;
  updated_at: number;
  members: number;
  domains: number;
}

export interface Member {
  user_id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: number;
  last_login_at: number | null;
}

export type DomainStatus = "pending" | "active" | "failed";
export interface Domain {
  hostname: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  status: DomainStatus;
  provider_id: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}
export interface DomainDetail {
  records?: { type: string; name: string; value: string }[];
  errors?: string[];
  ssl?: string;
  note?: string;
}

export interface Operator {
  user_id: string;
  email: string;
  name: string;
  role: "owner" | "operator";
  created_at: number;
  last_login_at: number | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
}

export interface Overview {
  tenants: { active: number; suspended: number; deleting: number; total: number };
  users: number;
  domains: { pending: number; active: number; failed: number };
  failedJobs: number;
  series: { day: string; count: number }[];
  attention: { id: string; severity: "high" | "medium"; title: string; detail: string; href: string }[];
}

export interface SetupCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  why: string;
}
export interface SetupStatus {
  checks: SetupCheck[];
  cloudflare: { connected: boolean; zone: string | null };
  github: { connected: boolean; repo: string | null; branch: string | null; hasToken: boolean; ci: { status: string; url: string } | null };
}
