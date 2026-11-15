// SPDX-License-Identifier: Apache-2.0
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { QueryCache, QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "./api";
import { Field, Input } from "./form";
import { Logo } from "./icons";
import { useConfirm, useToast } from "./overlay";
import { Gate } from "./page";
import { Badge, Button, Callout, EmptyState, Time } from "./primitives";

/**
 * Query client with the product's caching defaults: data is fresh for 30s, in-flight
 * requests are de-duplicated, and a 401 anywhere re-checks the session so the sign-in
 * screen appears instead of a broken page.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (err instanceof ApiError && err.status === 401 && query.queryKey[0] !== "bootstrap") void client.invalidateQueries({ queryKey: ["bootstrap"] });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => (err instanceof ApiError ? err.status === 0 || err.status >= 500 : true) && count < 2,
      },
    },
  });
  return client;
}

/**
 * One place that says which cached data each action makes stale. Declare the map once
 * per app (`web/invalidation.ts`) and call `invalidate("tenant.create")` after a mutation:
 * the affected lists refetch and the result is on screen without a reload.
 */
export function createInvalidator<M extends Record<string, readonly (readonly unknown[])[]>>(map: M) {
  return function useInvalidate() {
    const qc = useQueryClient();
    return useCallback((action: keyof M) => Promise.all(map[action]!.map((queryKey) => qc.invalidateQueries({ queryKey: queryKey as unknown[] }))), [qc]);
  };
}

export function AuthLayout({ appName, children, footer }: { appName: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="center-screen">
      <div className="stack" style={{ alignItems: "center", width: "100%" }}>
        <div className="card auth-card">
          <div className="auth-brand"><Logo size={28} />{appName}</div>
          {children}
        </div>
        {footer ? <div className="hint">{footer}</div> : null}
      </div>
    </main>
  );
}

export interface SignInProps<R> {
  title: string;
  subtitle?: ReactNode;
  /** API prefix that exposes `/code/request` and `/code/verify`. */
  base: string;
  /** Offer "Sign in with a passkey" (the API must expose `/passkey/login/*` under `base`). */
  passkeys?: boolean;
  onDone(result: R, email: string): void;
}

/**
 * Passwordless sign-in: a passkey if you have one, otherwise a one-time code by email.
 * The server answers the same way whether or not the address has access, so the form
 * never reveals who has an account.
 */
export function SignIn<R = { ok: true }>({ title, subtitle, base, passkeys, onDone }: SignInProps<R>) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "code" | "verify" | "passkey">("");
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // The browser's own "cancelled" error for passkeys is not worth showing.
      if (!(err instanceof Error && err.name === "NotAllowedError")) setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  };

  const request = () =>
    run("code", async () => {
      const r = await api<{ devCode?: string }>(`${base}/code/request`, { body: { email } });
      setDevCode(r.devCode ?? null);
      setCode("");
      setStep("code");
    });
  const verify = (value = code) => run("verify", async () => onDone(await api<R>(`${base}/code/verify`, { body: { email, code: value } }), email));
  const passkey = () =>
    run("passkey", async () => {
      const { id, options } = await api<{ id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(`${base}/passkey/login/options`, { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      onDone(await api<R>(`${base}/passkey/login/verify`, { body: { id, response } }), "");
    });

  if (step === "code") {
    return (
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void verify())}>
        <div>
          <h1>Check your email</h1>
          <p className="page-desc">If <strong>{email}</strong> has access, a 6-digit code is on its way. It expires in 10 minutes.</p>
        </div>
        {error ? <Callout tone="bad">{error}</Callout> : null}
        {devCode ? (
          <Callout tone="warn">
            Development mode: your code is <button type="button" className="link mono" onClick={() => (setCode(devCode), void verify(devCode))}>{devCode}</button>. In production it is only sent by email.
          </Callout>
        ) : null}
        <Field label="Sign-in code">
          {(p) => (
            <Input {...p} className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" block busy={busy === "verify"} disabled={code.length !== 6}>Continue</Button>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button type="button" className="link" onClick={() => (setStep("email"), setError(null))}>Use a different email</button>
          <button type="button" className="link" disabled={busy !== ""} onClick={() => void request()}>Send a new code</button>
        </div>
      </form>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), void request())}>
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-desc">{subtitle}</p> : null}
      </div>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {passkeys && browserSupportsWebAuthn() ? (
        <>
          <Button size="lg" block icon="fingerprint" busy={busy === "passkey"} onClick={() => void passkey()}>Sign in with a passkey</Button>
          <div className="divider">or</div>
        </>
      ) : null}
      <Field label="Email address">
        {(p) => <Input {...p} type="email" autoComplete="email webauthn" required placeholder="you@company.com" autoFocus={!passkeys} value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary" size="lg" block icon="mail" busy={busy === "code"} disabled={!email.includes("@")}>Email me a sign-in code</Button>
    </form>
  );
}

interface PasskeyItem {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}
interface SessionItem {
  id: string;
  method: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export async function addPasskey(base: string): Promise<void> {
  const { id, options } = await api<{ id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(`${base}/passkey/register/options`, { body: {} });
  const response = await startRegistration({ optionsJSON: options });
  await api(`${base}/passkey/register/verify`, { body: { id, response, name: describeAgent(navigator.userAgent) } });
}

/** Passkeys and active sessions for the signed-in person. Shared by both apps. */
export function SecurityPanel({ base = "/api/auth" }: { base?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const passkeys = useQuery({ queryKey: ["auth", "passkeys"], queryFn: () => api<{ items: PasskeyItem[] }>(`${base}/passkeys`) });
  const sessions = useQuery({ queryKey: ["auth", "sessions"], queryFn: () => api<{ items: SessionItem[] }>(`${base}/sessions`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["auth"] }), qc.invalidateQueries({ queryKey: ["bootstrap"] })]);

  const add = async () => {
    setAdding(true);
    try {
      await addPasskey(base);
      await refresh();
      toast.success("Passkey added. You can use it next time you sign in.");
    } catch (err) {
      if (!(err instanceof Error && err.name === "NotAllowedError")) toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };
  const removePasskey = async (p: PasskeyItem) => {
    if (!(await confirm({ title: "Remove this passkey?", body: `"${p.name}" will no longer sign you in. You can still use an email code.`, confirmLabel: "Remove passkey", tone: "danger" }))) return;
    await api(`${base}/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(refresh, (e) => toast.error(errorMessage(e)));
  };
  const revoke = async (s: SessionItem) => {
    if (!(await confirm({ title: "Sign out this device?", body: `${describeAgent(s.user_agent)} will need to sign in again.`, confirmLabel: "Sign out device" }))) return;
    await api(`${base}/sessions/${s.id}`, { method: "DELETE" }).then(refresh, (e) => toast.error(errorMessage(e)));
  };

  return (
    <Gate queries={[passkeys, sessions]} skeleton="detail">
      {() => (
        <div className="grid-wide">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title grow">Passkeys</h2>
              {browserSupportsWebAuthn() ? <Button size="sm" icon="plus" busy={adding} onClick={() => void add()}>Add passkey</Button> : null}
            </div>
            {passkeys.data!.items.length === 0 ? (
              <EmptyState icon="fingerprint" title="No passkeys yet">A passkey signs you in with your fingerprint, face or device PIN. It can not be phished and there is no code to wait for.</EmptyState>
            ) : (
              <table className="table">
                <tbody>
                  {passkeys.data!.items.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.name}</strong><div className="hint">Added <Time at={p.created_at} /> · Last used <Time at={p.last_used_at} /></div></td>
                      <td className="col-actions"><Button size="sm" variant="ghost" icon="trash" onClick={() => void removePasskey(p)}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card">
            <div className="card-head"><h2 className="card-title">Signed-in devices</h2></div>
            <table className="table">
              <tbody>
                {sessions.data!.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="row"><strong>{describeAgent(s.user_agent)}</strong>{s.current ? <Badge tone="ok">This device</Badge> : null}</div>
                      <div className="hint">Signed in with {s.method === "passkey" ? "a passkey" : "an email code"} · Active <Time at={s.last_seen_at} />{s.ip ? ` · ${s.ip}` : ""}</div>
                    </td>
                    <td className="col-actions">{s.current ? null : <Button size="sm" variant="ghost" onClick={() => void revoke(s)}>Sign out</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </Gate>
  );
}
