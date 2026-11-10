// SPDX-License-Identifier: Apache-2.0
import type { PlatformWorkerEnv } from "@rose/core";

declare global {
  namespace Cloudflare {
    interface Env extends PlatformWorkerEnv {}
  }
}
