// SPDX-License-Identifier: Apache-2.0
import { api, Badge, Button, CopyChip, errorMessage, Field, Flow, Input, Page, SecurityPanel, ThemeToggle, useTab, useToast, type HelpContent } from "@rose/ui";
import { useState } from "react";
import { useSession } from "../App";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";

const TABS = ["profile", "security"] as const;

const helps: Record<(typeof TABS)[number], HelpContent> = {
  profile: {
    what: "How you appear in this console and in its audit log, and how the console looks on this device.",
    terms: terms("operator", "platformOwner"),
    why: [{ q: "Why can I not change my email?", a: "Your email is your identity here: it is what a platform owner granted access to. To use a different address, ask an owner to add it and remove this one." }],
  },
  security: {
    what: "The ways you can sign in, and the devices that are signed in right now. Add a passkey on each device you use; sign out any device you do not recognise.",
    diagram: {
      node: <Flow title="Signing in" steps={[{ label: "Passkey", sub: "fingerprint, face, PIN", tone: "ok" }, { label: "or email code", sub: "6 digits, 10 minutes" }, { label: "Session", sub: "this site only", via: "creates", tone: "on" }]} />,
      caption: "Either method creates a session that is valid on this console only and ends after 7 days.",
    },
    terms: terms("passkey", "signInCode"),
    why: [
      { q: "Why passkeys instead of passwords?", a: "A passkey can not be guessed, reused on another site, or typed into a fake page: the browser only offers it to the site that created it." },
      { q: "Why is my passkey not offered on another site?", a: "Each passkey belongs to one exact host name. That is the same property that stops a tenant's passkey from working on another tenant." },
    ],
    links: [{ label: "About passkeys (FIDO Alliance)", href: "https://fidoalliance.org/passkeys/" }],
  },
};

export function AccountPage() {
  const { session } = useSession();
  const [tab, setTab] = useTab(TABS);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState(session.user.name);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/auth/profile", { method: "PATCH", body: { name } });
      await invalidate("profile.update");
      toast.success("Profile saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title="Your account" description="Your profile and how you sign in" help={helps[tab]} tabs={[{ id: "profile", label: "Profile" }, { id: "security", label: "Security" }]} tab={tab} onTab={(t) => setTab(t as typeof tab)}>
      {tab === "profile" ? (
        <div className="grid-wide">
          <form className="card card-pad stack" onSubmit={(e) => void save(e)}>
            <Field label="Name" hint="Shown in the menu and beside your actions.">{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
            <dl className="dl">
              <dt>Email</dt>
              <dd><CopyChip value={session.user.email} /></dd>
              <dt>Role</dt>
              <dd><Badge plain>{session.role === "owner" ? "Platform owner" : "Operator"}</Badge></dd>
            </dl>
            <div><Button type="submit" variant="primary" busy={saving} disabled={name === session.user.name}>Save profile</Button></div>
          </form>
          <section className="card card-pad stack">
            <div>
              <h2 className="card-title">Appearance</h2>
              <p className="hint">Light, dark, or follow your system. Saved on this device.</p>
            </div>
            <div><ThemeToggle /></div>
          </section>
        </div>
      ) : (
        <SecurityPanel />
      )}
    </Page>
  );
}
