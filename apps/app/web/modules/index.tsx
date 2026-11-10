// SPDX-License-Identifier: Apache-2.0
// Web module manifest, mirroring worker/modules/index.ts. A module that is listed here
// and installed on the server gets a menu entry and a route; nothing else needs editing.
import type { NavItem } from "@rose/ui";
import type { JSX } from "react";
import { ContactsPage } from "./contacts/ContactsPage";

export interface WebModule {
  /** Must equal the server module id. */
  id: string;
  nav: NavItem;
  path: string;
  component: () => JSX.Element;
  /** Permission required to see the page (the server enforces it on every call). */
  permission: string;
}

export const webModules: WebModule[] = [
  { id: "contacts", path: "/contacts", nav: { href: "/contacts", label: "Contacts", icon: "contact" }, component: ContactsPage, permission: "contacts:read" },
];
