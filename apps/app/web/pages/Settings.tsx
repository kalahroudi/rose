// SPDX-License-Identifier: Apache-2.0
import { api, Button, Callout, CopyChip, errorMessage, Field, Flow, FormDrawer, Input, Page, SecurityPanel, ThemeToggle, useConfirm, useTab, useToast, type HelpContent } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import { roleLabel, useWorkspace } from "../session";

const ALL_TABS = ["general", "security", "danger"] as const;
type TabId = (typeof ALL_TABS)[number];

export function SettingsPage() {
  const { tenant, session, can, markDeleted } = useWorkspace();
  const canDelete = can("workspace:delete");
  const [tab, setTab] = useTab<TabId>(ALL_TABS);
  const active: TabId = tab === "danger" && !canDelete ? "general" : tab;
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const [renaming, setRenaming] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteWorkspace = async () => {
    const ok = await confirm.danger({
      title: "Delete this workspace?",
      body: "All data, members, API keys, the audit log and the workspace's encryption key are destroyed for everyone. This can not be undone or recovered from backup.",
      name: tenant.slug,
      confirmLabel: "Delete workspace",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api("/api/workspace/delete", { body: { confirm: tenant.slug } });
      markDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  };

  const helps: Record<TabId, HelpContent> = {
    general: {
      what: "The workspace's name and address, and your own profile within it.",
      terms: terms("workspace", "address", "role"),
      why: [
        { q: "Why can't the address be changed?", a: "Sessions and passkeys are bound to the exact address. Changing it would sign everyone out and make every passkey useless, so the address is fixed when the workspace is created." },
        { q: "Who can rename the workspace?", a: "Owners and admins. The name is only a label; changing it affects nothing else." },
      ],
      tasks: [
        { label: "Rename the workspace", run: can("workspace:update") ? () => setRenaming(true) : undefined },
        { label: "Change your display name", run: () => setEditingProfile(true) },
      ],
    },
    security: {
      what: "How you sign in to this workspace, and which devices are signed in as you right now.",
      diagram: {
        node: <Flow title="Signing in" steps={[{ label: "Passkey", sub: "fingerprint, face, PIN", tone: "on" }, { label: "or email code", sub: "6 digits, 10 min", via: "fallback" }, { label: "Session", sub: "this address, 7 days", tone: "ok" }]} />,
        caption: "A passkey is the primary way in. An email code always works as a fallback, for example on a new device.",
      },
      terms: terms("passkey", "signInCode", "session"),
      why: [
        { q: "Why is my passkey only valid for this workspace?", a: "A passkey is bound to the address it was created on. If you belong to several workspaces you add one in each; a passkey from one can not open another." },
        { q: "Why is there no password?", a: "Passwords get reused, guessed and phished. Passkeys and one-time codes remove that whole class of problem." },
        { q: "What does signing out a device do?", a: "It ends that session on the server immediately. The device has to sign in again." },
      ],
      links: [
        { label: "Passkeys explained (passkeys.dev)", href: "https://passkeys.dev/docs/intro/what-are-passkeys/" },
        { label: "FIDO Alliance: passkeys", href: "https://fidoalliance.org/passkeys/" },
      ],
    },
    danger: {
      what: "Permanently delete this workspace and everything in it. Only owners can do this.",
      diagram: {
        node: <Flow title="What deletion does" steps={[{ label: "Confirm", sub: "type the address" }, { label: "Closed", sub: "everyone signed out", tone: "bad" }, { label: "Data destroyed", sub: "database + key", via: "background" }, { label: "Gone", sub: "address released" }]} />,
        caption: "Access ends at once. The private database and its encryption key are then destroyed in the background, usually within a minute.",
      },
      terms: terms("workspace", "dataKey", "owner"),
      why: [
        { q: "Why do I have to type the address?", a: "Deletion can not be undone. Typing the exact address makes sure you are deleting the workspace you think you are." },
        { q: "Can deleted data be recovered?", a: "No. The workspace's data key is destroyed with its database, so even a stray copy of encrypted values could never be read again." },
      ],
      tasks: [{ label: "Delete this workspace", run: canDelete ? () => void deleteWorkspace() : undefined }],
    },
  };

  return (
    <Page
      title="Settings"
      description="Workspace details, your sign-in methods and deletion"
      help={helps[active]}
      tabs={[{ id: "general", label: "General" }, { id: "security", label: "Security" }, ...(canDelete ? [{ id: "danger", label: "Danger zone" }] : [])]}
      tab={active}
      onTab={(id) => setTab(id as TabId)}
    >
      {active === "general" ? (
        <div className="grid-wide">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Workspace</h2>
              {can("workspace:update") ? <Button size="sm" icon="edit" onClick={() => setRenaming(true)}>Rename</Button> : null}
            </div>
            <dl className="dl card-pad">
              <dt>Name</dt>
              <dd>{tenant.name}</dd>
              <dt>Address</dt>
              <dd><CopyChip value={tenant.slug} /></dd>
              <dt>URL</dt>
              <dd><CopyChip value={window.location.origin} /></dd>
            </dl>
          </section>
          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Your profile</h2>
              <Button size="sm" icon="edit" onClick={() => setEditingProfile(true)}>Edit name</Button>
            </div>
            <dl className="dl card-pad">
              <dt>Display name</dt>
              <dd>{session.user.name || <span className="muted">Not set</span>}</dd>
              <dt>Email</dt>
              <dd className="truncate">{session.user.email}</dd>
              <dt>Role</dt>
              <dd>{roleLabel(session.role)}</dd>
              <dt>Appearance</dt>
              <dd><ThemeToggle /></dd>
            </dl>
          </section>
        </div>
      ) : active === "security" ? (
        <SecurityPanel />
      ) : (
        <section className="card card-pad stack" style={{ maxWidth: 720 }}>
          <div>
            <h2 className="card-title">Delete this workspace</h2>
            <p className="dim">
              Destroys every record, the member list, all API keys, the audit log and the workspace's encryption key. Everyone is signed out immediately and the address <span className="mono">{tenant.slug}</span> stops working.
            </p>
          </div>
          <Callout tone="bad">This can not be undone. There is no backup to restore from once the encryption key is destroyed.</Callout>
          <div><Button variant="danger" icon="trash" busy={deleting} onClick={() => void deleteWorkspace()}>Delete workspace</Button></div>
        </section>
      )}

      <FormDrawer
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename workspace"
        subtitle="Changes the label only. The address stays the same."
        initial={{ name: tenant.name }}
        submitLabel="Save name"
        validate={(v) => (v.name.trim() ? {} : { name: "Enter a name." })}
        onSubmit={async (v) => {
          await api("/api/workspace", { method: "PATCH", body: { name: v.name } });
          await invalidate("workspace.rename");
          toast.success("Workspace renamed.");
        }}
      >
        {(f) => (
          <Field label="Workspace name" error={f.errors.name} hint="Shown in the menu, on the sign-in screen and in emails.">
            {(p) => <Input {...p} maxLength={80} {...f.text("name")} />}
          </Field>
        )}
      </FormDrawer>

      <FormDrawer
        open={editingProfile}
        onClose={() => setEditingProfile(false)}
        title="Edit your name"
        subtitle="Shown to other members of every workspace you belong to."
        initial={{ name: session.user.name }}
        submitLabel="Save name"
        onSubmit={async (v) => {
          await api("/api/auth/profile", { method: "PATCH", body: { name: v.name } });
          await invalidate("profile.update");
          toast.success("Name updated.");
        }}
      >
        {(f) => (
          <Field label="Display name" optional error={f.errors.name} hint="Leave empty to show your email address instead.">
            {(p) => <Input {...p} maxLength={80} autoComplete="name" {...f.text("name")} />}
          </Field>
        )}
      </FormDrawer>
    </Page>
  );
}
