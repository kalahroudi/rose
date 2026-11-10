// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  api, Badge, Button, Callout, CopyChip, DataTable, Drawer, errorMessage, ExternalLink, Field, Flow, FormDrawer, Gate, Input, Page, Select, Time,
  useConfirm, useListState, useToast, type Column, type HelpContent, type PageData, type Tone,
} from "@rose/ui";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useSession } from "../App";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import type { Domain, DomainDetail, DomainStatus, SetupStatus, Tenant } from "../types";

export const domainTone: Record<DomainStatus, Tone> = { active: "ok", pending: "info", failed: "bad" };
const parseDetail = (raw: string | null): DomainDetail => {
  try {
    return raw ? (JSON.parse(raw) as DomainDetail) : {};
  } catch {
    return {};
  }
};

/** Search-as-you-type tenant picker. Loads at most eight matches; never the whole list. */
function TenantPicker({ value, onChange, inputProps }: { value: { id: string; name: string } | null; onChange(t: { id: string; name: string } | null): void; inputProps: object }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const q = useQuery({ queryKey: ["tenants", `picker:${term}`], queryFn: () => api<PageData<Tenant>>(`/api/tenants?pageSize=8&status=active&q=${encodeURIComponent(term)}`), enabled: !value, placeholderData: keepPreviousData });
  if (value) {
    return (
      <div className="row">
        <Badge plain>{value.name}</Badge>
        <button type="button" className="link" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <Input {...inputProps} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a tenant name or address" autoComplete="off" />
      <div className="stack-sm" role="listbox" aria-label="Matching tenants">
        {q.data?.items.map((t) => (
          <button type="button" role="option" aria-selected="false" key={t.id} className="workspace-pick" onClick={() => onChange({ id: t.id, name: t.name })}>
            <span className="grow"><strong>{t.name}</strong> <span className="muted mono">{t.slug}</span></span>
          </button>
        ))}
        {q.data && q.data.items.length === 0 ? <div className="hint">No active tenant matches.</div> : null}
      </div>
    </div>
  );
}

export function AddDomainDrawer({ open, onClose, tenant }: { open: boolean; onClose(): void; tenant: { id: string; name: string } | null | undefined }) {
  const boot = useSession();
  const toast = useToast();
  const invalidate = useInvalidate();
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Add a custom domain"
      subtitle="Verification runs in the background; you can close this and carry on."
      initial={{ tenant: tenant ?? (null as { id: string; name: string } | null), hostname: "" }}
      submitLabel="Add domain"
      validate={(v) => ({ ...(v.tenant ? {} : { tenant: "Choose a tenant." }), ...(v.hostname.includes(".") ? {} : { hostname: "Enter a full domain such as app.customer.com." }) })}
      onSubmit={async (v) => {
        await api(`/api/tenants/${v.tenant!.id}/domains`, { body: { hostname: v.hostname } });
        await invalidate("domain.add");
        toast.success(`Verifying ${v.hostname.toLowerCase()}. You will be notified when it is live.`);
      }}
    >
      {(f) => (
        <>
          <Field label="Tenant" error={f.errors.tenant}>{(p) => <TenantPicker value={f.values.tenant} onChange={(t) => f.set("tenant", t)} inputProps={p} />}</Field>
          <Field label="Domain" hint={`The customer's own domain. Addresses under ${boot.app.baseDomain} are assigned automatically and can not be added here.`} error={f.errors.hostname}>
            {(p) => <Input {...p} {...f.text("hostname")} className="mono" placeholder="app.customer.com" spellCheck={false} autoCapitalize="none" autoComplete="off" />}
          </Field>
          <Callout>After you add it, this page shows the DNS records to send to the customer. The domain goes live by itself once they are in place.</Callout>
        </>
      )}
    </FormDrawer>
  );
}

function DomainDrawer({ domain, onClose }: { domain: Domain | null; onClose(): void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const d = domain;
  const detail = parseDetail(d?.detail ?? null);

  const recheck = async () => {
    setBusy(true);
    try {
      await api(`/api/domains/${encodeURIComponent(d!.hostname)}/recheck`, { method: "POST" });
      await invalidate("domain.recheck");
      toast.success("Checking again. This usually takes under a minute.");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirm.danger({ title: "Remove this domain?", body: <>The tenant will stop being reachable at this domain immediately, and passkeys created on it will stop working.</>, name: d!.hostname, confirmLabel: "Remove domain" });
    if (!ok) return;
    try {
      await api(`/api/domains/${encodeURIComponent(d!.hostname)}`, { method: "DELETE" });
      await invalidate("domain.remove");
      toast.success(`${d!.hostname} removed`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Drawer
      open={!!d}
      onClose={onClose}
      size="lg"
      title={d?.hostname ?? "Domain"}
      subtitle={d ? <Badge tone={domainTone[d.status]} running={d.status === "pending"}>{d.status}</Badge> : null}
      footer={
        <>
          <Button variant="ghost" icon="trash" onClick={() => void remove()}>Remove</Button>
          <span className="grow" />
          {d?.status !== "active" ? <Button icon="refresh" busy={busy} onClick={() => void recheck()}>Check again</Button> : null}
        </>
      }
    >
      {d ? (
        <>
          <figure className="figure">
            <Flow
              title="Domain verification"
              steps={[
                { label: "Added", sub: "by you", tone: "ok" },
                { label: "DNS records", sub: "customer adds them", tone: d.status === "pending" ? "on" : d.status === "active" ? "ok" : "bad" },
                { label: "Certificate", sub: "issued by Cloudflare", tone: d.status === "active" ? "ok" : undefined },
                { label: "Live", sub: "serving the tenant", tone: d.status === "active" ? "ok" : undefined },
              ]}
            />
            <figcaption>{d.status === "active" ? "This domain is live." : d.status === "pending" ? "Waiting for the customer's DNS. This is checked every 30 seconds." : "Verification stopped. Fix the problem below, then check again."}</figcaption>
          </figure>
          <dl className="dl">
            <dt>Tenant</dt>
            <dd>{d.tenant_name} <span className="muted mono">{d.tenant_slug}</span></dd>
            <dt>Domain</dt>
            <dd className="row-wrap"><CopyChip value={d.hostname} /><ExternalLink href={`https://${d.hostname}`}>Open</ExternalLink></dd>
            <dt>Last checked</dt>
            <dd><Time at={d.updated_at} /></dd>
          </dl>
          {detail.errors?.length ? <Callout tone="bad">{detail.errors.join(" ")}</Callout> : null}
          {detail.note ? <Callout tone="warn">{detail.note}</Callout> : null}
          {detail.records?.length ? (
            <section className="card">
              <div className="card-head"><h3 className="card-title">DNS records to send to the customer</h3></div>
              <table className="table">
                <thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
                <tbody>
                  {detail.records.map((r) => (
                    <tr key={`${r.type}:${r.name}`}>
                      <td><Badge plain>{r.type}</Badge></td>
                      <td><CopyChip value={r.name} /></td>
                      <td><CopyChip value={r.value} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : d.status === "pending" ? (
            <p className="muted">The DNS records appear here a few seconds after the domain is registered with Cloudflare.</p>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

export function DomainsPage() {
  const list = useListState(["status"]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["domains", list.query], queryFn: () => api<PageData<Domain>>(`/api/domains?${list.query}`), placeholderData: keepPreviousData });
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api<SetupStatus>("/api/setup"), staleTime: 60_000 });
  const boot = useSession();

  const help: HelpContent = {
    what: "Customer-owned domains that serve a tenant, such as app.customer.com. You add the domain, the customer adds DNS records, and Cloudflare issues the certificate. Every tenant also has a default address that needs none of this.",
    diagram: {
      node: <Flow title="Custom domain" steps={[{ label: "You add it", sub: "here" }, { label: "Customer", sub: "adds DNS records", via: "send" }, { label: "Cloudflare", sub: "verifies, issues cert", via: "auto" }, { label: "Live", sub: "routes to tenant", tone: "ok" }]} />,
      caption: "Only the second step needs a person outside your team. Everything else is automatic.",
    },
    terms: terms("customDomain", "dnsRecord", "certificate", "tenant", "job"),
    why: [
      { q: "Why does the customer have to add DNS records?", a: "It is the proof that they own the domain. Without it, anyone could point someone else's domain at their own tenant. Cloudflare will not issue a certificate until the records are present." },
      { q: "Why is a domain linked to exactly one tenant?", a: "The domain in the address bar is what decides which tenant a request belongs to. If a domain could belong to two tenants, that decision would be ambiguous, so the database refuses it." },
      { q: "Why do passkeys stop working if a domain is removed?", a: "A passkey is bound by the browser to the exact domain it was created on. People can still sign in at the default address with an email code and add a new passkey." },
    ],
    tasks: [
      { label: "Add a custom domain", run: () => setAdding(true) },
      { label: "See which DNS records to send", detail: "Click a pending domain." },
    ],
    links: [{ label: "Cloudflare for SaaS: custom hostnames", href: "https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/" }],
  };

  const columns: Column<Domain>[] = [
    { id: "hostname", header: "Domain", cell: (d) => <CopyChip value={d.hostname} /> },
    { id: "tenant", header: "Tenant", cell: (d) => (<span>{d.tenant_name} <span className="muted mono">{d.tenant_slug}</span></span>) },
    { id: "status", header: "Status", width: "130px", help: "Pending: waiting for DNS. Active: live. Failed: verification stopped and needs you.", cell: (d) => <Badge tone={domainTone[d.status]} running={d.status === "pending"}>{d.status}</Badge> },
    { id: "updated", header: "Last checked", width: "150px", cell: (d) => <Time at={d.updated_at} /> },
  ];
  const current = q.data?.items.find((d) => d.hostname === open) ?? null;

  return (
    <Page title="Domains" description="Customer-owned domains, with certificates handled for you" help={help} actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add domain</Button>}>
      <Gate queries={[q, setup]}>
        {() => (
          <div className="stack">
            {!setup.data!.cloudflare.connected ? (
              <Callout tone="warn">
                Cloudflare is not connected, so {boot.dev ? "domains are activated without verification in development and would fail in production" : "new domains can not be verified"}. <Link href="/setup?tab=connections" className="link">Connect Cloudflare</Link>
              </Callout>
            ) : null}
            <DataTable
              list={list}
              data={q.data}
              fetching={q.isFetching}
              columns={columns}
              rowKey={(d) => d.hostname}
              onRowClick={(d) => setOpen(d.hostname)}
              noun={["domain", "domains"]}
              searchPlaceholder="Search by domain or tenant"
              filters={
                <Select aria-label="Status" value={list.filters.status} onChange={(e) => list.set({ filters: { status: e.target.value } })}>
                  <option value="">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="active">Active</option>
                  <option value="failed">Failed</option>
                </Select>
              }
              empty={{ icon: "globe", title: "No custom domains", body: "Tenants are reachable at their default address. Add a domain when a customer wants to use their own.", action: <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add domain</Button> }}
            />
          </div>
        )}
      </Gate>
      <AddDomainDrawer open={adding} onClose={() => setAdding(false)} tenant={null} />
      <DomainDrawer domain={current} onClose={() => setOpen(null)} />
    </Page>
  );
}
