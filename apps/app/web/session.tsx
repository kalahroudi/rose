// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from "react";
import type { Bootstrap, SessionView, TenantView } from "./types";

export interface Workspace {
  boot: Bootstrap;
  tenant: TenantView;
  session: SessionView;
  /** UI hint only: the server enforces every permission again. */
  can(permission: string): boolean;
  /** Called after the workspace has been scheduled for deletion. */
  markDeleted(): void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside the signed-in shell");
  return ctx;
}

/** URL of the platform's root host (sign-up and workspace finder), on the same scheme and port. */
export function rootUrl(baseDomain: string): string {
  return `${window.location.protocol}//${baseDomain}${window.location.port ? `:${window.location.port}` : ""}`;
}

export const roleLabel = (role: string): string => ({ owner: "Owner", admin: "Admin", member: "Member" })[role] ?? role;
