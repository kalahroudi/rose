// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, CodeBlock, CopyChip, DataTable, Drawer, Gate, Page, Select, Time, useListState, type Column, type HelpContent, type PageData } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";
import type { AuditEntry } from "../types";

const help: HelpContent = {
  what: "A permanent record of what operators did in this console: sign-ins, tenants created or deleted, domains and connections changed. Use it to answer “who did this, and when?”.",
  terms: terms("auditLog", "operator", "tenant"),
  why: [
    { q: "Why can entries not be edited or deleted?", a: "An audit trail is only useful if it can be trusted after an incident. The console has no way to change it." },
    { q: "Where is what tenants did?", a: "In each tenant's own audit log, stored inside its private database and visible to its admins. It is deliberately not readable from here." },
  ],
};

const pretty = (meta: string | null) => {
  try {
    return meta ? JSON.stringify(JSON.parse(meta), null, 2) : "";
  } catch {
    return meta ?? "";
  }
};

export function AuditPage() {
  const list = useListState(["action"]);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const q = useQuery({ queryKey: ["audit", list.query], queryFn: () => api<PageData<AuditEntry>>(`/api/audit?${list.query}`), placeholderData: keepPreviousData });

  const columns: Column<AuditEntry>[] = [
    { id: "at", header: "When", width: "150px", cell: (e) => <Time at={e.at} /> },
    { id: "actor", header: "Who", cell: (e) => e.actor },
    { id: "action", header: "Action", cell: (e) => <code>{e.action}</code> },
    { id: "target", header: "Target", cell: (e) => (e.target ? <CopyChip value={e.target} /> : <span className="muted">—</span>) },
  ];

  return (
    <Page title="Audit log" description="Who did what in this console" help={help}>
      <Gate queries={[q]}>
        {() => (
          <DataTable
            list={list}
            data={q.data}
            fetching={q.isFetching}
            columns={columns}
            rowKey={(e) => e.id}
            onRowClick={(e) => setOpen(e)}
            noun={["entry", "entries"]}
            searchPlaceholder="Search by person, action or target"
            filters={
              <Select aria-label="Kind of action" value={list.filters.action} onChange={(e) => list.set({ filters: { action: e.target.value } })}>
                <option value="">All actions</option>
                <option value="auth.">Sign-ins</option>
                <option value="tenant.">Tenants</option>
                <option value="domain.">Domains</option>
                <option value="operator.">Operators</option>
                <option value="setup.">Connections</option>
                <option value="job.">Tasks</option>
              </Select>
            }
            empty={{ icon: "list", title: "Nothing recorded yet", body: "Actions taken in this console appear here." }}
          />
        )}
      </Gate>
      <Drawer open={!!open} onClose={() => setOpen(null)} title="Audit entry" subtitle={open ? <code>{open.action}</code> : null}>
        {open ? (
          <>
            <dl className="dl">
              <dt>When</dt>
              <dd>{new Date(open.at).toLocaleString()}</dd>
              <dt>Who</dt>
              <dd>{open.actor}</dd>
              <dt>Target</dt>
              <dd>{open.target ? <CopyChip value={open.target} /> : "—"}</dd>
              <dt>IP address</dt>
              <dd>{open.ip ?? "—"}</dd>
              <dt>Entry ID</dt>
              <dd><CopyChip value={open.id} /></dd>
            </dl>
            {open.meta ? <CodeBlock>{pretty(open.meta)}</CodeBlock> : null}
          </>
        ) : null}
      </Drawer>
    </Page>
  );
}
