// SPDX-License-Identifier: Apache-2.0
import { useQueryClient } from "@tanstack/react-query";
import { AuthLayout, Callout, SignIn } from "@rose/ui";
import { rootUrl } from "../session";
import type { Bootstrap, TenantView } from "../types";

function RootLink({ boot, children }: { boot: Bootstrap; children: string }) {
  return <a className="link" href={rootUrl(boot.app.baseDomain)}>{children}</a>;
}

export function SignInScreen({ boot, tenant }: { boot: Bootstrap; tenant: TenantView }) {
  const qc = useQueryClient();
  return (
    <AuthLayout appName={boot.app.name} footer={<>Not your workspace? <RootLink boot={boot}>Find your workspaces</RootLink></>}>
      <SignIn
        base="/api/auth"
        passkeys
        links
        title={`Sign in to ${tenant.name}`}
        subtitle={<>You are signing in at <span className="mono">{window.location.host}</span>. Only members of this workspace can sign in here.</>}
        onDone={() => void qc.invalidateQueries({ queryKey: ["bootstrap"] })}
      />
    </AuthLayout>
  );
}

export function UnknownScreen({ boot }: { boot: Bootstrap }) {
  return (
    <AuthLayout appName={boot.app.name}>
      <div>
        <h1>No workspace at this address</h1>
        <p className="page-desc">
          Nothing is registered at <span className="mono">{window.location.host}</span>. Check the address for typos, or sign in to see the workspaces you belong to.
        </p>
      </div>
      <a className="btn btn-primary btn-lg btn-block" href={rootUrl(boot.app.baseDomain)}>Find your workspaces</a>
    </AuthLayout>
  );
}

export function SuspendedScreen({ boot, tenant }: { boot: Bootstrap; tenant: TenantView }) {
  return (
    <AuthLayout appName={boot.app.name} footer={<RootLink boot={boot}>Go to your other workspaces</RootLink>}>
      <div>
        <h1>This workspace is suspended</h1>
        <p className="page-desc">
          <strong>{tenant.name}</strong> has been suspended by the platform operator. Nobody can sign in and API keys do not work until it is resumed. Your data has not been deleted.
        </p>
      </div>
      <Callout tone="warn">Contact support to find out why and to have the workspace resumed.</Callout>
    </AuthLayout>
  );
}

export function DeletedScreen({ boot, slug, deleteAfter }: { boot: Bootstrap; slug: string; deleteAfter: number | null }) {
  return (
    <AuthLayout appName={boot.app.name}>
      <div>
        <h1>Workspace scheduled for deletion</h1>
        <p className="page-desc">
          <span className="mono">{slug}</span> is closed and everyone has been signed out. For safety its data is kept for 48 hours, then automatically and permanently destroyed
          {deleteAfter ? <> (on <strong>{new Date(deleteAfter).toLocaleString()}</strong>)</> : null}. If this was a mistake, contact support before then.
        </p>
      </div>
      <a className="btn btn-lg btn-block" href={rootUrl(boot.app.baseDomain)}>Back to {boot.app.name}</a>
    </AuthLayout>
  );
}
