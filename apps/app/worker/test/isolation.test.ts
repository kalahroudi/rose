// SPDX-License-Identifier: Apache-2.0
// DO NOT DELETE OR WEAKEN. This runs the tenant-isolation contract against every module
// in the manifest. A new module is covered automatically the moment it is registered.
import { env, SELF } from "cloudflare:test";
import { describeTenantIsolation } from "@rose/core/testing";
import { modules } from "../modules";

describeTenantIsolation(env, SELF, modules);
