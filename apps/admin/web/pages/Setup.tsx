// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import {
  Advanced, api, Badge, Button, Callout, CodeBlock, CopyChip, errorMessage, ExternalLink, Field, Flow, FormDrawer, Gate, Icon, Input, Logo, Page, ThemeToggle,
  useConfirm, useTab, useToast, type HelpContent, type IconName, type Tone,
} from "@rose/ui";
import { useState } from "react";
import { useSession } from "../App";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";
import type { SetupCheck, SetupStatus } from "../types";

const TABS = ["health", "connections", "agents", "branding"] as const;
type Tab = (typeof TABS)[number];

const tone: Record<SetupCheck["status"], Tone> = { ok: "ok", warn: "warn", fail: "bad" };
const label: Record<SetupCheck["status"], string> = { ok: "Ready", warn: "Recommended", fail: "Action needed" };

const CF_TOKEN_DOCS = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";
const CF_SAAS_DOCS = "https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/";
const WFP_DOCS = "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/";

function ConnectionCard({ icon, title, connected, summary, children, onConnect, onDisconnect, canEdit }: { icon: IconName; title: string; connected: boolean; summary: React.ReactNode; children?: React.ReactNode; onConnect(): void; onDisconnect(): void; canEdit: boolean }) {
  return (
    <section className="card">
      <div className="card-head">
        <Icon name={icon} width={18} height={18} />
        <h2 className="card-title grow">{title}</h2>
        <Badge tone={connected ? "ok" : "neutral"}>{connected ? "Connected" : "Not connected"}</Badge>
      </div>
      <div className="card-pad stack">
        <div className="dim">{summary}</div>
        {children}
        {canEdit ? (
          <div className="row">
            <Button variant={connected ? "default" : "primary"} onClick={onConnect}>{connected ? "Reconnect" : "Connect"}</Button>
            {connected ? <Button variant="ghost" onClick={onDisconnect}>Disconnect</Button> : null}
          </div>
        ) : (
          <p className="hint">Only a platform owner can change connections.</p>
        )}
      </div>
    </section>
  );
}

export function SetupPage() {
  const boot = useSession();
  const isOwner = boot.session.role === "owner";
  const [tab, setTab] = useTab(TABS);
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const [drawer, setDrawer] = useState<"" | "cloudflare" | "github">("");
  const q = useQuery({ queryKey: ["setup"], queryFn: () => api<SetupStatus>("/api/setup"), staleTime: 60_000 });

  const helps: Record<Tab, HelpContent> = {
    health: {
      what: "A live checklist of everything this deployment needs to be safe in production. Each line says what is wrong, why it matters, and how to fix it. It re-checks every time you open it.",
      terms: terms("signInCode", "customDomain", "platformOwner"),
      why: [
        { q: "What is the difference between “Action needed” and “Recommended”?", a: "“Action needed” means something is broken for real users, such as nobody being able to receive sign-in codes. “Recommended” is a risk you may accept for now, such as having a single operator." },
        { q: "Why are some fixes a terminal command?", a: "Secrets such as the master key are stored as Cloudflare secrets, never in the database or in this console, so only the setup script can set them: pnpm setup." },
      ],
    },
    connections: {
      what: "Outside services the platform talks to on your behalf. Cloudflare is needed for customer-owned domains. GitHub shows whether the security checks pass on the code you deploy.",
      diagram: {
        node: <Flow title="How a connection is stored" steps={[{ label: "You paste a token" }, { label: "Verified", sub: "live test call", via: "then" }, { label: "Encrypted", sub: "with the master key", tone: "on" }, { label: "Stored", sub: "never shown again", tone: "ok" }]} />,
        caption: "Tokens are tested before saving, encrypted at rest, and never sent back to the browser.",
      },
      terms: terms("customDomain", "certificate", "guard"),
      why: [
        { q: "Why does the Cloudflare token need custom-hostname permission only?", a: "The console uses it for one job: registering customer domains and reading their status. Granting only that keeps the damage small if the token ever leaks." },
        { q: "Why connect GitHub at all?", a: "So the Health tab can tell you if the latest build failed its security or isolation checks before you deploy it. A token is only needed for private repositories and only needs read access." },
      ],
      links: [
        { label: "Create a Cloudflare API token", href: CF_TOKEN_DOCS },
        { label: "Cloudflare for SaaS: getting started", href: CF_SAAS_DOCS },
      ],
    },
    agents: {
      what: "How to let AI coding agents extend this product without weakening it. The kit gives agents a narrow, typed surface to build on and fails their work automatically if it crosses a security line.",
      diagram: {
        node: <Flow title="Guardrails an agent's change passes through" steps={[{ label: "Agent edits", sub: "a module" }, { label: "Guard", sub: "rules, on every edit", tone: "on" }, { label: "Tests", sub: "isolation contract", tone: "on" }, { label: "CI", sub: "same checks again", tone: "on" }, { label: "You", sub: "approve core changes", tone: "ok" }]} />,
        caption: "Each layer catches a different kind of drift. Changes to the security core always need a human.",
      },
      terms: terms("guard", "isolationTest", "privateDatabase", "tenant"),
      why: [
        { q: "Why can an agent not just query the database?", a: "Module code receives a context that is already bound to one tenant. There is no handle to the shared database and no way to name another tenant, so the mistake that causes most data leaks can not be written." },
        { q: "What happens if an agent edits the security core?", a: "The guard compares protected files against a lock file and fails. A person reviews the diff and runs pnpm guard:approve. Agents are instructed never to run it." },
        { q: "How does an agent call a tenant's API?", a: "With an API key created by that tenant's admin in their workspace (API keys page). The key works on that one tenant only and can never have the owner role." },
      ],
      links: [{ label: "Workers for Platforms", href: WFP_DOCS }],
    },
    branding: {
      what: "The product name, logo and accent colour used by both apps. They live in the repository so every deployment and every fork carries its brand with it.",
      why: [{ q: "Why is branding a command and not a form?", a: "Brand assets are built into the app bundle and the icons, which keeps pages fast and the content security policy strict. The command rewrites every place they appear in one go." }],
    },
  };

  const disconnect = async (what: "cloudflare" | "github", name: string) => {
    const ok = await confirm.danger({ title: `Disconnect ${what === "cloudflare" ? "Cloudflare" : "GitHub"}?`, body: what === "cloudflare" ? "The stored API token is erased. Existing domains keep working, but new ones can not be verified." : "The stored repository link and token are erased.", name, confirmLabel: "Disconnect" });
    if (!ok) return;
    try {
      await api(`/api/setup/${what}`, { method: "DELETE" });
      await invalidate("setup.change");
      toast.success("Disconnected");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page
      title="Setup"
      description="Deployment health, connections and how to build on the kit"
      help={helps[tab]}
      tabs={[{ id: "health", label: "Health", count: q.data?.checks.filter((c) => c.status !== "ok").length || undefined }, { id: "connections", label: "Connections" }, { id: "agents", label: "AI agents" }, { id: "branding", label: "Branding" }]}
      tab={tab}
      onTab={(t) => setTab(t as Tab)}
    >
      <Gate queries={[q]} skeleton="cards">
        {() => {
          const s = q.data!;
          const ready = s.checks.filter((c) => c.status === "ok").length;
          if (tab === "health") {
            return (
              <div className="stack">
                <Callout tone={s.checks.some((c) => c.status === "fail") ? "bad" : ready === s.checks.length ? "ok" : "warn"}>
                  <strong>{ready} of {s.checks.length} checks are ready.</strong>{" "}
                  {s.checks.some((c) => c.status === "fail") ? "Fix the items marked “Action needed” before real customers use this deployment." : ready === s.checks.length ? "This deployment is ready for production." : "Nothing is broken. The remaining items are recommendations."}
                </Callout>
                <section className="card">
                  {s.checks.map((c) => (
                    <div className="attention" key={c.id}>
                      <span className={`dot ${c.status === "ok" ? "dot-ok" : c.status === "warn" ? "dot-medium" : "dot-high"}`} />
                      <div className="grow">
                        <div className="row-wrap"><strong>{c.label}</strong><Badge tone={tone[c.status]} plain>{label[c.status]}</Badge></div>
                        <div>{c.detail}</div>
                        <div className="hint">Why it matters: {c.why}</div>
                      </div>
                      {c.status !== "ok" && (c.id === "cloudflare" || c.id === "github") ? <Button size="sm" onClick={() => setTab("connections")}>Connect</Button> : null}
                    </div>
                  ))}
                </section>
              </div>
            );
          }
          if (tab === "connections") {
            return (
              <div className="grid-wide">
                <ConnectionCard
                  icon="cloud"
                  title="Cloudflare for SaaS"
                  connected={s.cloudflare.connected}
                  canEdit={isOwner}
                  summary={s.cloudflare.connected ? <>Custom domains are registered in zone <CopyChip value={s.cloudflare.zone ?? ""} />.</> : "Lets tenants use their own domains. Cloudflare verifies ownership and issues certificates."}
                  onConnect={() => setDrawer("cloudflare")}
                  onDisconnect={() => void disconnect("cloudflare", s.cloudflare.zone ?? "cloudflare")}
                />
                <ConnectionCard
                  icon="github"
                  title="GitHub repository"
                  connected={s.github.connected}
                  canEdit={isOwner}
                  summary={s.github.connected ? <>Tracking <CopyChip value={s.github.repo ?? ""} /> on branch <code>{s.github.branch}</code>{s.github.hasToken ? ", with a stored token." : "."}</> : "Shows whether the security and isolation checks pass on the code you deploy."}
                  onConnect={() => setDrawer("github")}
                  onDisconnect={() => void disconnect("github", s.github.repo ?? "github")}
                >
                  {s.github.connected ? (
                    <div className="row-wrap">
                      <span>Latest CI run:</span>
                      {s.github.ci ? (
                        <>
                          <Badge tone={s.github.ci.status === "success" ? "ok" : s.github.ci.status === "failure" ? "bad" : "info"}>{s.github.ci.status}</Badge>
                          <ExternalLink href={s.github.ci.url}>View run</ExternalLink>
                        </>
                      ) : (
                        <span className="muted">none found yet</span>
                      )}
                      <ExternalLink href={`https://github.com/${s.github.repo}`}>Open repository</ExternalLink>
                    </div>
                  ) : null}
                </ConnectionCard>
              </div>
            );
          }
          if (tab === "agents") {
            return (
              <div className="grid-wide">
                <section className="card card-pad stack">
                  <h2 className="card-title">Start an agent on this codebase</h2>
                  <p className="dim">Agents read <code>AGENTS.md</code> at the repository root. It states the security rules, the layout, and the recipe for adding a feature as a module.</p>
                  <div className="stack-sm">
                    <span className="label">Ask for a feature like this</span>
                    <CodeBlock>{"Add an \"invoices\" module following docs/adding-a-module.md. Finish only when `pnpm verify` passes."}</CodeBlock>
                  </div>
                  <div className="stack-sm">
                    <span className="label">The one command that proves a change is safe</span>
                    <CodeBlock>pnpm verify</CodeBlock>
                    <span className="hint">Runs the guard, type checks, and every test including the tenant-isolation contract.</span>
                  </div>
                </section>
                <section className="card card-pad stack">
                  <h2 className="card-title">What stops an agent from drifting</h2>
                  <ul className="list-plain stack-sm">
                    {[
                      ["Types", "Module code only receives a tenant-bound context. There is no database handle or environment to misuse."],
                      ["Guard", "Runs after every agent edit and before every commit. Blocks raw data access, unsafe HTML, unbounded lists and more."],
                      ["Isolation contract", "Every module must declare a probe; one shared test proves other tenants can not see or change its data."],
                      ["Protected core", "Auth, crypto and tenancy files are hash-locked. A person must approve any change with pnpm guard:approve."],
                      ["CI", "The same checks run again on every pull request, so nothing depends on the agent behaving."],
                    ].map(([t, d]) => (
                      <li key={t} className="row" style={{ alignItems: "flex-start" }}>
                        <Icon name="shield" width={16} height={16} style={{ marginTop: 3, color: "var(--ok)" }} />
                        <span><strong>{t}.</strong> <span className="dim">{d}</span></span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="card card-pad stack">
                  <h2 className="card-title">Give an agent API access to one tenant</h2>
                  <p className="dim">API keys are created by a tenant's admin inside their workspace, under <strong>API keys</strong>. A key works on that tenant only, acts with a fixed role, and can be revoked at any time. Operators can not create keys for a tenant.</p>
                  <CodeBlock>{`curl ${boot.app.appUrlTemplate.replace("{host}", `acme.${boot.app.baseDomain}`)}/api/m/contacts \\\n  -H "Authorization: Bearer rose_key_…"`}</CodeBlock>
                </section>
              </div>
            );
          }
          return (
            <div className="grid-wide">
              <section className="card card-pad stack">
                <h2 className="card-title">Current brand</h2>
                <div className="row" style={{ gap: 16 }}>
                  <Logo size={48} />
                  <div>
                    <div className="page-title">{boot.app.name}</div>
                    <div className="hint">Tenants live at <code>name.{boot.app.baseDomain}</code></div>
                  </div>
                </div>
                <div className="row-wrap">
                  <Button variant="primary">Primary action</Button>
                  <Button>Secondary</Button>
                  <Badge tone="ok">Active</Badge>
                  <span className="link">A link</span>
                </div>
                <div className="row"><span className="dim">Preview in</span><ThemeToggle /></div>
              </section>
              <section className="card card-pad stack">
                <h2 className="card-title">Change it</h2>
                <p className="dim">Run this in the repository, then deploy. It updates the name, accent colour, favicon and app icons in both apps.</p>
                <CodeBlock>{'pnpm brand --name "Acme" --color "#2563eb" --logo ./logo.svg'}</CodeBlock>
                <p className="hint">Details and the asset list are in <code>docs/branding.md</code>.</p>
              </section>
            </div>
          );
        }}
      </Gate>

      <FormDrawer
        open={drawer === "cloudflare"}
        onClose={() => setDrawer("")}
        title="Connect Cloudflare"
        subtitle="Used only to register customer domains and read their status."
        initial={{ zoneId: "", apiToken: "" }}
        submitLabel="Verify and connect"
        onSubmit={async (v) => {
          const r = await api<{ zone: string }>("/api/setup/cloudflare", { method: "PUT", body: v });
          await invalidate("setup.change");
          toast.success(`Connected to ${r.zone}`);
        }}
      >
        {(f) => (
          <>
            <Field label="Zone ID" hint={<>On the zone's Overview page in the Cloudflare dashboard, under API. Use the zone that owns <code>{boot.app.baseDomain}</code>.</>} error={f.errors.zoneId}>
              {(p) => <Input {...p} {...f.text("zoneId")} className="mono" spellCheck={false} autoComplete="off" placeholder="32 hexadecimal characters" />}
            </Field>
            <Field label="API token" hint={<>Create a token limited to this zone with <strong>SSL and Certificates: Edit</strong>. <ExternalLink href={CF_TOKEN_DOCS}>How to create a token</ExternalLink></>} error={f.errors.apiToken}>
              {(p) => <Input {...p} {...f.text("apiToken")} type="password" className="mono" autoComplete="off" />}
            </Field>
            <Callout>The token is tested with a live call, then encrypted before it is stored. It is never shown again.</Callout>
          </>
        )}
      </FormDrawer>

      <FormDrawer
        open={drawer === "github"}
        onClose={() => setDrawer("")}
        title="Connect a GitHub repository"
        subtitle="Read-only. Shows the latest CI result on the Health tab."
        initial={{ repo: q.data?.github.repo ?? "", token: "" }}
        submitLabel="Verify and connect"
        onSubmit={async (v) => {
          const r = await api<{ repo: string }>("/api/setup/github", { method: "PUT", body: v });
          await invalidate("setup.change");
          toast.success(`Connected to ${r.repo}`);
        }}
      >
        {(f) => (
          <>
            <Field label="Repository" hint="The repository this deployment is built from." error={f.errors.repo}>
              {(p) => <Input {...p} {...f.text("repo")} className="mono" spellCheck={false} autoComplete="off" placeholder="owner/repository" />}
            </Field>
            <Advanced id="github-connect" changed={f.values.token ? 1 : 0}>
              <Field label="Access token" optional hint="Only for private repositories. A fine-grained token with read access to Metadata and Actions is enough. It is encrypted before it is stored." error={f.errors.token}>
                {(p) => <Input {...p} {...f.text("token")} type="password" className="mono" autoComplete="off" />}
              </Field>
            </Advanced>
          </>
        )}
      </FormDrawer>
    </Page>
  );
}
