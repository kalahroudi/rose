// SPDX-License-Identifier: Apache-2.0
// Development only. Runs both workers in one local runtime so they share the control-plane
// database, and routes each request to the right one. Never deployed.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.port === env.ADMIN_PORT || url.hostname.startsWith("admin.") ? env.ADMIN : env.APP;
    return target.fetch(request);
  },
};
