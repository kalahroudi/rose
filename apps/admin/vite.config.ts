// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the SPA is served by Vite (hot reload) and API calls are proxied to the
// local Workers runtime started by `pnpm dev`. The original Host header is preserved so
// the worker sees the same origin the browser does (tenant resolution, cookies, passkeys).
const workers = { target: "http://127.0.0.1:8787", changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: [".localhost"],
    proxy: { "/api": workers, "/auth": workers, "/svc": workers },
  },
  build: { outDir: "dist/client", emptyOutDir: true, target: "es2022", sourcemap: false },
});
