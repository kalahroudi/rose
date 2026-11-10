// SPDX-License-Identifier: Apache-2.0
import type { TenantWorkerEnv } from "@rose/core";

declare global {
  namespace Cloudflare {
    interface Env extends TenantWorkerEnv {}
  }
}
