// SPDX-License-Identifier: Apache-2.0
// Tenant-facing worker. All security-relevant behaviour lives in @rose/core; this file
// only wires the module manifest into it.
import { createTenantWorker, TenantDurableObject, tenantMigrations } from "@rose/core";
import { modules } from "./modules";

/** One instance per tenant: that tenant's private database. */
export class TenantDO extends TenantDurableObject {
  protected migrations() {
    return tenantMigrations(modules);
  }
}

export default createTenantWorker({ modules });
