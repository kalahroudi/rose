// SPDX-License-Identifier: Apache-2.0
import { Flow, type HelpContent } from "@rose/ui";
import { terms } from "../../help/glossary";

export function contactsHelp(actions: { create?(): void; importCsv?(): void }): HelpContent {
  return {
    what: "The people and companies this workspace keeps track of. Names and companies are stored as plain text so they can be searched; email addresses and notes are encrypted.",
    diagram: {
      node: <Flow title="How an email address is stored and found" steps={[{ label: "You type", sub: "ada@example.com" }, { label: "Encrypted", sub: "workspace key", tone: "on", via: "saved as" }, { label: "Blind index", sub: "keyed fingerprint", via: "plus" }, { label: "Exact match", sub: "search by full email", tone: "ok" }]} />,
      caption: "The database holds only ciphertext and a fingerprint. Searching compares fingerprints, which is why a full address matches and part of one does not.",
    },
    terms: [...terms("contact", "encryptedField", "blindIndex", "dataKey", "job"), { term: "Status", def: "Lead: someone new. Active: someone you work with. Archived: kept for the record, hidden from day-to-day lists." }],
    why: [
      { q: "Why can I search part of a name but only a full email address?", a: "Email is encrypted, so the server can not look inside it. It can only check whether the fingerprint of what you typed equals a stored fingerprint, which needs the whole address." },
      { q: "Why is importing a background job?", a: "A large paste can take a while to encrypt and store. Running it in the background keeps the page responsive, retries on failure, and tells you through the bell when it is done." },
      { q: "Why can members edit but not delete?", a: "Deleting is permanent. It is limited to owners and admins; members can archive instead, which is reversible." },
    ],
    tasks: [
      { label: "Add a contact", run: actions.create },
      { label: "Import contacts from CSV", run: actions.importCsv, detail: "One contact per line: name,email,company." },
      { label: "Act on many contacts at once", detail: "Tick rows, or tick the header box and choose “Select all matching” to include every page." },
    ],
  };
}
