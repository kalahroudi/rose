// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, Badge, Button, Callout, DataTable, errorMessage, Field, Flow, FormDrawer, Gate, Input, Page, Select, Time, useConfirm, useListState, useTab, useToast, type Column, type HelpContent, type PageData } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import { roleLabel, useWorkspace } from "../session";
import type { Invitation, Member, Role } from "../types";

const TABS = ["members", "invitations"] as const;

const roleTone = (r: Role) => (r === "owner" ? "info" : "neutral") as "info" | "neutral";

function RoleOptions({ allowOwner }: { allowOwner: boolean }) {
  return (
    <>
      <option value="member">Member: work with the data</option>
      <option value="admin">Admin: also manage members, API keys and settings</option>
      {allowOwner ? <option value="owner">Owner: full control, including deleting the workspace</option> : null}
    </>
  );
}

export function MembersPage() {
  const { boot, session, can } = useWorkspace();
  const [tab, setTab] = useTab(TABS);
  const manage = can("members:manage");
  const isOwner = session.role === "owner";
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const [inviting, setInviting] = useState(() => manage && new URLSearchParams(window.location.search).has("new"));
  const [editing, setEditing] = useState<Member | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const remove = async (m: Member) => {
    const ok = await confirm.danger({
      title: "Remove this member?",
      body: `${m.email} is signed out everywhere and loses access to this workspace. Their passkeys for this workspace are deleted. Records they created stay.`,
      name: m.email,
      confirmLabel: "Remove member",
    });
    if (!ok) return;
    try {
      await api(`/api/members/${m.user_id}`, { method: "DELETE" });
      await invalidate("member.remove");
      toast.success(`${m.email} was removed.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const revoke = async (inv: Invitation) => {
    if (!(await confirm({ title: "Revoke this invitation?", body: `${inv.email} will no longer be able to join by signing in. You can invite them again later.`, confirmLabel: "Revoke invitation", tone: "danger" }))) return;
    try {
      await api(`/api/invitations/${inv.id}`, { method: "DELETE" });
      await invalidate("invitation.revoke");
      toast.success("Invitation revoked.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const inviteFlow = (
    <Flow title="How an invitation becomes a membership" steps={[{ label: "Invite", sub: "email + role" }, { label: "Pending", sub: "up to 7 days", tone: "on" }, { label: "They sign in", sub: "code to that email", via: "proves email" }, { label: "Member", sub: "with the role", tone: "ok" }]} />
  );
  const helps: Record<(typeof TABS)[number], HelpContent> = {
    members: {
      what: "Everyone who can sign in to this workspace, and what each of them is allowed to do.",
      terms: terms("member", "role", "owner", "session", "passkey"),
      why: [
        { q: "Why must there always be an owner?", a: "Only an owner can delete the workspace or grant owner access. Without one, nobody could ever do those things again, so the last owner can not be removed or demoted." },
        { q: "What happens when I remove someone?", a: "Access ends on their very next request: every device is signed out and their passkeys for this workspace are deleted. They keep access to any other workspaces they belong to." },
        { q: "Why can't I search by part of a name I don't see?", a: "Search matches the email address or display name. Names are set by each member in Settings." },
      ],
      tasks: [
        { label: "Invite a member", run: manage ? () => (setTab("invitations"), setInviting(true)) : undefined, detail: manage ? undefined : "Ask an owner or admin." },
        { label: "Change someone's role", detail: "Use Change role on their row. Only owners can grant or remove owner access." },
      ],
    },
    invitations: {
      what: "Email addresses that have been invited but have not signed in yet.",
      diagram: { node: inviteFlow, caption: "There is no invitation link. The invited person joins by signing in with that exact email address, which proves they own it." },
      terms: terms("invitation", "signInCode", "role"),
      why: [
        { q: "Why is there no invitation link?", a: "A link can be forwarded, leaked or guessed. Tying the invitation to the email address means only someone who can read that mailbox can accept it." },
        { q: "Why do invitations expire?", a: "An open invitation is standing access for whoever controls that mailbox later. After 7 days it lapses; invite again if needed." },
      ],
      tasks: [{ label: "Invite a member", run: manage ? () => setInviting(true) : undefined }],
    },
  };

  return (
    <Page
      title="Members"
      description="Who can sign in, and what they can do"
      help={helps[tab]}
      actions={manage ? <Button variant="primary" icon="plus" onClick={() => (tab !== "invitations" && setTab("invitations"), setInviting(true))}>Invite member</Button> : null}
      tabs={[{ id: "members", label: "Members" }, { id: "invitations", label: "Invitations" }]}
      tab={tab}
      onTab={(id) => setTab(id as (typeof TABS)[number])}
    >
      {tab === "members" ? (
        <MembersTab manage={manage} selfId={session.user.id} onEdit={setEditing} onRemove={(m) => void remove(m)} />
      ) : (
        <InvitationsTab manage={manage} fresh={fresh} onRevoke={(i) => void revoke(i)} onInvite={() => setInviting(true)} />
      )}

      <FormDrawer
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite member"
        subtitle="They join by signing in with this email address."
        initial={{ email: "", role: "member" as Role }}
        submitLabel="Send invitation"
        validate={(v) => (v.email.includes("@") ? {} : { email: "Enter a valid email address." })}
        onSubmit={async (v) => {
          const inv = await api<Invitation>("/api/invitations", { body: v });
          await invalidate("invitation.create");
          setFresh(inv.id);
          toast.success(`Invitation sent to ${inv.email}.`);
        }}
      >
        {(f) => (
          <>
            <Field label="Email address" error={f.errors.email} hint="No link is sent to forward. Only someone who can read this mailbox can accept.">
              {(p) => <Input {...p} type="email" autoComplete="off" placeholder="teammate@company.com" {...f.text("email")} />}
            </Field>
            <Field label="Role" error={f.errors.role} help="What the person may do once they join. You can change it later.">
              {(p) => (
                <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value as Role)}>
                  <RoleOptions allowOwner={isOwner} />
                </Select>
              )}
            </Field>
            {boot.dev ? <Callout tone="warn">Development mode: the invitation email is printed in the terminal running <span className="mono">pnpm dev</span>, not sent.</Callout> : null}
          </>
        )}
      </FormDrawer>

      <FormDrawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Change role"
        subtitle={editing?.email}
        initial={{ role: (editing?.role ?? "member") as Role }}
        submitLabel="Save role"
        onSubmit={async (v) => {
          await api(`/api/members/${editing!.user_id}`, { method: "PATCH", body: v });
          await invalidate("member.role");
          toast.success(`${editing!.email} is now ${roleLabel(v.role).toLowerCase()}.`);
        }}
      >
        {(f) => (
          <Field label="Role" error={f.errors.role} hint="Takes effect on their next request. Only owners can grant or remove owner access.">
            {(p) => (
              <Select {...p} value={f.values.role} onChange={(e) => f.set("role", e.target.value as Role)}>
                <RoleOptions allowOwner={isOwner || editing?.role === "owner"} />
              </Select>
            )}
          </Field>
        )}
      </FormDrawer>
    </Page>
  );
}

function MembersTab({ manage, selfId, onEdit, onRemove }: { manage: boolean; selfId: string; onEdit(m: Member): void; onRemove(m: Member): void }) {
  const list = useListState(["role"]);
  const members = useQuery({ queryKey: ["members", list.query], queryFn: () => api<PageData<Member>>(`/api/members?${list.query}`), placeholderData: keepPreviousData });
  const columns: Column<Member>[] = [
    {
      id: "email", header: "Member", sort: "email",
      cell: (m) => (
        <div>
          <div className="row"><strong>{m.name || m.email}</strong>{m.user_id === selfId ? <Badge plain>You</Badge> : null}</div>
          {m.name ? <div className="hint">{m.email}</div> : null}
        </div>
      ),
    },
    { id: "role", header: "Role", sort: "role", help: "Owner: everything. Admin: manage members, keys and settings. Member: work with the data.", cell: (m) => <Badge tone={roleTone(m.role)} plain>{roleLabel(m.role)}</Badge> },
    { id: "joined", header: "Joined", sort: "joined", cell: (m) => <Time at={m.created_at} /> },
    { id: "seen", header: "Last sign-in", sort: "seen", cell: (m) => <Time at={m.last_login_at} /> },
  ];
  return (
    <Gate queries={[members]}>
      {() => (
        <DataTable
          list={list}
          data={members.data}
          fetching={members.isFetching}
          columns={columns}
          rowKey={(m) => m.user_id}
          noun={["member", "members"]}
          searchPlaceholder="Search by email or name"
          filters={
            <Select aria-label="Role" value={list.filters.role} onChange={(e) => list.set({ filters: { role: e.target.value } })}>
              <option value="">All roles</option>
              <option value="owner">Owners</option>
              <option value="admin">Admins</option>
              <option value="member">Members</option>
            </Select>
          }
          rowActions={
            manage
              ? (m) => (
                  <>
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(m)}>Change role</Button>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => onRemove(m)}>Remove</Button>
                  </>
                )
              : undefined
          }
          empty={{ icon: "users", title: "No members", body: "Invite someone to get started." }}
        />
      )}
    </Gate>
  );
}

function InvitationsTab({ manage, fresh, onRevoke, onInvite }: { manage: boolean; fresh: string | null; onRevoke(i: Invitation): void; onInvite(): void }) {
  const list = useListState();
  const invitations = useQuery({ queryKey: ["invitations", list.query], queryFn: () => api<PageData<Invitation>>(`/api/invitations?${list.query}`), placeholderData: keepPreviousData });
  const columns: Column<Invitation>[] = [
    { id: "email", header: "Invited email", cell: (i) => <strong>{i.email}</strong> },
    { id: "role", header: "Role", cell: (i) => <Badge tone={roleTone(i.role)} plain>{roleLabel(i.role)}</Badge> },
    { id: "by", header: "Invited by", cell: (i) => i.invited_by ?? <span className="muted">Platform operator</span> },
    { id: "sent", header: "Sent", cell: (i) => <Time at={i.created_at} /> },
    { id: "expires", header: "Expires", help: "After this the address can no longer join. Invite again to renew.", cell: (i) => <Time at={i.expires_at} /> },
  ];
  return (
    <Gate queries={[invitations]}>
      {() => (
        <DataTable
          list={list}
          data={invitations.data}
          fetching={invitations.isFetching}
          columns={columns}
          rowKey={(i) => i.id}
          freshKey={fresh}
          noun={["invitation", "invitations"]}
          searchPlaceholder="Search by email"
          rowActions={manage ? (i) => <Button size="sm" variant="ghost" icon="x" onClick={() => onRevoke(i)}>Revoke</Button> : undefined}
          empty={{
            icon: "mail", title: "No pending invitations",
            body: "Invite someone by email. They join by signing in with that address.",
            action: manage ? <Button variant="primary" icon="plus" onClick={onInvite}>Invite member</Button> : undefined,
          }}
        />
      )}
    </Gate>
  );
}
