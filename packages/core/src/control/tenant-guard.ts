// SPDX-License-Identifier: Apache-2.0
import { forbidden, notFound, type AppError } from "../errors";
import type { TenantStatus } from "./tenants";
import { PLATFORM_SCOPE } from "./users";

export const ROOT_SCOPE = "root";

export const nonTenantScope = (scope: string): boolean => scope === PLATFORM_SCOPE || scope === ROOT_SCOPE;

export const ACTIVE_TENANT_GUARD =
  `(? IN ('${PLATFORM_SCOPE}', '${ROOT_SCOPE}') OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status != 'active'))`;

export function refuseInactiveTenant(status: TenantStatus | null | undefined): AppError {
  if (status === "pending_deletion") return forbidden("This workspace is scheduled for deletion.");
  if (status === "suspended") return forbidden("This workspace is suspended. Contact support.");
  return notFound();
}

export const tenantStatus = (db: D1Database, scope: string): Promise<TenantStatus | null> =>
  db.prepare("SELECT status FROM tenants WHERE id = ?").bind(scope).first<{ status: TenantStatus }>().then((r) => r?.status ?? null);
