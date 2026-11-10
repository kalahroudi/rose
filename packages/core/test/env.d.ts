// SPDX-License-Identifier: Apache-2.0
import type { TenantWorkerEnv } from "../src";

declare global {
  namespace Cloudflare {
    interface Env extends TenantWorkerEnv {}
  }
}
