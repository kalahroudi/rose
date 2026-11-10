// SPDX-License-Identifier: Apache-2.0
import { api, ApiError, AuthLayout, Badge, Button, Callout, errorMessage, Field, Icon, Input, SignIn } from "@rose/ui";
import { useEffect, useState } from "react";
import { roleLabel } from "../session";
import type { Bootstrap, RootVerified } from "../types";

const slugify = (name: string): string =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

type Availability = "idle" | "checking" | "free" | "taken";

/** Debounced check that an address is valid and unused. Quietly gives up if rate limited. */
function useSlugAvailability(slug: string): Availability {
  const [state, setState] = useState<Availability>("idle");
  useEffect(() => {
    if (slug.length < 3) return setState("idle");
    setState("checking");
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ available: boolean }>(`/api/root/slug?slug=${encodeURIComponent(slug)}`, { signal: ctl.signal }).then(
        (r) => setState(r.available ? "free" : "taken"),
        () => !ctl.signal.aborted && setState("idle"),
      );
    }, 400);
    return () => (clearTimeout(t), ctl.abort());
  }, [slug]);
  return state;
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <div className="steps" role="img" aria-label={`Step ${at} of 3`}>
      {[1, 2, 3].map((n) => <i key={n} data-on={n <= at} />)}
    </div>
  );
}

/** Root host: prove your email, then enter one of your workspaces or create a new one. */
export function Onboarding({ boot }: { boot: Bootstrap }) {
  const [verified, setVerified] = useState<RootVerified | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const footer = (
    <span className="prose" style={{ display: "block", textAlign: "center", maxWidth: 400 }}>
      Every workspace lives at its own address. Your browser keeps cookies and passkeys separate per address, so a session in one workspace can never be used in another.
    </span>
  );

  if (!verified) {
    return (
      <AuthLayout appName={boot.app.name} footer={footer}>
        <Steps at={1} />
        {notice ? <Callout tone="warn">{notice}</Callout> : null}
        <SignIn<RootVerified>
          base="/api/root"
          title="Sign in or create a workspace"
          subtitle="Enter your email. We will send a code to confirm it is you, then show your workspaces."
          onDone={(result) => (setNotice(null), setVerified(result))}
        />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout appName={boot.app.name} footer={footer}>
      <Steps at={leaving ? 3 : 2} />
      <Choose
        boot={boot}
        verified={verified}
        onLeaving={() => setLeaving(true)}
        onExpired={() => {
          setLeaving(false);
          setVerified(null);
          setNotice("Your verification expired or was already used. Confirm your email again to continue.");
        }}
      />
    </AuthLayout>
  );
}

function Choose({ boot, verified, onLeaving, onExpired }: { boot: Bootstrap; verified: RootVerified; onLeaving(): void; onExpired(): void }) {
  const [creating, setCreating] = useState(verified.workspaces.length === 0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const availability = useSlugAvailability(slug);

  // The ticket is single use: one call either enters a workspace or creates one.
  const enter = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    setFields({});
    try {
      const { url } = await api<{ url: string }>("/api/root/enter", { body: { ticket: verified.ticket, ...body } });
      onLeaving();
      window.location.assign(url);
    } catch (err) {
      setBusy(null);
      if (err instanceof ApiError && err.status === 401) return onExpired();
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setFields(err.fields);
        // A failed attempt still spent the ticket; say so plainly.
        setError("Fix the highlighted field. You will need to confirm your email again before retrying.");
      } else setError(errorMessage(err));
    }
  };

  const slugError = fields.slug ?? (availability === "taken" ? "That address is taken, reserved or not valid. Use 3–40 lowercase letters, numbers or hyphens." : undefined);

  return (
    <div className="stack">
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {verified.workspaces.length > 0 ? (
        <div className="stack-sm">
          <h1>Your workspaces</h1>
          {verified.workspaces.map((w) => (
            <button key={w.slug} type="button" className="workspace-pick" disabled={busy !== null} onClick={() => void enter(w.slug, { slug: w.slug })}>
              <span className="avatar">{w.name.slice(0, 2).toUpperCase()}</span>
              <span className="grow">
                <strong className="truncate" style={{ display: "block" }}>{w.name}</strong>
                <span className="hint mono">{w.slug}.{boot.app.baseDomain}</span>
              </span>
              <Badge plain>{roleLabel(w.role)}</Badge>
              {busy === w.slug ? <span className="spinner" aria-label="Opening" /> : <Icon name="chevron" />}
            </button>
          ))}
        </div>
      ) : null}

      {verified.workspaces.length > 0 && !creating ? (
        <>
          <div className="divider">or</div>
          <Button block icon="plus" onClick={() => setCreating(true)}>Create a new workspace</Button>
        </>
      ) : null}

      {creating ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy === null && name.trim() && slug.length >= 3 && availability !== "taken") void enter("create", { create: { name: name.trim(), slug } });
          }}
        >
          {verified.workspaces.length > 0 ? <div className="divider">new workspace</div> : <div><h1>Create your workspace</h1><p className="page-desc">You will be its owner. You can invite your team once you are in.</p></div>}
          <Field label="Workspace name" error={fields.name} hint="Usually your company or team name.">
            {(p) => (
              <Input
                {...p}
                autoFocus
                maxLength={80}
                placeholder="Acme Inc"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </Field>
          <Field
            label="Workspace address"
            error={slugError}
            hint={availability === "checking" ? "Checking availability…" : availability === "free" ? "Available. This is where your team will sign in." : "Lowercase letters, numbers and hyphens. It can not be changed later."}
          >
            {(p) => (
              <div className="input-group">
                <Input
                  {...p}
                  className="mono"
                  maxLength={40}
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="acme"
                  value={slug}
                  onChange={(e) => (setSlugEdited(true), setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")))}
                />
                <span className="affix">.{boot.app.baseDomain}</span>
              </div>
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" block busy={busy === "create"} disabled={busy !== null || !name.trim() || slug.length < 3 || availability === "taken"}>
            Create workspace
          </Button>
        </form>
      ) : null}
    </div>
  );
}
