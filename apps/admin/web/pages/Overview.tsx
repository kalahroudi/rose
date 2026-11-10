// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addPasskey, api, BarChart, Button, Callout, errorMessage, Gate, Icon, IsolationDiagram, Kpi, Page, useToast, type HelpContent } from "@rose/ui";
import { useState } from "react";
import { Link } from "wouter";
import { useSession } from "../App";
import { terms } from "../help/glossary";
import type { Overview } from "../types";

const help: HelpContent = {
  what: "A summary of the whole platform: how many tenants you serve, whether anything needs your attention, and how sign-ups are trending. Every item under “Needs attention” links to the place where you fix it.",
  diagram: { node: <IsolationDiagram />, caption: "Each tenant has a private database and its own key. This console reaches only the shared directory." },
  terms: terms("tenant", "controlPlane", "privateDatabase", "dataKey", "customDomain", "job"),
  why: [
    { q: "Why can I not see tenant data from here?", a: "On purpose. This console has no connection to tenant databases and holds no tenant keys, so a stolen operator session can not be used to read customer data. To help a customer, ask them to invite you to their workspace." },
    { q: "What counts as “needs attention”?", a: "Failed setup checks, failed background tasks, custom domains that failed or are waiting for DNS, and suspended tenants. Items are ordered by impact." },
  ],
  links: [{ label: "Cloudflare for Platforms", href: "https://developers.cloudflare.com/cloudflare-for-platforms/" }],
};

export function OverviewPage() {
  const { session } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });

  const passkey = async () => {
    setAdding(true);
    try {
      await addPasskey("/api/auth");
      await qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.success("Passkey added. Use it next time you sign in.");
    } catch (err) {
      if (!(err instanceof Error && err.name === "NotAllowedError")) toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Page title="Overview" description="Health of your platform at a glance" help={help}>
      <Gate queries={[q]} skeleton="cards">
        {() => {
          const d = q.data!;
          const newThisWeek = d.series.slice(-7).reduce((n, s) => n + s.count, 0);
          return (
            <div className="stack">
              {!session.hasPasskey ? (
                <Callout tone="warn">
                  <div className="row-wrap">
                    <span className="grow">You signed in with an email code. Add a passkey so access to this console does not depend on your mailbox alone.</span>
                    <Button size="sm" icon="fingerprint" busy={adding} onClick={() => void passkey()}>Add a passkey</Button>
                  </div>
                </Callout>
              ) : null}
              <div className="grid">
                <Kpi label="Active tenants" value={d.tenants.active} sub={`${newThisWeek} new in the last 7 days`} help="Tenants whose people can sign in right now. Excludes suspended tenants and those being deleted." />
                <Kpi label="People" value={d.users} sub="Across all tenants and operators" help="Distinct email addresses that have signed in or been invited at least once." />
                <Kpi label="Custom domains" value={d.domains.active} sub={d.domains.pending ? `${d.domains.pending} waiting for DNS` : "None waiting"} help="Customer-owned domains that are verified and serving traffic." />
                <Kpi label="Failed tasks" value={d.failedJobs} sub={d.failedJobs ? "Open Activity to retry" : "All background work is healthy"} help="Background tasks that gave up after five attempts." />
              </div>
              <div className="grid-wide">
                <section className="card">
                  <div className="card-head"><h2 className="card-title">Needs attention</h2></div>
                  {d.attention.length === 0 ? (
                    <div className="attention"><span className="dot dot-ok" /><span>Nothing needs your attention.</span></div>
                  ) : (
                    d.attention.map((a) => (
                      <div className="attention" key={a.id}>
                        <span className={`dot dot-${a.severity}`} aria-label={a.severity === "high" ? "High impact" : "Medium impact"} />
                        <div className="grow">
                          <div><strong>{a.title}</strong></div>
                          <div className="hint">{a.detail}</div>
                        </div>
                        <Link href={a.href} className="btn btn-sm">Fix<Icon name="chevron" /></Link>
                      </div>
                    ))
                  )}
                </section>
                <section className="card card-pad">
                  <h2 className="card-title" style={{ marginBottom: 12 }}>New tenants</h2>
                  <BarChart label="Tenants created per day, last 14 days (UTC)" valueLabel="New tenants" data={d.series.map((s) => ({ label: s.day.slice(5), value: s.count }))} />
                </section>
              </div>
            </div>
          );
        }}
      </Gate>
    </Page>
  );
}
