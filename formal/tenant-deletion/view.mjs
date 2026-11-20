// SPDX-License-Identifier: Apache-2.0
/** Statechart view for TenantDeletion.tla — labels in product words, not TLA names. */

export const title = "Rose workspace deletion";

export const colors = {
  live: "teal",
  scheduled: "orange",
  wiping: "pink",
  gone: "purple",
  mixed: "yellow",
};

function tenantLabel(status, storage) {
  if (status === "gone" || storage === false) return "Gone";
  if (status === "deleting") return "Wiping";
  if (status === "pending_deletion") return "Scheduled";
  if (status === "suspended") return "Suspended";
  return "Live";
}

/** One label for the pair of tenants so the chart stays small. */
export function state(v) {
  const a = tenantLabel(v.status.t1, v.storage.t1);
  const b = tenantLabel(v.status.t2, v.storage.t2);
  if (a === b) return `Both ${a.toLowerCase()}`;
  return `${a} / ${b}`;
}

export function group(v) {
  const labels = [v.status.t1, v.status.t2];
  if (labels.every((s) => s === "gone")) return "gone";
  if (labels.some((s) => s === "deleting")) return "wiping";
  if (labels.some((s) => s === "pending_deletion")) return "scheduled";
  if (labels.some((s) => s === "suspended") && labels.some((s) => s === "active")) return "mixed";
  if (labels.every((s) => s === "suspended")) return "mixed";
  return "live";
}

export function step(action, _from, _to) {
  if (action === "Tick") return "time passes";
  if (action === "Done") return null;
  if (action.startsWith("Suspend")) return "operator suspends a workspace";
  if (action.startsWith("Resume")) return "operator resumes a workspace";
  if (action.startsWith("RequestDeletion")) return "owner schedules deletion";
  if (action.startsWith("ReRequestDeletion")) return null;
  if (action.startsWith("CancelDeletion")) return "owner cancels deletion";
  if (action.startsWith("PurgeForgedOrStale")) return "purge job hits a live workspace [refused]";
  if (action.startsWith("PurgeTooEarly")) return "purge job runs before the deadline [refused]";
  if (action.startsWith("BeginPurge")) return "grace ended; purge begins";
  if (action.startsWith("DestroyAndWipe")) return "private database destroyed";
  if (action.startsWith("PurgeAlreadyGone")) return null;
  return action;
}
