// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, CodeBlock, CopyChip, DataTable, Drawer, Gate, Page, Select, Time, useListState, type Column, type HelpContent, type PageData } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";
import type { AuditEntry } from "../types";

const help: HelpContent = {
  what: "A record of every change in this workspace: who did it (a member or an API key), what they did, and when. Entries can not be edited or removed from the app.",
  terms: [...terms("auditLog", "apiKey"), { term: "Actor", def: "Who performed the action: a member's email address, key:<name> for an API key, or job:<who queued it> for background work." }, { term: "Action", def: "What happened, written as area.verb, for example member.remove or contacts.create." }],
  why: [
    { q: "Why is the audit log stored inside the workspace?", a: "It is your data. Keeping it in the workspace's private database means no other workspace can see it, and it is destroyed together with the workspace." },
    { q: "Why can only owners and admins read it?", a: "It shows every member's activity and sign-ins, which is more than a regular member needs to do their work." },
  ],
  tasks: [
    { label: "See who signed in", detail: "Choose Sign-ins in the action filter." },
    { label: "Find everything one person did", detail: "Search for their email address." },
  ],
};

const prettyMeta = (meta: string | null): string => {
  if (!meta) return "{}";
  try {
    return JSON.stringify(JSON.parse(meta), null, 2);
  } catch {
    return meta;
  }
};

const columns: Column<AuditEntry>[] = [
  { id: "at", header: "When", width: "150px", cell: (e) => <Time at={e.at} /> },
  { id: "actor", header: "Actor", help: "A member's email, key:<name> for an API key, or job:<who> for background work.", cell: (e) => e.actor },
  { id: "action", header: "Action", cell: (e) => <span className="mono">{e.action}</span> },
  { id: "target", header: "Target", help: "The record the action was applied to, when there is one.", cell: (e) => (e.target ? <CopyChip value={e.target} /> : <span className="muted">None</span>) },
];

export function AuditPage() {
  const list = useListState(["action"]);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const audit = useQuery({ queryKey: ["audit", list.query], queryFn: () => api<PageData<AuditEntry>>(`/api/audit?${list.query}`), placeholderData: keepPreviousData });
  return (
    <Page title="Audit log" description="Who did what, and when" help={help}>
      <Gate queries={[audit]}>
        {() => (
          <DataTable<AuditEntry>
            list={list}
            data={audit.data}
            fetching={audit.isFetching}
            columns={columns}
            rowKey={(e) => e.id}
            onRowClick={(e) => setOpen(e)}
            noun={["entry", "entries"]}
            searchPlaceholder="Search actor, action or target"
            filters={
              <Select aria-label="Action type" value={list.filters.action} onChange={(e) => list.set({ filters: { action: e.target.value } })}>
                <option value="">All actions</option>
                <option value="auth.">Sign-ins and passkeys</option>
                <option value="member.">Members</option>
                <option value="invitation.">Invitations</option>
                <option value="apikey.">API keys</option>
                <option value="workspace.">Workspace settings</option>
                <option value="contacts.">Contacts</option>
              </Select>
            }
            empty={{ icon: "list", title: "Nothing recorded yet", body: "Sign-ins and changes made by members and API keys appear here." }}
          />
        )}
      </Gate>
      <Drawer open={!!open} onClose={() => setOpen(null)} title="Audit entry" subtitle={open ? <span className="mono">{open.action}</span> : null}>
        {open ? (
          <>
            <dl className="dl">
              <dt>When</dt>
              <dd>{new Date(open.at).toLocaleString()}</dd>
              <dt>Actor</dt>
              <dd className="row-wrap">{open.actor}</dd>
              <dt>Action</dt>
              <dd className="mono">{open.action}</dd>
              <dt>Target</dt>
              <dd>{open.target ? <CopyChip value={open.target} /> : <span className="muted">None</span>}</dd>
              <dt>IP address</dt>
              <dd>{open.ip ? <CopyChip value={open.ip} /> : <span className="muted">Not recorded</span>}</dd>
              <dt>Entry ID</dt>
              <dd><CopyChip value={open.id} /></dd>
            </dl>
            <div className="stack-sm">
              <div className="label">Details</div>
              <CodeBlock>{prettyMeta(open.meta)}</CodeBlock>
            </div>
          </>
        ) : null}
      </Drawer>
    </Page>
  );
}
