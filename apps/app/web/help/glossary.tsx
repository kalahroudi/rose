// SPDX-License-Identifier: Apache-2.0
// Central glossary. A term means the same thing on every page: page help pulls its
// terminology from here instead of redefining it.
import type { ReactNode } from "react";

export const glossary = {
  workspace: "Your organisation's private space. It has its own address, its own members, its own database and its own encryption key. Nothing in it is shared with any other workspace.",
  address: "The web address of this workspace, such as acme.example.com. Sessions, cookies and passkeys are tied to this exact address.",
  member: "A person who can sign in to this workspace. Each member has exactly one role.",
  role: "What a member is allowed to do. Owner: everything, including deleting the workspace. Admin: manage members, API keys and settings. Member: work with the data.",
  owner: "A member with full control. A workspace always has at least one owner, and only owners can grant or remove owner access.",
  invitation: "A pending membership for an email address. The person joins by signing in with that address; there is no invitation link to forward or leak. Invitations expire after 7 days.",
  signInCode: "A 6-digit, single-use code sent by email. It expires after 10 minutes and locks after five wrong guesses.",
  passkey: "A sign-in credential kept by your device and unlocked with fingerprint, face or PIN. It only works on the address it was created for, so it can not be phished.",
  session: "Proof that a device is signed in. It lasts up to 7 days, works only on this workspace's address, and ends immediately if the member is removed.",
  apiKey: "A secret that lets a script, service or AI agent call this workspace's API. It works only for this workspace and acts with a fixed role.",
  auditLog: "A record of who did what and when in this workspace. It is stored inside the workspace's own database and is destroyed with it.",
  job: "Work that runs in the background because it may take a while, such as an import. You can keep working; the bell shows progress.",
  encryptedField: "A value that is encrypted with this workspace's key before it is stored. Even someone with a copy of the database can not read it.",
  blindIndex: "A keyed fingerprint of an encrypted value. It lets the server find an exact match without being able to read or partially search the value.",
  dataKey: "The encryption key that belongs to this workspace alone. Destroying it makes every encrypted value permanently unreadable.",
  contact: "A person or company you keep track of. Email and notes are encrypted fields.",
  gateway: "The /svc path of this workspace. Requests to it are forwarded to the connected service together with a signed statement of which workspace and member they come from.",
} satisfies Record<string, ReactNode>;

export type Term = keyof typeof glossary;

const names: Record<Term, string> = {
  workspace: "Workspace", address: "Workspace address", member: "Member", role: "Role", owner: "Owner", invitation: "Invitation",
  signInCode: "Sign-in code", passkey: "Passkey", session: "Session", apiKey: "API key", auditLog: "Audit log", job: "Background job",
  encryptedField: "Encrypted field", blindIndex: "Blind index", dataKey: "Data key", contact: "Contact", gateway: "Service gateway",
};

/** Build the Terminology section of a help panel from glossary keys. */
export const terms = (...keys: Term[]): { term: string; def: ReactNode }[] => keys.map((k) => ({ term: names[k], def: glossary[k] }));
