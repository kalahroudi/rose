// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations((env as unknown as { DB: D1Database }).DB, (env as unknown as { TEST_MIGRATIONS: never }).TEST_MIGRATIONS);
