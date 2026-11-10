// SPDX-License-Identifier: Apache-2.0
import { api, ApiError, Button, Callout, CodeBlock, CopyChip, Flow, Page, type HelpContent } from "@rose/ui";
import { useState } from "react";
import { terms } from "../help/glossary";

const help: HelpContent = {
  what: "This workspace is connected to a service behind the platform. Anything you request under /svc is forwarded to it, together with proof of which workspace and member the request is for.",
  diagram: {
    node: <Flow title="Path of a /svc request" steps={[{ label: "You", sub: "/svc/…" }, { label: "Gateway", sub: "checks your session", tone: "on" }, { label: "Signed token", sub: "workspace + member", via: "adds" }, { label: "Service", sub: "verifies, responds" }]} />,
    caption: "The service never sees your cookie or API key. It receives a token, valid for 60 seconds, that only the gateway can sign.",
  },
  terms: [...terms("gateway", "workspace", "session"), { term: "Tenant token", def: "A short-lived signed statement (X-Rose-Tenant-Token) naming the workspace, the member or key, and their role. The service trusts it instead of trusting the caller." }],
  why: [
    { q: "Why not call the service directly?", a: "The service was not built to know about workspaces. The gateway signs you in, decides the workspace from the address, and tells the service in a way that can not be forged." },
    { q: "Why are cookies and Authorization headers removed?", a: "So your credentials for this workspace never leave the platform, and the service can not set cookies on this address." },
  ],
};

type Result = { ok: true; body: string } | { ok: false; status: number; message: string };

export function ServicePage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const tryIt = async () => {
    setBusy(true);
    try {
      const data = await api<unknown>("/svc/");
      setResult({ ok: true, body: data === null ? "(the service answered, but not with JSON)" : JSON.stringify(data, null, 2) });
    } catch (err) {
      setResult(err instanceof ApiError ? { ok: false, status: err.status, message: err.message } : { ok: false, status: 0, message: "Request failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Service" description="The service this workspace is connected to" help={help}>
      <div className="grid-wide">
        <section className="card">
          <div className="card-head"><h2 className="card-title">Gateway</h2></div>
          <div className="card-pad stack">
            <dl className="dl">
              <dt>Base URL</dt>
              <dd><CopyChip value={`${window.location.origin}/svc/`} /></dd>
              <dt>Authentication</dt>
              <dd>Your session, or an API key in the Authorization header</dd>
              <dt>Forwarded as</dt>
              <dd><span className="mono">X-Rose-Tenant-Token</span>, valid for 60 seconds</dd>
            </dl>
            <figure className="figure">
              {help.diagram!.node}
              <figcaption>{help.diagram!.caption}</figcaption>
            </figure>
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h2 className="card-title grow">Try a request</h2>
            <Button icon="play" busy={busy} onClick={() => void tryIt()}>GET /svc/</Button>
          </div>
          <div className="card-pad stack">
            {result === null ? (
              <p className="muted">Sends a GET to the root of the service as you, and shows what comes back.</p>
            ) : result.ok ? (
              <>
                <Callout tone="ok">The service responded.</Callout>
                <CodeBlock>{result.body}</CodeBlock>
              </>
            ) : (
              <Callout tone="bad">{result.status ? `The request failed with status ${result.status}: ` : ""}{result.message}</Callout>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}
