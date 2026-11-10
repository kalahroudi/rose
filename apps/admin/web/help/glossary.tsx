// SPDX-License-Identifier: Apache-2.0
// One definition per term, used by every help panel so a word always means the same thing.
import type { ReactNode } from "react";

export const glossary = {
  tenant: "A customer of your product: one company or team. Each tenant has its own address, members, private database and encryption key.",
  workspace: "What a tenant is called inside the app their people use. Tenant and workspace are the same thing seen from two sides.",
  address: "The short name in a tenant's URL, for example acme in acme.example.com. It can not be changed later because sign-in cookies and passkeys are tied to it.",
  operator: "A member of your own staff who can use this console. Operators manage tenants but can not open tenant data.",
  platformOwner: "An operator who can also add or remove operators and change connections.",
  owner: "The person at the customer who controls a workspace: they can invite people, change roles and delete the workspace.",
  controlPlane: "The shared directory of who exists and who may sign in: tenants, people, memberships, domains. It never contains tenant business data.",
  privateDatabase: "A separate database for each tenant, held in its own Durable Object. Another tenant's rows are not in it at all, so no query can return them.",
  dataKey: "An encryption key unique to one tenant, used for its sensitive fields. It is stored inside that tenant's private database, wrapped by the master key.",
  suspended: "The tenant still exists but nobody can sign in or call its API. Nothing is deleted; resume it at any time.",
  deleting: "Deletion was confirmed. Sessions are cut immediately and a background task destroys the private database and its key.",
  customDomain: "A domain the customer owns (app.customer.com) that serves their workspace instead of the default address.",
  dnsRecord: "A line the customer adds at their DNS provider to prove they own the domain and to point it at your platform.",
  certificate: "What lets the browser show the padlock for a domain. Cloudflare issues and renews it automatically once DNS is correct.",
  job: "Work that runs in the background because it takes time or depends on something outside (DNS, deletion). It retries by itself.",
  auditLog: "A permanent list of who did what and when in this console. Tenants have their own, separate audit log.",
  passkey: "A sign-in credential stored on your device and unlocked with fingerprint, face or PIN. It only works on the site that created it, so it can not be phished.",
  signInCode: "A 6-digit code emailed to you. It works once, for 10 minutes, and only on the site that requested it.",
  guard: "A script (pnpm guard) that fails the build when code breaks a security rule, for example touching another tenant's data path.",
  isolationTest: "An automatic test run for every module that proves tenant B can not see or change what tenant A stored.",
} satisfies Record<string, ReactNode>;

export const terms = (...keys: (keyof typeof glossary)[]) =>
  keys.map((k) => ({ term: labels[k], def: glossary[k] }));

const labels: Record<keyof typeof glossary, string> = {
  tenant: "Tenant",
  workspace: "Workspace",
  address: "Address",
  operator: "Operator",
  platformOwner: "Platform owner",
  owner: "Workspace owner",
  controlPlane: "Control plane",
  privateDatabase: "Private database",
  dataKey: "Data key",
  suspended: "Suspended",
  deleting: "Deleting",
  customDomain: "Custom domain",
  dnsRecord: "DNS record",
  certificate: "Certificate",
  job: "Background task",
  auditLog: "Audit log",
  passkey: "Passkey",
  signInCode: "Sign-in code",
  guard: "Guard",
  isolationTest: "Isolation test",
};
