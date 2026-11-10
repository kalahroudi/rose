// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, Badge, Button, Callout, DataTable, errorMessage, Field, FormDrawer, Gate, Input, Page, Select, Time, useConfirm, useListState, useToast, type Column, type HelpContent, type PageData } from "@rose/ui";
import { useState } from "react";
import { useSession } from "../App";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import type { Operator } from "../types";

export function OperatorsPage() {
  const { session, dev } = useSession();
  const isOwner = session.role === "owner";
  const list = useListState();
  const confirm = useConfirm();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["operators", list.query], queryFn: () => api<PageData<Operator>>(`/api/operators?${list.query}`), placeholderData: keepPreviousData });

  const help: HelpContent = {
    what: "Your own staff who can use this console. Operators manage tenants and domains; platform owners can also add or remove operators and change connections.",
    terms: terms("operator", "platformOwner", "passkey", "signInCode"),
    why: [
      { q: "Why is there no password to set?", a: "Operators sign in with a passkey, or a one-time code sent to their email. Adding someone here simply allows their address to sign in; nothing secret is created or shared." },
      { q: "Why should there be at least two owners?", a: "If the only owner loses access to their mailbox and passkey, nobody can add operators or change connections. A second owner is your recovery path." },
      { q: "What can an operator see of tenant data?", a: "Nothing. Operators see the directory (names, addresses, member emails, domains). Tenant databases and keys are not reachable from this console at all." },
    ],
    tasks: [{ label: "Add an operator", run: isOwner ? () => setAdding(true) : undefined, detail: isOwner ? undefined : "Only a platform owner can do this." }],
  };

  const remove = async (o: Operator) => {
    const ok = await confirm.danger({ title: "Remove this operator?", body: "They are signed out everywhere and their passkeys for this console are deleted.", name: o.email, confirmLabel: "Remove operator" });
    if (!ok) return;
    try {
      await api(`/api/operators/${o.user_id}`, { method: "DELETE" });
      await invalidate("operator.change");
      toast.success(`${o.email} removed`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const columns: Column<Operator>[] = [
    { id: "email", header: "Operator", cell: (o) => (<div className="row"><strong>{o.email}</strong>{o.user_id === session.user.id ? <Badge tone="info" plain>You</Badge> : null}</div>) },
    { id: "role", header: "Role", width: "140px", help: "Owners can manage operators and connections. Operators can not.", cell: (o) => <Badge plain>{o.role === "owner" ? "Platform owner" : "Operator"}</Badge> },
    { id: "added", header: "Added", width: "150px", cell: (o) => <Time at={o.created_at} /> },
    { id: "seen", header: "Last sign-in", width: "150px", cell: (o) => <Time at={o.last_login_at} /> },
  ];

  return (
    <Page title="Operators" description="Staff who can use this console" help={help} actions={isOwner ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add operator</Button> : undefined}>
      <Gate queries={[q]}>
        {() => (
          <DataTable
            list={list}
            data={q.data}
            fetching={q.isFetching}
            columns={columns}
            rowKey={(o) => o.user_id}
            freshKey={fresh}
            noun={["operator", "operators"]}
            searchPlaceholder="Search by email"
            rowActions={isOwner ? (o) => (o.user_id === session.user.id ? null : <Button size="sm" variant="ghost" icon="trash" onClick={() => void remove(o)}>Remove</Button>) : undefined}
            empty={{ icon: "users", title: "No operators", body: "Add the people on your team who run the platform." }}
          />
        )}
      </Gate>
      <FormDrawer
        open={adding}
        onClose={() => setAdding(false)}
        title="Add operator"
        subtitle="Allows this address to sign in to the console."
        initial={{ email: "", role: "operator" }}
        submitLabel="Add operator"
        onSubmit={async (v) => {
          await api("/api/operators", { body: v });
          await invalidate("operator.change");
          setFresh(null);
          toast.success(`${v.email} can now sign in`);
        }}
      >
        {(f) => (
          <>
            <Field label="Email address" error={f.errors.email}>{(p) => <Input {...p} {...f.text("email")} type="email" autoComplete="off" placeholder="teammate@yourcompany.com" />}</Field>
            <Field label="Role" help="Owners can add and remove operators and change connections." error={f.errors.role}>
              {(p) => (
                <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value)}>
                  <option value="operator">Operator: manage tenants and domains</option>
                  <option value="owner">Platform owner: also manage operators and connections</option>
                </Select>
              )}
            </Field>
            {dev ? <Callout>Development mode: no email is sent. The person signs in at this console and the code appears on screen.</Callout> : <Callout>No invitation email is sent. Tell them to sign in at this console with that address.</Callout>}
          </>
        )}
      </FormDrawer>
    </Page>
  );
}
