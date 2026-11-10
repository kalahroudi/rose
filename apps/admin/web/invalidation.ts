// SPDX-License-Identifier: Apache-2.0
// Which cached data each action makes stale. Add a line here when you add a mutation;
// this is what lets a drawer close and the result appear without a reload.
import { createInvalidator } from "@rose/ui";

export const touches = {
  "tenant.create": [["tenants"], ["overview"]],
  "tenant.update": [["tenants"], ["tenant"]],
  "tenant.status": [["tenants"], ["tenant"], ["overview"]],
  "tenant.delete": [["tenants"], ["tenant"], ["overview"], ["jobs"]],
  "tenant.owner": [["tenant-members"]],
  "domain.add": [["domains"], ["tenants"], ["overview"], ["jobs"]],
  "domain.recheck": [["domains"], ["jobs"]],
  "domain.remove": [["domains"], ["tenants"], ["overview"]],
  "operator.change": [["operators"], ["setup"], ["overview"]],
  "job.retry": [["jobs"], ["overview"]],
  "setup.change": [["setup"], ["overview"]],
  "profile.update": [["bootstrap"]],
} as const;

export const useInvalidate = createInvalidator(touches);
