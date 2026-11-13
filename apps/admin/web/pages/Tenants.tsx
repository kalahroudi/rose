// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  api, Badge, Button, Callout, CopyChip, DataTable, Drawer, errorMessage, ExternalLink, Field, Flow, FormDrawer, Gate, Input, Page, Select, Time,
  useConfirm, useListState, useToast, type Column, type HelpContent, type PageData, type Selection, type Tone,
} from "@rose/ui";
import { useState } from "react";
import { tenantUrl, useSession } from "../App";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import type { Domain, Member, Tenant, TenantStatus } from "../types";
import { AddDomainDrawer, domainTone } from "./Domains";

export const statusTone: Record<TenantStatus, Tone> = { active: "ok", suspended: "warn", deleting: "bad" };
export const statusLabel: Record<TenantStatus, string> = { active: "Active", suspended: "Suspended", deleting: "Deleting" };

function TenantDetail({ id, onClose }: { id: string | null; onClose(): void }) {
  const boot = useSession();
  const confirm = useConfirm();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const [addingDomain, setAddingDomain] = useState(false);
  const tenant = useQuery({ queryKey: ["tenant", id], queryFn: () => api<Tenant>(`/api/tenants/${id}`), enabled: !!id });
  const members = useQuery({ queryKey: ["tenant-members", id], queryFn: () => api<PageData<Member>>(`/api/tenants/${id}/members?pageSize=10`), enabled: !!id });
  const domains = useQuery({ queryKey: ["domains", `tenantId=${id}`], queryFn: () => api<PageData<Domain>>(`/api/domains?tenantId=${id}&pageSize=10`), enabled: !!id });
  const t = tenant.data;

  const setStatus = async (action: "suspend" | "resume") => {
    if (!t) return;
    const ok = await confirm(
      action === "suspend"
        ? { title: `Suspend ${t.name}?`, body: "Nobody in this tenant will be able to sign in or use its API until you resume it. No data is deleted.", confirmLabel: "Suspend tenant", tone: "danger" }
        : { title: `Resume ${t.name}?`, body: "People in this tenant will be able to sign in again.", confirmLabel: "Resume tenant" },
    );
    if (!ok) return;
    try {
      await api("/api/tenants/bulk", { body: { action, ids: [t.id] } });
      await invalidate("tenant.status");
      toast.success(action === "suspend" ? `${t.name} suspended` : `${t.name} resumed`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    if (!t) return;
    const ok = await confirm.danger({
      title: "Delete this tenant?",
      body: <>This permanently destroys <strong>{t.name}</strong>: its private database, its encryption key, members and domains. It can not be undone.</>,
      name: t.slug,
      confirmLabel: "Delete tenant",
    });
    if (!ok) return;
    try {
      await api(`/api/tenants/${t.id}/delete`, { body: { confirm: t.slug } });
      await invalidate("tenant.delete");
      toast.success(`Deleting ${t.name}. You will be notified when it is done.`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Drawer
        open={!!id && !editing && !addingDomain}
        onClose={onClose}
        size="lg"
        title={t?.name ?? "Tenant"}
        subtitle={t ? <Badge tone={statusTone[t.status]}>{statusLabel[t.status]}</Badge> : null}
        footer={
          t && t.status !== "deleting" ? (
            <>
              <Button variant="ghost" icon="trash" onClick={() => void remove()}>Delete</Button>
              <span className="grow" />
              {t.status === "active" ? <Button icon="pause" onClick={() => void setStatus("suspend")}>Suspend</Button> : <Button icon="play" onClick={() => void setStatus("resume")}>Resume</Button>}
              <Button icon="edit" onClick={() => setEditing(true)}>Edit</Button>
            </>
          ) : undefined
        }
      >
        <Gate queries={[tenant, members, domains]} skeleton="detail">
          {() => {
            const url = tenantUrl(boot, t!.slug);
            return (
              <>
                {t!.status === "deleting" ? <Callout tone="warn">This tenant is being deleted. Its sessions are already cut; the remaining data is destroyed by a background task.</Callout> : null}
                <dl className="dl">
                  <dt>Address</dt>
                  <dd className="row-wrap"><CopyChip value={url} display={url.replace(/^https?:\/\//, "")} /><ExternalLink href={url}>Open</ExternalLink></dd>
                  <dt>Tenant ID</dt>
                  <dd><CopyChip value={t!.id} /></dd>
                  <dt>Plan</dt>
                  <dd>{t!.plan}</dd>
                  <dt>Created</dt>
                  <dd><Time at={t!.created_at} /></dd>
                </dl>

                <section className="card">
                  <div className="card-head">
                    <h3 className="card-title grow">Members <span className="muted">({members.data!.total})</span></h3>
                  </div>
                  {members.data!.items.length === 0 ? (
                    <div className="card-pad muted">Nobody has signed in yet. The invited owner joins the first time they sign in at the tenant address.</div>
                  ) : (
                    <table className="table">
                      <tbody>
                        {members.data!.items.map((m) => (
                          <tr key={m.user_id}>
                            <td>{m.email}{m.name ? <span className="muted"> · {m.name}</span> : null}</td>
                            <td><Badge plain>{m.role}</Badge></td>
                            <td className="col-actions muted">Last seen <Time at={m.last_login_at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {members.data!.total > members.data!.items.length ? <div className="table-foot">Showing the first {members.data!.items.length}. The tenant's owners manage the full list in their workspace.</div> : null}
                </section>

                <section className="card">
                  <div className="card-head">
                    <h3 className="card-title grow">Custom domains <span className="muted">({domains.data!.total})</span></h3>
                    {t!.status !== "deleting" ? <Button size="sm" icon="plus" onClick={() => setAddingDomain(true)}>Add domain</Button> : null}
                  </div>
                  {domains.data!.items.length === 0 ? (
                    <div className="card-pad muted">None. This tenant is reachable at its default address only.</div>
                  ) : (
                    <table className="table">
                      <tbody>
                        {domains.data!.items.map((d) => (
                          <tr key={d.hostname}>
                            <td><CopyChip value={d.hostname} /></td>
                            <td className="col-actions"><Badge tone={domainTone[d.status]} running={d.status === "pending"}>{d.status}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            );
          }}
        </Gate>
      </Drawer>

      <FormDrawer
        open={editing && !!t}
        onClose={() => setEditing(false)}
        title="Edit tenant"
        subtitle="The address can not be changed: sign-in cookies and passkeys are tied to it."
        initial={{ name: t?.name ?? "", plan: t?.plan ?? "free" }}
        submitLabel="Save changes"
        onSubmit={async (v) => {
          await api(`/api/tenants/${t!.id}`, { method: "PATCH", body: v });
          await invalidate("tenant.update");
          toast.success("Tenant updated");
        }}
      >
        {(f) => (
          <>
            <Field label="Name" error={f.errors.name}>{(p) => <Input {...p} {...f.text("name")} maxLength={80} />}</Field>
            <Field label="Plan" hint="A free-form label for your own billing or feature rules." error={f.errors.plan}>{(p) => <Input {...p} {...f.text("plan")} maxLength={30} />}</Field>
          </>
        )}
      </FormDrawer>

      <AddDomainDrawer open={addingDomain} onClose={() => setAddingDomain(false)} tenant={t ? { id: t.id, name: t.name } : null} />
    </>
  );
}

export function TenantsPage() {
  const boot = useSession();
  const list = useListState(["status"]);
  const confirm = useConfirm();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["tenants", list.query], queryFn: () => api<PageData<Tenant>>(`/api/tenants?${list.query}`), placeholderData: keepPreviousData });

  const help: HelpContent = {
    what: "Everyone you serve. Customers create their own workspace by signing up at your app's main address. Open a tenant to see its members and domains, or suspend and delete tenants.",
    diagram: {
      node: <Flow title="Tenant lifecycle" steps={[{ label: "Active", sub: "people can sign in", tone: "ok" }, { label: "Suspended", sub: "access paused", via: "suspend" }, { label: "Deleting", sub: "sessions cut", via: "delete", tone: "bad" }, { label: "Gone", sub: "data and key destroyed", via: "task" }]} />,
      caption: "Suspending is reversible. Deleting is not: the private database and its encryption key are destroyed.",
    },
    terms: terms("tenant", "address", "owner", "suspended", "deleting", "privateDatabase"),
    why: [
      { q: "Why can I not create a tenant for a customer?", a: "Tenants are created only by self-serve sign-up. The person who signs up proves they control their mailbox and becomes the owner, so no operator ever chooses who owns a workspace." },
      { q: "Why can the address not be changed?", a: "Browsers scope sign-in cookies and passkeys to the exact host name. Keeping the address fixed is what stops one tenant's session from ever being valid on another tenant's site." },
      { q: "Why must I type the name to delete?", a: "Deletion destroys the tenant's database and encryption key, so there is no undo and no backup to restore from. Typing the name makes an accidental click impossible." },
    ],
    tasks: [
      { label: "Suspend several tenants at once", detail: "Tick rows, or tick the header and choose “Select all matching”, then Suspend." },
      { label: "Give a tenant its own domain", detail: "Open the tenant, then Add domain." },
    ],
  };

  const bulk = async (sel: Selection, action: "suspend" | "resume") => {
    const n = sel.count;
    const ok = await confirm({
      title: `${action === "suspend" ? "Suspend" : "Resume"} ${n} ${n === 1 ? "tenant" : "tenants"}?`,
      body: action === "suspend" ? "People in these tenants will not be able to sign in until you resume them. No data is deleted." : "People in these tenants will be able to sign in again.",
      confirmLabel: `${action === "suspend" ? "Suspend" : "Resume"} ${n} ${n === 1 ? "tenant" : "tenants"}`,
      tone: action === "suspend" ? "danger" : "primary",
    });
    if (!ok) return;
    try {
      const body = sel.allMatching ? { action, filter: { q: list.q, status: list.filters.status } } : { action, ids: sel.ids };
      const r = await api<{ affected: number }>("/api/tenants/bulk", { body });
      await invalidate("tenant.status");
      sel.clear();
      toast.success(`${r.affected} ${r.affected === 1 ? "tenant" : "tenants"} ${action === "suspend" ? "suspended" : "resumed"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const columns: Column<Tenant>[] = [
    { id: "name", header: "Tenant", sort: "name", cell: (t) => (<div><strong>{t.name}</strong><div className="hint mono">{t.slug}.{boot.app.baseDomain}</div></div>) },
    { id: "status", header: "Status", sort: "status", width: "130px", cell: (t) => <Badge tone={statusTone[t.status]} running={t.status === "deleting"}>{statusLabel[t.status]}</Badge> },
    { id: "plan", header: "Plan", width: "110px", cell: (t) => t.plan },
    { id: "members", header: "Members", width: "100px", help: "People who have joined this tenant. Pending invitations are not counted.", cell: (t) => t.members },
    { id: "domains", header: "Domains", width: "100px", help: "Custom domains connected to this tenant, in any state.", cell: (t) => t.domains },
    { id: "created", header: "Created", sort: "created", width: "140px", cell: (t) => <Time at={t.created_at} /> },
  ];

  return (
    <Page title="Tenants" description="Your customers, each in its own isolated workspace" help={help}>
      <Gate queries={[q]}>
        {() => (
          <DataTable
            list={list}
            data={q.data}
            fetching={q.isFetching}
            columns={columns}
            rowKey={(t) => t.id}
            onRowClick={(t) => setOpenId(t.id)}
            noun={["tenant", "tenants"]}
            searchPlaceholder="Search by name or address"
            filters={
              <Select aria-label="Status" value={list.filters.status} onChange={(e) => list.set({ filters: { status: e.target.value } })}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="deleting">Deleting</option>
              </Select>
            }
            bulkActions={(sel) => (
              <>
                <Button size="sm" icon="pause" onClick={() => void bulk(sel, "suspend")}>Suspend</Button>
                <Button size="sm" icon="play" onClick={() => void bulk(sel, "resume")}>Resume</Button>
              </>
            )}
            rowActions={(t) => <ExternalLink href={tenantUrl(boot, t.slug)}>Open</ExternalLink>}
            empty={{ icon: "building", title: "No tenants yet", body: "Customers create their own workspace by signing up at your app's main address." }}
          />
        )}
      </Gate>

      <TenantDetail id={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}
