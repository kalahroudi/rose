# Building UI

Both apps (`apps/admin/web`, `apps/app/web`) are React SPAs built from one kit,
`packages/ui` (`@rose/ui`). Every screen is assembled from the same few parts, which is
what keeps the product consistent. Build pages from these parts; do not hand-roll a
layout, a modal or a table.

## The rules

| Rule | How the kit enforces or supports it |
|---|---|
| Sticky nav that never scrolls; main pane scrolls and uses full width | `Shell` |
| Nav collapses to an icon rail (press `[`), icons stay links | `Shell` |
| Every page has the same header: title, description, help, actions, tabs | `Page` |
| Sub-navigation is tabs, mirrored in `?tab=` | `useTab` + `Page` |
| Nothing renders half-loaded | `Gate` |
| Actions happen in a right-side drawer; success closes it, no reload | `FormDrawer`, `Drawer` |
| Lists are paginated, searched, sorted and filtered by the server | `useListState` + `DataTable` |
| Select all on a page, or all matching the filter | `DataTable` `bulkActions` |
| Data loss needs the typed name; other actions a plain confirm | `useConfirm().danger`, `useConfirm()` |
| Copy icon beside anything copyable | `Copy`, `CopyChip`, `CodeBlock` |
| Third-party links open a new tab or a side preview | `ExternalLink`, help `links` |
| Rare options are folded away | `Advanced` |
| Every page and tab explains itself | `Page help={…}` (required prop) |
| Light, dark, system | `ThemeToggle`, CSS tokens |
| Long work is a background job with notifications | bell in `Shell`, `ctx.enqueue` on the server |

## Anatomy of a page

```tsx
// SPDX-License-Identifier: Apache-2.0
export function InvoicesPage() {
  const list = useListState(["status"]);            // search/sort/page/filters live in the URL
  const invalidate = useInvalidate();               // from web/invalidation.ts
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ["invoices", list.query],
    queryFn: () => api<PageData<Invoice>>(`/api/m/invoices?${list.query}`),
    placeholderData: keepPreviousData,              // previous page stays visible while the next loads
  });

  return (
    <Page title="Invoices" description="…" help={help}
          actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New invoice</Button>}>
      <Gate queries={[q]}>
        {() => <DataTable list={list} data={q.data} fetching={q.isFetching} columns={columns}
                          rowKey={(r) => r.id} empty={{ title: "No invoices yet" }} />}
      </Gate>
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New invoice"
                  initial={{ number: "" }} submitLabel="Create invoice"
                  onSubmit={async (v) => {
                    await api("/api/m/invoices", { body: v });
                    await invalidate("invoice.create");   // lists refetch; the row appears
                    toast.success("Invoice created");
                  }}>
        {(f) => <Field label="Number" error={f.errors.number}>{(p) => <Input {...p} {...f.text("number")} />}</Field>}
      </FormDrawer>
    </Page>
  );
}
```

Working references: `apps/app/web/modules/contacts/ContactsPage.tsx` (tenant app) and
`apps/admin/web/pages/Tenants.tsx` (admin).

## Adding a page for a module (tenant app)

1. Create `apps/app/web/modules/<id>/<Name>Page.tsx` and a `help.tsx` beside it.
2. Register it in `apps/app/web/modules/index.tsx` (nav entry, path, component, the
   permission that shows it). The shell builds navigation and routes from this manifest.
3. Add one line per mutation to `apps/app/web/invalidation.ts`.
4. Add the page's terms to `apps/app/web/help/glossary.tsx` so a word means the same
   thing everywhere.

## Data and caching

- **All requests go through `api()`** (same-origin JSON). The guard rejects `fetch` to
  absolute URLs from UI code.
- **Client cache**: TanStack Query, configured by `createQueryClient()`: 30s freshness,
  de-duplicated requests, a 401 anywhere re-checks the session. List keys are
  `[resource, list.query]`; detail keys `[resource, id]`.
- **Invalidation**: `web/invalidation.ts` maps each action to the query keys it makes
  stale. Call `await invalidate("action")` after every mutation. This is what makes
  "close the drawer and see the result" work.
- **HTTP**: API GETs carry an `ETag` and `Cache-Control: private, no-cache`, so
  revalidation is a cheap 304. Hashed assets are cached for a year.
- **Jobs**: the bell polls `/api/jobs` (every 2.5s while something runs, every 20s
  otherwise). When a job settles it toasts and refetches what is on screen. This is
  polling, not server-sent events.

## Help content

`Page` requires a `help` object (`HelpContent`): `what`, `terms`, `why`, `tasks`,
`diagram`, `links`. Pass the active tab's help when a page has tabs. Use `Flow` for
pipelines and lifecycles (it stacks vertically beyond three steps so it stays readable in
a drawer) and `IsolationDiagram` for the tenancy picture. Diagrams use theme variables and
real text, so they follow dark mode and are readable by assistive technology.

## Forms

`FormDrawer` owns submit state, server field errors (focus moves to the first invalid
field), a dirty-check before closing, and Enter-to-submit. Props worth knowing:
`validate` for instant client checks, `loading` while an edited record is fetched,
`extraActions` for a secondary footer action such as Delete.

## Styling

Plain CSS in `packages/ui/src/styles.css`, driven by tokens (`--surface`, `--text`,
`--ac`, `--ok`, `--warn`, `--bad`, …) defined for light and dark. Brand colour lives in
`packages/ui/src/brand.css` and is rewritten by `pnpm brand`. The content security policy
is `script-src 'self'; style-src 'self'`: no inline scripts or `<style>` tags. React
`style={{…}}` props are fine. Icons are inline SVG from `Icon` (one set, `currentColor`).

## Known limits

- No component tests yet; the UI is verified by type checks, the build, and manual
  browser walkthroughs.
- `useTab` drops other query parameters when switching tabs (intended for list state).
- The side preview for references depends on the target site allowing embedding; the
  header link is the fallback.
