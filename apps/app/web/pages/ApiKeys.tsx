// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Advanced, api, Badge, Button, Callout, CodeBlock, CopyChip, DataTable, Drawer, errorMessage, Field, Flow, FormDrawer, Gate, Input, Page, Select, Time, useConfirm, useListState, useToast, type Column, type HelpContent, type PageData } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import { roleLabel, useWorkspace } from "../session";
import type { ApiKey } from "../types";

interface NewKey {
  key: string;
  item: ApiKey;
}

export function ApiKeysPage() {
  const { boot, session } = useWorkspace();
  const list = useListState();
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).has("new"));
  const [created, setCreated] = useState<NewKey | null>(null);
  const keys = useQuery({ queryKey: ["api-keys", list.query], queryFn: () => api<PageData<ApiKey>>(`/api/api-keys?${list.query}`), placeholderData: keepPreviousData });
  const examplePath = boot.modules.includes("contacts") ? "/api/m/contacts" : "/api/overview";

  const revoke = async (k: ApiKey) => {
    const ok = await confirm.danger({
      title: "Revoke this API key?",
      body: "Anything using this key stops working immediately. A revoked key can not be restored; you would have to create a new one and update whatever uses it.",
      name: k.name,
      confirmLabel: "Revoke key",
    });
    if (!ok) return;
    try {
      await api(`/api/api-keys/${k.id}`, { method: "DELETE" });
      await invalidate("apikey.revoke");
      toast.success(`Key "${k.name}" revoked.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const help: HelpContent = {
    what: "Keys that let scripts, services and AI agents call this workspace's API without a person signing in.",
    diagram: {
      node: <Flow title="How an API key is checked" steps={[{ label: "Agent", sub: "Bearer rose_…" }, { label: "Address", sub: "picks the workspace", via: "host" }, { label: "Key lookup", sub: "in this workspace only", tone: "on" }, { label: "Role check", sub: "member or admin" }]} />,
      caption: "The key is looked up inside the workspace named by the address. Presented anywhere else, it simply does not exist.",
    },
    terms: terms("apiKey", "role", "auditLog"),
    why: [
      { q: "Why is the key shown only once?", a: "Only a one-way hash of the key is stored, so nobody, including the platform, can read it back later. If you lose it, revoke it and create a new one." },
      { q: "Why can't a key be an owner?", a: "Owner actions, such as deleting the workspace, must be done by an accountable person. A key acts as a member or an admin and nothing more." },
      { q: "Why does a key only work at this address?", a: "Keys live inside the workspace's private database. Another workspace has no record of it, so it can never be used to reach someone else's data." },
    ],
    tasks: [
      { label: "Create a key for an agent", run: () => setCreating(true), detail: "Give it the lowest role that does the job, and an expiry if it is temporary." },
      { label: "Rotate a key", detail: "Create a new key, switch the service to it, then revoke the old one." },
    ],
  };

  const columns: Column<ApiKey>[] = [
    { id: "name", header: "Name", cell: (k) => <strong>{k.name}</strong> },
    { id: "id", header: "Key ID", help: "Identifies the key in the audit log. It is not the secret.", cell: (k) => <CopyChip value={k.id} /> },
    { id: "role", header: "Acts as", cell: (k) => <Badge plain>{roleLabel(k.role)}</Badge> },
    { id: "by", header: "Created by", cell: (k) => k.created_by ?? <span className="muted">Unknown</span> },
    { id: "used", header: "Last used", cell: (k) => <Time at={k.last_used_at} /> },
    { id: "expires", header: "Expires", cell: (k) => (k.expires_at ? (k.expires_at < Date.now() ? <Badge tone="bad">Expired</Badge> : <Time at={k.expires_at} />) : <span className="muted">Never</span>) },
  ];

  const curl = created ? `curl ${window.location.origin}${examplePath} \\\n  -H "Authorization: Bearer ${created.key}"` : "";

  return (
    <Page title="API keys" description="Access for scripts, services and AI agents" help={help} actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create key</Button>}>
      <Gate queries={[keys]}>
        {() => (
          <DataTable
            list={list}
            data={keys.data}
            fetching={keys.isFetching}
            columns={columns}
            rowKey={(k) => k.id}
            freshKey={created?.item.id}
            noun={["key", "keys"]}
            searchPlaceholder="Search by name"
            rowActions={(k) => <Button size="sm" variant="ghost" icon="trash" onClick={() => void revoke(k)}>Revoke</Button>}
            empty={{ icon: "key", title: "No API keys", body: "Create a key to let a script, service or AI agent work with this workspace.", action: <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create key</Button> }}
          />
        )}
      </Gate>

      <FormDrawer
        open={creating}
        onClose={() => setCreating(false)}
        title="Create API key"
        subtitle="The key works for this workspace only."
        initial={{ name: "", role: "member" as "member" | "admin", expiry: "" }}
        submitLabel="Create key"
        validate={(v) => (v.name.trim() ? {} : { name: "Give the key a name." })}
        onSubmit={async (v) => {
          const res = await api<NewKey>("/api/api-keys", { body: { name: v.name, role: v.role, expiresInDays: v.expiry ? Number(v.expiry) : null } });
          await invalidate("apikey.create");
          setCreated(res);
        }}
      >
        {(f) => (
          <>
            <Field label="Name" error={f.errors.name} hint="Say what will use it, for example “Nightly sync” or “Support agent”. It appears in the audit log.">
              {(p) => <Input {...p} maxLength={80} placeholder="Support agent" {...f.text("name")} />}
            </Field>
            <Field label="Acts as" error={f.errors.role} help="The key can do what a person with this role can do, except create other keys." hint="Choose the lowest role that does the job.">
              {(p) => (
                <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value as "member" | "admin")}>
                  <option value="member">Member: read and edit data</option>
                  {session.role !== "member" ? <option value="admin">Admin: also manage members and settings</option> : null}
                </Select>
              )}
            </Field>
            <Advanced id="apikey" changed={f.values.expiry ? 1 : 0}>
              <Field label="Expires" hint="An expired key stops working on its own. Use this for temporary access.">
                {(p) => (
                  <Select {...p} value={f.values.expiry} onChange={(e) => f.set("expiry", e.target.value)}>
                    <option value="">Never</option>
                    <option value="30">In 30 days</option>
                    <option value="90">In 90 days</option>
                    <option value="365">In 1 year</option>
                  </Select>
                )}
              </Field>
            </Advanced>
          </>
        )}
      </FormDrawer>

      <Drawer
        open={!!created}
        onClose={() => setCreated(null)}
        size="lg"
        title="Copy your new key"
        subtitle={created ? `“${created.item.name}” acts as ${roleLabel(created.item.role).toLowerCase()}` : null}
        footer={<Button variant="primary" onClick={() => setCreated(null)}>I have copied it</Button>}
      >
        {created ? (
          <>
            <Callout tone="warn">This is the only time the key is shown. Only a hash is stored, so it can not be displayed again. Keep it in a secret manager, never in source code.</Callout>
            <div className="stack-sm">
              <div className="label">API key</div>
              <CodeBlock>{created.key}</CodeBlock>
            </div>
            <div className="stack-sm">
              <div className="label">Try it</div>
              <CodeBlock>{curl}</CodeBlock>
              <div className="hint">Send the key in the Authorization header. It works only at <span className="mono">{window.location.host}</span>.</div>
            </div>
          </>
        ) : null}
      </Drawer>
    </Page>
  );
}
