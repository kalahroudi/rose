// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, Badge, DataTable, Flow, Gate, jobLabel, jobTone, Page, Select, Time, useListState, type Column, type HelpContent, type JobView, type PageData } from "@rose/ui";
import { terms } from "../help/glossary";

const help: HelpContent = {
  what: "Every long-running task started in this workspace, such as a contact import. Tasks run on the server, so you can close the page or keep working while they finish.",
  diagram: {
    node: <Flow title="Life of a background job" steps={[{ label: "Queued", sub: "accepted" }, { label: "Running", sub: "picked up", tone: "on" }, { label: "Done", sub: "result saved", tone: "ok" }, { label: "Failed", sub: "after 5 tries", tone: "bad", via: "or" }]} />,
    caption: "A job that hits an error is retried with increasing delays. After five attempts it is marked Failed and shows the last error.",
  },
  terms: terms("job"),
  why: [
    { q: "Why are some actions jobs instead of happening instantly?", a: "Anything that may take more than a moment would otherwise freeze the form you submitted it from and could be cut off half-way. As a job it runs to completion on the server, is retried on failure, and reports back through the bell." },
    { q: "Why can I only see this workspace's jobs?", a: "A job runs for the workspace that queued it and has no way to reach another one. The list is filtered the same way." },
  ],
  tasks: [{ label: "See what went wrong", detail: "Filter by Failed. The Error column shows the last message." }],
};

const columns: Column<JobView>[] = [
  { id: "title", header: "Task", cell: (j) => <strong>{j.title}</strong> },
  { id: "status", header: "Status", help: "Queued: waiting to start. Running: in progress. Done: finished. Failed: gave up after 5 attempts.", cell: (j) => <Badge tone={jobTone(j.status)} running={j.status === "queued" || j.status === "running"}>{jobLabel(j.status)}</Badge> },
  { id: "attempts", header: "Attempts", help: "How many times the task has been started. More than 1 means it was retried.", cell: (j) => j.attempts },
  { id: "error", header: "Error", cell: (j) => (j.error ? <span className="dim">{j.error}</span> : <span className="muted">None</span>) },
  { id: "created", header: "Started", cell: (j) => <Time at={j.createdAt} /> },
  { id: "updated", header: "Last update", cell: (j) => <Time at={j.updatedAt} /> },
];

export function ActivityPage() {
  const list = useListState(["status"]);
  const jobs = useQuery({ queryKey: ["jobs", list.query], queryFn: () => api<PageData<JobView>>(`/api/jobs?${list.query}`), placeholderData: keepPreviousData });
  return (
    <Page title="Activity" description="Background tasks started in this workspace" help={help}>
      <Gate queries={[jobs]}>
        {() => (
          <DataTable
            list={list}
            data={jobs.data}
            fetching={jobs.isFetching}
            columns={columns}
            rowKey={(j) => j.id}
            noun={["task", "tasks"]}
            searchable={false}
            filters={
              <Select aria-label="Status" value={list.filters.status} onChange={(e) => list.set({ filters: { status: e.target.value } })}>
                <option value="">All statuses</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="succeeded">Done</option>
                <option value="failed">Failed</option>
              </Select>
            }
            empty={{ icon: "activity", title: "No background tasks yet", body: "Tasks such as contact imports appear here while they run and after they finish." }}
          />
        )}
      </Gate>
    </Page>
  );
}
