// SPDX-License-Identifier: Apache-2.0
// Shapes of the tenant API responses the SPA reads.

export type Role = "owner" | "admin" | "member";

export interface SessionView {
  user: { id: string; email: string; name: string };
  role: Role;
  permissions: string[];
  hasPasskey: boolean;
  method: string;
}

export interface TenantView {
  name: string;
  slug: string;
  status: "active" | "suspended" | "deleting";
}

export interface Bootstrap {
  app: { name: string; baseDomain: string };
  dev: boolean;
  modules: string[];
  upstream: boolean;
  host: "root" | "tenant" | "unknown";
  tenant?: TenantView;
  session?: SessionView | null;
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
  members: number;
  invitations: number;
  apiKeys: number;
  recent: AuditEntry[];
}

export interface Member {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  created_at: number;
  last_login_at: number | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  expires_at: number;
  created_at: number;
}

export interface ApiKey {
  id: string;
  name: string;
  role: Role;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export interface RootVerified {
  ticket: string;
  workspaces: { slug: string; name: string; role: Role }[];
}
