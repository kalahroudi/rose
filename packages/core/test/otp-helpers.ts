// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { SEND_GAP_MS } from "../src/control/otp";

export const ageOut = (scope: string) =>
  env.DB.prepare("UPDATE login_codes SET created_at = created_at - ? WHERE scope = ?").bind(SEND_GAP_MS + 1, scope).run();
