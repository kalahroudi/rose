// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the SPA is served by Vite (hot reload) and API calls are proxied to the
// local Workers runtime started by `pnpm dev`. The original Host header is preserved so
// the worker sees the same origin the browser does (tenant resolution, cookies, passkeys).
// Ports can be overridden (ROSE_WORKERS_PORT, ROSE_PORT) to run a second stack side by side.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const workers = { target: `http://127.0.0.1:${env.ROSE_WORKERS_PORT ?? 8787}`, changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(env.ROSE_PORT ?? 5174),
    strictPort: true,
    allowedHosts: [".localhost"],
    // The dev server serves the project folder; keep secrets and config out of reach.
    fs: { deny: [".dev.vars", ".dev.vars.*", ".env", ".env.*", "*.{crt,pem}", "wrangler*.jsonc"] },
    proxy: { "/api": workers, "/auth": workers, "/svc": workers },
  },
  build: { outDir: "dist/client", emptyOutDir: true, target: "es2022", sourcemap: false },
});
