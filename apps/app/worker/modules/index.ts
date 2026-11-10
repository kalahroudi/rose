// SPDX-License-Identifier: Apache-2.0
// Module manifest. Add or remove a module here; nothing else needs to change on the server.
import type { ModuleDefinition } from "@rose/core";
import { contacts } from "./contacts";

export const modules: ModuleDefinition[] = [contacts];
