// SPDX-License-Identifier: Apache-2.0
// The single place that says which cached data each action makes stale.
// After a mutation: `await invalidate("contact.create")`. Add a line here for every new action.
import { createInvalidator } from "@rose/ui";

export const touches = {
  "contact.create": [["contacts"], ["overview"]],
  "contact.update": [["contacts"]],
  "contact.delete": [["contacts"], ["overview"]],
  "contact.bulk": [["contacts"], ["overview"]],
  "contact.import": [["jobs"]],
  "member.role": [["members"], ["audit"]],
  "member.remove": [["members"], ["overview"], ["audit"]],
  "invitation.create": [["invitations"], ["overview"], ["audit"]],
  "invitation.revoke": [["invitations"], ["overview"], ["audit"]],
  "apikey.create": [["api-keys"], ["overview"], ["audit"]],
  "apikey.revoke": [["api-keys"], ["overview"], ["audit"]],
  "workspace.rename": [["bootstrap"], ["audit"]],
  "profile.update": [["bootstrap"], ["members"]],
  "passkey.add": [["bootstrap"], ["auth"]],
} as const;

export const useInvalidate = createInvalidator(touches);
