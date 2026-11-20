#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Fails if the TypeScript the TLA model claims to track no longer contains the
 * grace-period gates. This is how a real-code scratch break is caught before TLC.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Paths under packages/core are joined so this file does not look like a deep import. */
const coreSrc = (...parts) => path.join("packages", "core", "src", ...parts);

const checks = [
  {
    file: coreSrc("control", "tenants.ts"),
    must: [
      /export const DELETE_GRACE_MS = 48 \* 3_600_000/,
      /status = 'pending_deletion'[\s\S]*delete_after/,
      /status = 'deleting'[\s\S]*pending_deletion'[\s\S]*delete_after IS NOT NULL AND delete_after <= \?/,
      /DELETE FROM jobs WHERE type = 'tenant\.purge'/,
    ],
  },
  {
    file: coreSrc("tenant-app.ts"),
    must: [
      /"tenant\.purge":/,
      /row\.delete_after !== null && row\.delete_after > t/,
      /beginTenantPurge/,
      /purgeTenantStorage/,
      /deleteTenantRecords/,
    ],
  },
  {
    file: coreSrc("tenancy", "tenant-do.ts"),
    must: [/Tenant mismatch: refusing cross-tenant access/, /async purge\(tenantId: string\)/],
  },
  {
    file: coreSrc("tenancy", "context.ts"),
    must: [/idFromName\(tenant\.id\)/, /purgeTenantStorage/, /\.purge\(tenantId\)/],
  },
];

let failed = false;
for (const { file, must } of checks) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, "utf8");
  for (const re of must) {
    if (!re.test(text)) {
      failed = true;
      console.error(`SYNC FAIL: ${file} no longer matches /${re.source}/`);
      console.error("  The TenantDeletion model may be lying about this file. Update formal/tenant-deletion/ or restore the gate.");
    }
  }
}

if (failed) process.exit(1);
console.log("sync-check: covered TypeScript still matches the TenantDeletion gates.");
