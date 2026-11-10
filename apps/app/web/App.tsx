// SPDX-License-Identifier: Apache-2.0
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, createQueryClient, Gate, Shell, Splash, UiProvider, useToast, errorMessage, type NavItem } from "@rose/ui";
import { useMemo, useState } from "react";
import { Route, Switch } from "wouter";
import { webModules } from "./modules";
import { ActivityPage } from "./pages/Activity";
import { ApiKeysPage } from "./pages/ApiKeys";
import { AuditPage } from "./pages/Audit";
import { MembersPage } from "./pages/Members";
import { NotFoundPage } from "./pages/NotFound";
import { OverviewPage } from "./pages/Overview";
import { ServicePage } from "./pages/Service";
import { SettingsPage } from "./pages/Settings";
import { Onboarding } from "./screens/Onboarding";
import { DeletedScreen, SignInScreen, SuspendedScreen, UnknownScreen } from "./screens/Screens";
import { WorkspaceContext, type Workspace } from "./session";
import type { Bootstrap, SessionView, TenantView } from "./types";

const queryClient = createQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <Root />
      </UiProvider>
    </QueryClientProvider>
  );
}

function Root() {
  const boot = useQuery({ queryKey: ["bootstrap"], queryFn: () => api<Bootstrap>("/api/bootstrap"), staleTime: 60_000 });
  const [deleted, setDeleted] = useState<string | null>(null);
  if (boot.isPending) return <Splash />;
  if (!boot.data) {
    return (
      <main className="center-screen">
        <div style={{ width: "min(480px, 100%)" }}>
          <Gate queries={[boot]}>{() => null}</Gate>
        </div>
      </main>
    );
  }
  const b = boot.data;
  if (deleted) return <DeletedScreen boot={b} slug={deleted} />;
  if (b.host === "root") return <Onboarding boot={b} />;
  if (b.host === "unknown" || !b.tenant) return <UnknownScreen boot={b} />;
  if (b.tenant.status !== "active") return <SuspendedScreen boot={b} tenant={b.tenant} />;
  if (!b.session) return <SignInScreen boot={b} tenant={b.tenant} />;
  return <SignedIn boot={b} tenant={b.tenant} session={b.session} onDeleted={() => setDeleted(b.tenant!.slug)} />;
}

interface CorePage {
  path: string;
  nav: NavItem;
  component: () => React.JSX.Element;
  /** Permission needed to see the page. Omit for pages every member may open. */
  permission?: string;
  show?: boolean;
}

function SignedIn({ boot, tenant, session, onDeleted }: { boot: Bootstrap; tenant: TenantView; session: SessionView; onDeleted(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const workspace = useMemo<Workspace>(
    () => ({ boot, tenant, session, can: (p) => session.permissions.includes(p), markDeleted: onDeleted }),
    [boot, tenant, session, onDeleted],
  );

  // Core pages first, then installed modules, then workspace administration.
  const pages = useMemo<CorePage[]>(() => {
    const modulePages: CorePage[] = webModules
      .filter((m) => boot.modules.includes(m.id))
      .map((m) => ({ path: m.path, nav: m.nav, component: m.component, permission: m.permission }));
    const W = "Workspace";
    const all: CorePage[] = [
      { path: "/", nav: { href: "/", label: "Overview", icon: "home" }, component: OverviewPage },
      ...modulePages,
      { path: "/service", nav: { href: "/service", label: "Service", icon: "server" }, component: ServicePage, permission: "service:use", show: boot.upstream },
      { path: "/members", nav: { href: "/members", label: "Members", icon: "users", section: W }, component: MembersPage, permission: "members:read" },
      { path: "/api-keys", nav: { href: "/api-keys", label: "API keys", icon: "key", section: W }, component: ApiKeysPage, permission: "apikeys:manage" },
      { path: "/activity", nav: { href: "/activity", label: "Activity", icon: "activity", section: W }, component: ActivityPage },
      { path: "/audit", nav: { href: "/audit", label: "Audit log", icon: "list", section: W }, component: AuditPage, permission: "audit:read" },
      { path: "/settings", nav: { href: "/settings", label: "Settings", icon: "settings", section: W }, component: SettingsPage },
    ];
    return all.filter((p) => p.show !== false && (!p.permission || session.permissions.includes(p.permission)));
  }, [boot.modules, boot.upstream, session.permissions]);

  const signOut = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (err) {
      toast.error(errorMessage(err));
      return;
    }
    // Drop everything cached for this person, then re-check who is signed in.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "bootstrap" });
    await qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };

  return (
    <WorkspaceContext.Provider value={workspace}>
      <Shell
        brand={{ name: tenant.name, sub: boot.app.name }}
        nav={pages.map((p) => p.nav)}
        user={{ email: session.user.email, name: session.user.name }}
        onSignOut={() => void signOut()}
        jobs={{ path: "/api/jobs", href: "/activity" }}
      >
        <Switch>
          {pages.map((p) => (
            <Route key={p.path} path={p.path} component={p.component} />
          ))}
          <Route component={NotFoundPage} />
        </Switch>
      </Shell>
    </WorkspaceContext.Provider>
  );
}
