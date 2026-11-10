// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import type { Page } from "./api";
import { Icon, type IconName } from "./icons";
import { Button, EmptyState, formatNumber, Hint } from "./primitives";

export interface ListState {
  page: number;
  pageSize: number;
  q: string;
  sort: string;
  filters: Record<string, string>;
  /** Query string for the API call, and a stable cache key. */
  query: string;
  set(patch: Partial<{ page: number; pageSize: number; q: string; sort: string }> & { filters?: Record<string, string> }): void;
  reset(): void;
  active: boolean;
}

/**
 * List state that lives in the URL: search, filters, sort and page survive reload, are
 * shareable, and work with the back button. `filterKeys` names the extra query params.
 */
export function useListState(filterKeys: string[] = [], defaults: { pageSize?: number; sort?: string } = {}): ListState {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const keysRef = useRef(filterKeys);
  return useMemo(() => {
    const p = new URLSearchParams(search);
    const filters: Record<string, string> = {};
    for (const k of keysRef.current) filters[k] = p.get(k) ?? "";
    const state = {
      page: Math.max(1, Number(p.get("page")) || 1),
      pageSize: [10, 25, 50, 100].includes(Number(p.get("pageSize"))) ? Number(p.get("pageSize")) : defaults.pageSize ?? 25,
      q: p.get("q") ?? "",
      sort: p.get("sort") ?? defaults.sort ?? "",
      filters,
    };
    const api = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
    if (state.q) api.set("q", state.q);
    if (state.sort) api.set("sort", state.sort);
    for (const [k, v] of Object.entries(filters)) if (v) api.set(k, v);
    const write = (next: URLSearchParams) => navigate(`${location}${next.size ? `?${next}` : ""}`, { replace: true });
    return {
      ...state,
      query: api.toString(),
      active: !!state.q || Object.values(filters).some(Boolean),
      set(patch) {
        const next = new URLSearchParams(search);
        const put = (k: string, v: string | number | undefined, omit: string | number) => (v === undefined ? null : v === omit || v === "" ? next.delete(k) : next.set(k, String(v)));
        put("q", patch.q, "");
        put("sort", patch.sort, defaults.sort ?? "");
        put("pageSize", patch.pageSize, defaults.pageSize ?? 25);
        for (const [k, v] of Object.entries(patch.filters ?? {})) put(k, v, "");
        // Any change other than paging returns to the first page.
        put("page", patch.page ?? 1, 1);
        write(next);
      },
      reset() {
        const next = new URLSearchParams(search);
        for (const k of ["q", "page", ...keysRef.current]) next.delete(k);
        write(next);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, location, navigate, defaults.pageSize, defaults.sort]);
}

export interface Column<T> {
  id: string;
  header: string;
  /** Server sort key. Omit for unsortable columns. */
  sort?: string;
  /** One-line definition shown as a "?" beside the header. */
  help?: string;
  width?: string;
  cell(row: T): ReactNode;
}

export interface Selection {
  /** Ids ticked on the current page. Empty when `allMatching` is on. */
  ids: string[];
  /** True when the person chose "select all N matching": act on the filter, not on ids. */
  allMatching: boolean;
  count: number;
  clear(): void;
}

export interface DataTableProps<T> {
  list: ListState;
  data: Page<T> | undefined;
  fetching?: boolean;
  columns: Column<T>[];
  rowKey(row: T): string;
  onRowClick?(row: T): void;
  searchPlaceholder?: string;
  /** Set false when the endpoint has no text search; the box is then not shown. */
  searchable?: boolean;
  /** Filter controls shown beside the search box. */
  filters?: ReactNode;
  /** Buttons at the right of the toolbar. */
  toolbar?: ReactNode;
  /** Enables row checkboxes and renders the bulk-action bar. */
  bulkActions?(selection: Selection): ReactNode;
  rowActions?(row: T): ReactNode;
  empty: { icon?: IconName; title: string; body?: string; action?: ReactNode };
  /** Row to highlight briefly, e.g. the one just created. */
  freshKey?: string | null;
  noun?: [singular: string, plural: string];
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string }) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => latest.current(text), 250);
    return () => clearTimeout(t);
  }, [text, value]);
  return (
    <div className="search">
      <Icon name="search" />
      <input className="input input-sm" type="search" maxLength={40} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}

/**
 * Server-driven table: the server paginates, filters, searches and sorts. The browser
 * only ever holds one page. The previous page stays visible (dimmed) while the next loads.
 */
export function DataTable<T>({ list, data, fetching, columns, rowKey, onRowClick, searchPlaceholder = "Search", searchable = true, filters, toolbar, bulkActions, rowActions, empty, freshKey, noun = ["item", "items"] }: DataTableProps<T>) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageKeys = useMemo(() => rows.map(rowKey), [rows, rowKey]);
  const clear = useCallback(() => (setIds(new Set()), setAllMatching(false)), []);
  // Selection never silently carries over to a different result set.
  useEffect(clear, [list.query, clear]);

  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => ids.has(k));
  const someOnPage = pageKeys.some((k) => ids.has(k));
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = someOnPage && !allOnPage;
  }, [someOnPage, allOnPage]);

  const selection: Selection = { ids: allMatching ? [] : [...ids], allMatching, count: allMatching ? total : ids.size, clear };
  const from = total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const to = Math.min(total, list.page * list.pageSize);
  const pages = Math.max(1, Math.ceil(total / list.pageSize));
  const plural = (n: number) => `${formatNumber(n)} ${n === 1 ? noun[0] : noun[1]}`;

  return (
    <div>
      <div className="toolbar">
        {searchable ? <SearchBox value={list.q} onChange={(q) => list.set({ q })} placeholder={searchPlaceholder} /> : null}
        {filters}
        {list.active ? <Button variant="ghost" size="sm" onClick={list.reset}>Clear filters</Button> : null}
        <div className="right row">{toolbar}</div>
      </div>
      <div className="table-wrap">
        {bulkActions && selection.count > 0 ? (
          <div className="bulkbar" role="region" aria-label="Bulk actions">
            <strong>{plural(selection.count)} selected</strong>
            {!allMatching && allOnPage && total > rows.length ? (
              <button type="button" className="link" onClick={() => setAllMatching(true)}>
                Select all {formatNumber(total)} matching
              </button>
            ) : null}
            <div className="right row">
              {bulkActions(selection)}
              <Button variant="ghost" size="sm" onClick={clear}>Clear</Button>
            </div>
          </div>
        ) : null}
        <div className="table-scroll" data-fetching={!!fetching && !!data}>
          {rows.length === 0 ? (
            list.active ? (
              <EmptyState icon="search" title="No results" action={<Button onClick={list.reset}>Clear filters</Button>}>
                Nothing matches your search or filters.
              </EmptyState>
            ) : (
              <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>{empty.body}</EmptyState>
            )
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {bulkActions ? (
                    <th className="col-check">
                      <input
                        ref={headBox}
                        type="checkbox"
                        className="checkbox"
                        aria-label="Select all on this page"
                        checked={allOnPage}
                        onChange={(e) => {
                          setAllMatching(false);
                          setIds(e.target.checked ? new Set(pageKeys) : new Set());
                        }}
                      />
                    </th>
                  ) : null}
                  {columns.map((c) => {
                    const dir = c.sort && list.sort === c.sort ? "asc" : c.sort && list.sort === `-${c.sort}` ? "desc" : undefined;
                    return (
                      <th key={c.id} style={c.width ? { width: c.width } : undefined} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
                        <span className="row" >
                          {c.sort ? (
                            <button type="button" className="th-sort" data-dir={dir} onClick={() => list.set({ sort: dir === "asc" ? `-${c.sort}` : c.sort })}>
                              {c.header}
                              <Icon name="arrowUp" />
                            </button>
                          ) : (
                            c.header
                          )}
                          {c.help ? <Hint text={c.help} /> : null}
                        </span>
                      </th>
                    );
                  })}
                  {rowActions ? <th className="col-actions"><span className="sr-only">Actions</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = rowKey(row);
                  const selected = allMatching || ids.has(key);
                  return (
                    <tr key={key} data-selected={selected} data-clickable={!!onRowClick} data-fresh={freshKey === key} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                      {bulkActions ? (
                        <td className="col-check" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="checkbox"
                            aria-label="Select row"
                            checked={selected}
                            onChange={(e) => {
                              const next = new Set(allMatching ? pageKeys : ids);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              setAllMatching(false);
                              setIds(next);
                            }}
                          />
                        </td>
                      ) : null}
                      {columns.map((c) => (
                        <td key={c.id}>{c.cell(row)}</td>
                      ))}
                      {rowActions ? (
                        <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                          <span className="row">{rowActions(row)}</span>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {total > 0 ? (
          <div className="table-foot">
            <span>
              {formatNumber(from)}–{formatNumber(to)} of {plural(total)}
            </span>
            <label className="row right">
              Rows
              <select className="select" value={list.pageSize} onChange={(e) => list.set({ pageSize: Number(e.target.value) })} aria-label="Rows per page">
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <Button size="sm" disabled={list.page <= 1} onClick={() => list.set({ page: list.page - 1 })}>Previous</Button>
              <span className="nowrap">Page {list.page} of {formatNumber(pages)}</span>
              <Button size="sm" disabled={list.page >= pages} onClick={() => list.set({ page: list.page + 1 })}>Next</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
