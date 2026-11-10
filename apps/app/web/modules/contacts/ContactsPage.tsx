// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, Badge, Button, Callout, Copy, DataTable, Drawer, errorMessage, Field, FormDrawer, Gate, IconButton, Input, Page, Select, Skeleton, Textarea, Time, useConfirm, useListState, useTab, useToast, type Column, type PageData, type Selection, type Tone } from "@rose/ui";
import { useState } from "react";
import { useInvalidate } from "../../invalidation";
import { useWorkspace } from "../../session";
import { contactsHelp } from "./help";

type Status = "lead" | "active" | "archived";
interface Contact {
  id: string;
  name: string;
  company: string;
  email: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
}
interface ContactDetail extends Contact {
  notes: string;
}
interface Stats {
  lead: number;
  active: number;
  archived: number;
  total: number;
}
type FormValues = { name: string; company: string; email: string; status: Status; notes: string };

const TABS = ["all", "lead", "active", "archived"] as const;
type TabId = (typeof TABS)[number];
const statusLabel: Record<Status, string> = { lead: "Lead", active: "Active", archived: "Archived" };
const statusTone: Record<Status, Tone> = { lead: "info", active: "ok", archived: "neutral" };
const blank: FormValues = { name: "", company: "", email: "", status: "lead", notes: "" };
const IMPORT_LIMIT = 90_000;

const validate = (v: FormValues) => {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  if (!v.name.trim()) errors.name = "Enter a name.";
  if (v.email && !/^\S+@\S+\.\S+$/.test(v.email.trim())) errors.email = "Enter a valid email address, or leave it empty.";
  return errors;
};

function ContactFields({ f }: { f: Parameters<Parameters<typeof FormDrawer<FormValues>>[0]["children"]>[0] }) {
  return (
    <>
      <Field label="Name" error={f.errors.name}>
        {(p) => <Input {...p} maxLength={120} placeholder="Ada Lovelace" {...f.text("name")} />}
      </Field>
      <Field label="Company" optional error={f.errors.company}>
        {(p) => <Input {...p} maxLength={120} placeholder="Analytical Engines Ltd" {...f.text("company")} />}
      </Field>
      <Field label="Email" optional error={f.errors.email} help="Stored encrypted with this workspace's key. Searchable by full address only." hint="Encrypted before it is stored.">
        {(p) => <Input {...p} type="email" maxLength={254} autoComplete="off" placeholder="ada@example.com" {...f.text("email")} />}
      </Field>
      <Field label="Status" error={f.errors.status}>
        {(p) => (
          <Select {...p} value={f.values.status} onChange={(e) => f.set("status", e.target.value as Status)}>
            <option value="lead">Lead: someone new</option>
            <option value="active">Active: someone you work with</option>
            <option value="archived">Archived: kept for the record</option>
          </Select>
        )}
      </Field>
      <Field label="Notes" optional error={f.errors.notes} hint="Encrypted before it is stored. Notes are not searchable.">
        {(p) => <Textarea {...p} maxLength={4000} rows={5} {...f.text("notes")} />}
      </Field>
    </>
  );
}

export function ContactsPage() {
  const { can } = useWorkspace();
  const canWrite = can("contacts:write");
  const canDelete = can("contacts:delete");
  const [tab, setTab] = useTab<TabId>(TABS);
  const status = tab === "all" ? "" : tab;
  const list = useListState();
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const query = `${list.query}${status ? `&status=${status}` : ""}`;
  const contacts = useQuery({ queryKey: ["contacts", query], queryFn: () => api<PageData<Contact>>(`/api/m/contacts?${query}`), placeholderData: keepPreviousData });
  const stats = useQuery({ queryKey: ["contacts", "stats"], queryFn: () => api<Stats>("/api/m/contacts/stats") });
  const detail = useQuery({ queryKey: ["contacts", editingId], queryFn: () => api<ContactDetail>(`/api/m/contacts/${editingId}`), enabled: !!editingId, staleTime: 0, gcTime: 0 });

  const fail = (err: unknown) => toast.error(errorMessage(err));

  const remove = async (c: Contact) => {
    if (!(await confirm.danger({ title: "Delete this contact?", body: "The contact, its email address and its notes are permanently deleted.", name: c.name, confirmLabel: "Delete contact" }))) return;
    try {
      await api(`/api/m/contacts/${c.id}`, { method: "DELETE" });
      await invalidate("contact.delete");
      toast.success(`${c.name} deleted.`);
    } catch (err) {
      fail(err);
    }
  };

  /** Bulk actions send ids for ticked rows, or the current filter for "select all matching". */
  const bulk = async (action: "archive" | "activate" | "delete", sel: Selection) => {
    const n = sel.count;
    const what = `${n} ${n === 1 ? "contact" : "contacts"}`;
    const ok =
      action === "delete"
        ? await confirm.danger({ title: `Delete ${what}?`, body: "The selected contacts, their email addresses and notes are permanently deleted.", name: `delete ${what}`, confirmLabel: `Delete ${what}` })
        : await confirm({
            title: action === "archive" ? `Archive ${what}?` : `Mark ${what} as active?`,
            body: action === "archive" ? "Archived contacts stay in the workspace and can be made active again." : "They will appear under Active.",
            confirmLabel: action === "archive" ? `Archive ${what}` : `Activate ${what}`,
          });
    if (!ok) return;
    try {
      const target = sel.allMatching ? { filter: { q: list.q, status } } : { ids: sel.ids };
      const { affected } = await api<{ affected: number }>("/api/m/contacts/bulk", { body: { action, ...target } });
      sel.clear();
      await invalidate("contact.bulk");
      toast.success(`${affected} ${affected === 1 ? "contact" : "contacts"} ${action === "delete" ? "deleted" : action === "archive" ? "archived" : "activated"}.`);
    } catch (err) {
      fail(err);
    }
  };

  const columns: Column<Contact>[] = [
    { id: "name", header: "Name", sort: "name", cell: (c) => <strong>{c.name}</strong> },
    { id: "company", header: "Company", sort: "company", cell: (c) => c.company || <span className="muted">None</span> },
    {
      id: "email", header: "Email", help: "Encrypted at rest. Shown here because you are signed in to this workspace.",
      cell: (c) => (c.email ? <span className="row" onClick={(e) => e.stopPropagation()}><span className="truncate">{c.email}</span><Copy value={c.email} label="Copy email" /></span> : <span className="muted">None</span>),
    },
    { id: "status", header: "Status", sort: "status", cell: (c) => <Badge tone={statusTone[c.status]}>{statusLabel[c.status]}</Badge> },
    { id: "created", header: "Added", sort: "created", cell: (c) => <Time at={c.createdAt} /> },
  ];

  const help = contactsHelp({ create: canWrite ? () => setCreating(true) : undefined, importCsv: canWrite ? () => setImporting(true) : undefined });
  const s = stats.data;

  return (
    <Page
      title="Contacts"
      description="People and companies you keep track of"
      help={help}
      actions={
        canWrite ? (
          <>
            <Button icon="upload" onClick={() => setImporting(true)}>Import CSV</Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add contact</Button>
          </>
        ) : null
      }
      tabs={[
        { id: "all", label: "All", count: s?.total },
        { id: "lead", label: "Leads", count: s?.lead },
        { id: "active", label: "Active", count: s?.active },
        { id: "archived", label: "Archived", count: s?.archived },
      ]}
      tab={tab}
      onTab={(id) => setTab(id as TabId)}
    >
      <Gate queries={[contacts, stats]}>
        {() => (
          <DataTable
            list={list}
            data={contacts.data}
            fetching={contacts.isFetching}
            columns={columns}
            rowKey={(c) => c.id}
            onRowClick={canWrite ? (c) => setEditingId(c.id) : undefined}
            freshKey={fresh}
            noun={["contact", "contacts"]}
            searchPlaceholder="Name or company, or a full email address"
            bulkActions={
              canDelete
                ? (sel) => (
                    <>
                      {status !== "archived" ? <Button size="sm" onClick={() => void bulk("archive", sel)}>Archive</Button> : null}
                      {status !== "active" ? <Button size="sm" onClick={() => void bulk("activate", sel)}>Mark active</Button> : null}
                      <Button size="sm" variant="danger" icon="trash" onClick={() => void bulk("delete", sel)}>Delete</Button>
                    </>
                  )
                : undefined
            }
            rowActions={canDelete ? (c) => <IconButton small icon="trash" label={`Delete ${c.name}`} onClick={() => void remove(c)} /> : undefined}
            empty={
              tab === "all"
                ? { icon: "contact", title: "No contacts yet", body: "Add your first contact, or import a list from a CSV file.", action: canWrite ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add contact</Button> : undefined }
                : { icon: "contact", title: `No ${statusLabel[tab].toLowerCase()} contacts`, body: "Contacts appear here when their status matches this tab." }
            }
          />
        )}
      </Gate>

      <FormDrawer<FormValues>
        open={creating}
        onClose={() => setCreating(false)}
        title="Add contact"
        initial={{ ...blank, status: status || "lead" }}
        submitLabel="Add contact"
        validate={validate}
        onSubmit={async (v) => {
          const created = await api<Contact>("/api/m/contacts", { body: v });
          await invalidate("contact.create");
          setFresh(created.id);
          toast.success(`${created.name} added.`);
        }}
      >
        {(f) => <ContactFields f={f} />}
      </FormDrawer>

      {/* Editing needs the notes, which the list does not carry: load the record, then show the form. */}
      {editingId && !detail.data ? (
        <Drawer open onClose={() => setEditingId(null)} title="Edit contact">
          {detail.error ? <Callout tone="bad">{errorMessage(detail.error)}</Callout> : <Skeleton kind="form" />}
        </Drawer>
      ) : null}
      <FormDrawer<FormValues>
        open={!!editingId && !!detail.data}
        onClose={() => setEditingId(null)}
        title="Edit contact"
        subtitle={detail.data?.name}
        initial={detail.data ? { name: detail.data.name, company: detail.data.company, email: detail.data.email, status: detail.data.status, notes: detail.data.notes } : blank}
        submitLabel="Save changes"
        validate={validate}
        onSubmit={async (v) => {
          await api(`/api/m/contacts/${editingId}`, { method: "PATCH", body: v });
          await invalidate("contact.update");
          setFresh(editingId);
          toast.success("Contact saved.");
        }}
      >
        {(f) => <ContactFields f={f} />}
      </FormDrawer>

      <FormDrawer
        open={importing}
        onClose={() => setImporting(false)}
        size="lg"
        title="Import contacts"
        subtitle="Runs in the background. The bell shows progress and this list refreshes when it finishes."
        initial={{ csv: "" }}
        submitLabel="Start import"
        validate={(v) => (!v.csv.trim() ? { csv: "Paste at least one line." } : v.csv.length > IMPORT_LIMIT ? { csv: `That is ${v.csv.length.toLocaleString()} characters; the limit is ${IMPORT_LIMIT.toLocaleString()}. Import in smaller batches.` } : {})}
        onSubmit={async (v) => {
          await api("/api/m/contacts/import", { body: { csv: v.csv } });
          await invalidate("contact.import");
          toast.success("Import started. You will be notified when it finishes.");
        }}
      >
        {(f) => (
          <>
            <Field label="CSV" error={f.errors.csv} hint={`One contact per line: name,email,company. Email and company are optional. A header line is skipped. ${f.values.csv.length.toLocaleString()} of ${IMPORT_LIMIT.toLocaleString()} characters.`}>
              {(p) => <Textarea {...p} className="mono" rows={14} spellCheck={false} placeholder={'name,email,company\n"Lovelace, Ada",ada@example.com,Analytical Engines\nGrace Hopper,grace@example.com,US Navy\nAlan Turing,,'} {...f.text("csv")} />}
            </Field>
            <Callout>Imported contacts start as leads. Lines without a name, or with an invalid email address, are skipped; the Audit log records how many were imported and skipped.</Callout>
          </>
        )}
      </FormDrawer>
    </Page>
  );
}
