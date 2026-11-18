// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { addPasskey, api, Button, Callout, CopyChip, errorMessage, Flow, Gate, Icon, Kpi, Page, Time, useToast, type HelpContent, type IconName } from "@rose/ui";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import { roleLabel, useWorkspace } from "../session";
import type { Overview } from "../types";

interface ContactStats {
  lead: number;
  active: number;
  archived: number;
  total: number;
}

function Step({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="attention">
      <div className="empty-icon" style={{ margin: 0 }}><Icon name={icon} /></div>
      <div className="grow">
        <strong>{title}</strong>
        <div className="hint">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function OverviewPage() {
  const { boot, tenant, session, can } = useWorkspace();
  const [, navigate] = useLocation();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [addingPasskey, setAddingPasskey] = useState(false);
  const hasContacts = boot.modules.includes("contacts") && can("contacts:read");

  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/overview") });
  const stats = useQuery({ queryKey: ["contacts", "stats"], queryFn: () => api<ContactStats>("/api/m/contacts/stats"), enabled: hasContacts });

  const createPasskey = async () => {
    setAddingPasskey(true);
    try {
      await addPasskey("/api/auth");
      await invalidate("passkey.add");
      toast.success("Passkey added. Use it next time you sign in.");
    } catch (err) {
      if (!(err instanceof Error && err.name === "NotAllowedError")) toast.error(errorMessage(err));
    } finally {
      setAddingPasskey(false);
    }
  };

  const help: HelpContent = {
    what: `A summary of the ${tenant.name} workspace: how many people and API keys have access, what needs your attention, and what changed recently.`,
    diagram: {
      node: <Flow title="How a request reaches your data" steps={[{ label: "Your browser", sub: window.location.hostname }, { label: "Address", sub: "picks the workspace", via: "host" }, { label: "Session", sub: "member + role", tone: "on" }, { label: "Private DB", sub: "this workspace only" }]} />,
      caption: "The address you visit decides the workspace. Your session is valid for this address only, and the data lives in a database no other workspace can reach.",
    },
    terms: terms("workspace", "address", "member", "role", "passkey", "apiKey"),
    why: [
      { q: "Why does each workspace have its own address?", a: "Browsers isolate cookies and passkeys per address. Giving every workspace its own means a session or passkey from one can not be replayed against another, even by mistake." },
      { q: "Why am I asked to add a passkey?", a: "Email codes work everywhere but depend on your mailbox and can be phished. A passkey is bound to this address and your device, so it is both faster and safer." },
    ],
    tasks: [
      { label: "Invite a teammate", detail: "They join by signing in with the invited email address.", run: can("members:manage") ? () => navigate("/members?tab=invitations&new=1") : undefined },
      { label: "Create an API key for an agent or service", run: can("apikeys:manage") ? () => navigate("/api-keys?new=1") : undefined },
    ],
    links: [{ label: "What is a passkey? (passkeys.dev)", href: "https://passkeys.dev/docs/intro/what-are-passkeys/" }],
  };

  return (
    <Page title="Overview" description={`${tenant.name} at a glance`} help={help}>
      <Gate queries={hasContacts ? [overview, stats] : [overview]} skeleton="cards">
        {() => {
          const o = overview.data!;
          const steps: ReactNode[] = [];
          if (!session.hasPasskey) {
            steps.push(
              <Step key="passkey" icon="fingerprint" title="Add a passkey" action={<Button variant="primary" size="sm" busy={addingPasskey} onClick={() => void createPasskey()}>Add passkey</Button>}>
                You signed in with an email code. A passkey signs you in with your fingerprint, face or PIN and can not be phished.
              </Step>,
            );
          }
          if (can("members:manage") && o.members <= 1 && o.invitations === 0) {
            steps.push(
              <Step key="invite" icon="users" title="Invite your team" action={<Link href="/members?tab=invitations&new=1" className="btn btn-sm">Invite member</Link>}>
                You are the only member. Invite people by email; they join by signing in with that address.
              </Step>,
            );
          }
          if (can("apikeys:manage") && o.apiKeys === 0) {
            steps.push(
              <Step key="key" icon="bot" title="Create an API key for your agents" action={<Link href="/api-keys?new=1" className="btn btn-sm">Create key</Link>}>
                Scripts, services and AI agents call this workspace with a key that works here and nowhere else.
              </Step>,
            );
          }
          return (
            <div className="stack">
              <div className="grid">
                <Kpi label="Members" value={o.members} help="People who can sign in to this workspace right now." sub={<Link href="/members" className="link">Manage members</Link>} />
                <Kpi label="Pending invitations" value={o.invitations} help="Email addresses that have been invited but have not signed in yet. Invitations expire after 7 days." sub={o.invitations > 0 ? <Link href="/members?tab=invitations" className="link">Review invitations</Link> : "Nobody is waiting to join"} />
                <Kpi label="API keys" value={o.apiKeys} help="Keys that let scripts, services and AI agents call this workspace's API." sub={can("apikeys:manage") ? <Link href="/api-keys" className="link">Manage keys</Link> : "Managed by admins"} />
                {hasContacts ? <Kpi label="Contacts" value={stats.data!.total} help="All contacts in this workspace, including archived ones." sub={`${stats.data!.active} active · ${stats.data!.lead} leads · ${stats.data!.archived} archived`} /> : null}
              </div>

              <div className="grid-wide">
                <section className="card">
                  <div className="card-head"><h2 className="card-title">{steps.length ? "Needs attention" : "You are set up"}</h2></div>
                  {steps.length ? steps : (
                    <div className="card-pad"><Callout tone="ok">Passkey added, team invited, API access configured. Nothing needs your attention.</Callout></div>
                  )}
                </section>

                <section className="card">
                  <div className="card-head"><h2 className="card-title">This workspace</h2></div>
                  <dl className="dl card-pad">
                    <dt>Address</dt>
                    <dd><CopyChip value={window.location.origin} /></dd>
                    <dt>Signed in as</dt>
                    <dd className="truncate">{session.user.email}</dd>
                    <dt>Your role</dt>
                    <dd>{roleLabel(session.role)}</dd>
                    <dt>Signed in with</dt>
                    <dd>{session.method === "passkey" ? "A passkey" : "An email code"}</dd>
                  </dl>
                </section>
              </div>

              {can("audit:read") ? (
                <section className="card">
                  <div className="card-head">
                    <h2 className="card-title grow">Recent activity</h2>
                    <Link href="/audit" className="link">Open audit log</Link>
                  </div>
                  {o.recent.length === 0 ? (
                    <div className="card-pad muted">Nothing has been recorded yet. Changes made by members and API keys appear here.</div>
                  ) : (
                    <table className="table">
                      <tbody>
                        {o.recent.map((e) => (
                          <tr key={e.id}>
                            <td className="mono">{e.action}</td>
                            <td className="truncate">{e.actor}</td>
                            <td className="col-actions muted"><Time at={e.at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              ) : null}
            </div>
          );
        }}
      </Gate>
    </Page>
  );
}
