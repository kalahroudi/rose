// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, Badge, Button, CopyChip, DataTable, errorMessage, Flow, Gate, jobLabel, jobTone, Page, Select, Time, useListState, useToast, type Column, type HelpContent, type JobView, type PageData } from "@rose/ui";
import { terms } from "../help/glossary";
import { useInvalidate } from "../invalidation";

const TYPE_LABEL: Record<string, string> = { "tenant.purge": "Delete tenant data", "domain.verify": "Verify domain" };

export function ActivityPage() {
  const list = useListState(["status"]);
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useQuery({
    queryKey: ["jobs", list.query],
    queryFn: () => api<PageData<JobView> & { active: number }>(`/api/jobs?${list.query}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => ((query.state.data?.active ?? 0) > 0 ? 3000 : false),
  });

  const help: HelpContent = {
    what: "Work the platform does in the background: verifying custom domains and destroying the data of deleted tenants. Tasks run on the server, so they continue if you close this tab. The bell in the header shows the most recent ones on every page.",
    diagram: {
      node: <Flow title="Background task" steps={[{ label: "Queued", sub: "accepted" }, { label: "Running", sub: "up to 5 attempts", tone: "on" }, { label: "Done", sub: "result applied", tone: "ok" }, { label: "Failed", sub: "needs a retry", tone: "bad", via: "or" }]} />,
      caption: "A task that hits an error waits, then tries again. After five attempts it is marked Failed and waits for you.",
    },
    terms: terms("job", "customDomain", "deleting"),
    why: [
      { q: "Why are these not done instantly?", a: "They depend on things that take time: DNS changes made by a customer, or destroying a database. Running them in the background keeps the console responsive and makes them retry safely." },
      { q: "Is it safe to retry?", a: "Yes. Every task is written so that running it twice has the same result as running it once." },
    ],
  };

  const retry = async (j: JobView) => {
    try {
      await api(`/api/jobs/${j.id}/retry`, { method: "POST" });
      await invalidate("job.retry");
      toast.success("Queued to run again");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const columns: Column<JobView>[] = [
    { id: "title", header: "Task", cell: (j) => (<div><strong>{j.title}</strong><div className="hint">{TYPE_LABEL[j.type] ?? j.type}</div></div>) },
    { id: "status", header: "Status", width: "120px", cell: (j) => <Badge tone={jobTone(j.status)} running={j.status === "queued" || j.status === "running"}>{jobLabel(j.status)}</Badge> },
    { id: "detail", header: "Detail", cell: (j) => (j.error ? <span className={j.status === "failed" ? "err" : "muted"}>{j.error}</span> : <span className="muted">—</span>) },
    { id: "attempts", header: "Attempts", width: "100px", help: "How many times the task has run. Waiting for DNS counts as an attempt each time it checks.", cell: (j) => j.attempts },
    { id: "updated", header: "Updated", width: "140px", cell: (j) => <Time at={j.updatedAt} /> },
    { id: "id", header: "Reference", width: "150px", cell: (j) => <CopyChip value={j.id} display={j.id.slice(0, 12)} /> },
  ];

  return (
    <Page title="Activity" description="Background tasks and their results" help={help}>
      <Gate queries={[q]}>
        {() => (
          <DataTable
            list={list}
            data={q.data}
            fetching={q.isFetching}
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
            rowActions={(j) => (j.status === "failed" ? <Button size="sm" icon="refresh" onClick={() => void retry(j)}>Retry</Button> : null)}
            empty={{ icon: "activity", title: "No background tasks yet", body: "Tasks appear here when you add a custom domain or delete a tenant." }}
          />
        )}
      </Gate>
    </Page>
  );
}
