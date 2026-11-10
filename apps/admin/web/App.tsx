// SPDX-License-Identifier: Apache-2.0
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, AuthLayout, createQueryClient, EmptyState, Page, Shell, SignIn, Splash, UiProvider, type NavItem } from "@rose/ui";
import { createContext, useContext } from "react";
import { Route, Switch } from "wouter";
import { AccountPage } from "./pages/Account";
import { ActivityPage } from "./pages/Activity";
import { AuditPage } from "./pages/Audit";
import { DomainsPage } from "./pages/Domains";
import { OperatorsPage } from "./pages/Operators";
import { OverviewPage } from "./pages/Overview";
import { SetupPage } from "./pages/Setup";
import { TenantsPage } from "./pages/Tenants";
import type { Bootstrap } from "./types";

const queryClient = createQueryClient();

type Session = Bootstrap & { session: NonNullable<Bootstrap["session"]> };
const SessionContext = createContext<Session | null>(null);

/** The signed-in operator and deployment facts. Only available inside the shell. */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside of the signed-in shell");
  return s;
}

/** Public URL of a tenant's app, from its host name. */
export function tenantUrl(boot: Bootstrap, slug: string): string {
  return boot.app.appUrlTemplate.replace("{host}", `${slug}.${boot.app.baseDomain}`);
}

const list = (path: string, key: string) => () => void queryClient.prefetchQuery({ queryKey: [key, "page=1&pageSize=25"], queryFn: () => api(`${path}?page=1&pageSize=25`) });

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/tenants", label: "Tenants", icon: "building", prefetch: list("/api/tenants", "tenants") },
  { href: "/domains", label: "Domains", icon: "globe", prefetch: list("/api/domains", "domains") },
  { href: "/operators", label: "Operators", icon: "users", section: "Platform", prefetch: list("/api/operators", "operators") },
  { href: "/activity", label: "Activity", icon: "activity", section: "Platform" },
  { href: "/audit", label: "Audit log", icon: "list", section: "Platform" },
  { href: "/setup", label: "Setup", icon: "wrench", section: "Platform" },
  { href: "/account", label: "Your account", icon: "lock", section: "You" },
];

function Root() {
  const qc = useQueryClient();
  const boot = useQuery({ queryKey: ["bootstrap"], queryFn: () => api<Bootstrap>("/api/bootstrap"), staleTime: 60_000 });
  if (boot.isPending) return <Splash />;
  if (boot.error || !boot.data) {
    return (
      <AuthLayout appName="Admin">
        <EmptyState icon="alert" title="The console could not start">{boot.error?.message ?? "No response from the server."}</EmptyState>
      </AuthLayout>
    );
  }
  const b = boot.data;
  if (!b.session) {
    return (
      <AuthLayout appName={`${b.app.name} Admin`} footer="This console is for platform operators. Customers sign in at their workspace address.">
        <SignIn base="/api/auth" passkeys title="Sign in" subtitle="Use your passkey, or get a one-time code by email." onDone={() => void qc.invalidateQueries({ queryKey: ["bootstrap"] })} />
      </AuthLayout>
    );
  }
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    // Drop everything cached for this person, then re-check who is signed in. The bootstrap
    // query itself must stay mounted, or the screen would keep showing the old session.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "bootstrap" });
    await qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  return (
    <SessionContext.Provider value={b as Session}>
      <Shell brand={{ name: b.app.name, sub: "Admin console" }} nav={NAV} user={b.session.user} onSignOut={() => void signOut()} jobs={{ path: "/api/jobs", href: "/activity" }}>
        <Switch>
          <Route path="/" component={OverviewPage} />
          <Route path="/tenants" component={TenantsPage} />
          <Route path="/domains" component={DomainsPage} />
          <Route path="/operators" component={OperatorsPage} />
          <Route path="/activity" component={ActivityPage} />
          <Route path="/audit" component={AuditPage} />
          <Route path="/setup" component={SetupPage} />
          <Route path="/account" component={AccountPage} />
          <Route>
            <Page title="Page not found" help={{ what: "There is nothing at this address. Use the menu on the left to get back." }}>
              <EmptyState icon="search" title="Nothing here">The link may be old or mistyped.</EmptyState>
            </Page>
          </Route>
        </Switch>
      </Shell>
    </SessionContext.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <Root />
      </UiProvider>
    </QueryClientProvider>
  );
}
