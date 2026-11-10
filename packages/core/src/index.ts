// SPDX-License-Identifier: Apache-2.0
// Public API of @rose/core. Apps and modules import from here only.

// Building a tenant app
export { createTenantApp, createTenantWorker, tenantMigrations, tenantJobHandlers, tenantTick, type TenantAppOptions } from "./tenant-app";
export { defineModule, CORE_PERMISSIONS, buildPermissions, permissionsOf } from "./modules";
export type { Actor, IsolationProbe, ModuleContext, ModuleDefinition, ModuleJobContext, ModuleRoute } from "./modules";
export { TenantDurableObject, CORE_TENANT_MIGRATIONS, type TenantMigration, type SqlValue, type SqlStatement, type SqlResult } from "./tenancy/tenant-do";
export { TenantDb, type TenantContext } from "./tenancy/context";
export { TenantCrypto } from "./crypto";

// HTTP helpers
export { AppError, badRequest, conflict, forbidden, invalid, misconfigured, notFound, tooMany, unauthorized } from "./errors";
export { listQuerySchema, likePattern, offsetOf, orderBy, MAX_PAGE_SIZE, type ListQuery, type Page } from "./http/pagination";
export { newId, now, randomToken } from "./ids";
export type { CoreEnv, PlatformWorkerEnv, TenantWorkerEnv, RateLimiter } from "./env";
export { isDev } from "./env";
export { verifyJwtHs256, signJwtHs256 } from "./crypto";
