// SPDX-License-Identifier: Apache-2.0
// Operator-plane API of @rose/core, for the admin worker only. Everything here is
// cross-tenant by nature, which is why it is kept out of the main entry point: the
// tenant app and its modules must never import it (enforced by `pnpm guard`).

export * from "./control/tenants";
export * from "./control/users";
export * from "./control/domains";
export * from "./control/jobs";
export * from "./control/audit";
export * from "./control/settings";
export { sweepExpired } from "./control/sessions";
export { createAuthRoutes, currentSession, type AuthRealm } from "./auth/routes";
export { listPasskeys } from "./auth/passkeys";
export { clientIp, csrfGuard, errorHandler, parse, rateLimit, readJson, requestContext, type BaseVars } from "./http/base";
export * as cloudflare from "./cloudflare";
export { invalidateHostCache } from "./tenancy/resolve";
