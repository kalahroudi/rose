// SPDX-License-Identifier: Apache-2.0
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { api, ApiError, errorMessage, type Page as PageOf } from "./api";
import { Icon, Logo, type IconName } from "./icons";
import { Drawer, PreviewDrawer, useToast } from "./overlay";
import { Badge, Button, CopyChip, ExternalLink, IconButton, Time, type Tone } from "./primitives";

// ── Theme ─────────────────────────────────────────────────────────────────────

type Theme = "light" | "dark" | "system";
const THEME_KEY = "rose.theme";

function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  const options: [Theme, IconName, string][] = [["light", "sun", "Light"], ["system", "monitor", "Match system"], ["dark", "moon", "Dark"]];
  if (compact) {
    const next: Theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    const cur = options.find((o) => o[0] === theme)!;
    return <IconButton icon={cur[1]} label={`Theme: ${cur[2]}. Click to change.`} onClick={() => setTheme(next)} />;
  }
  return (
    <div className="seg" role="group" aria-label="Theme">
      {options.map(([value, icon, label]) => (
        <button key={value} type="button" aria-pressed={theme === value} aria-label={label} title={label} onClick={() => setTheme(value)}>
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  section?: string;
  /** Warm the cache when the pointer rests on the item. */
  prefetch?(): void;
}

export interface JobView {
  id: string;
  type: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface ShellProps {
  brand: { name: string; sub?: string };
  nav: NavItem[];
  user: { email: string; name?: string };
  onSignOut(): void;
  /** Background-task feed for the notification bell. */
  jobs?: { path: string; href: string };
  children: ReactNode;
}

const ShellContext = createContext<{ bell: ReactNode }>({ bell: null });
const COLLAPSE_KEY = "rose.nav.collapsed";

export const jobTone = (s: JobView["status"]): Tone => (s === "succeeded" ? "ok" : s === "failed" ? "bad" : "info");
export const jobLabel = (s: JobView["status"]): string => ({ queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed" })[s];

/**
 * Notification center. Long tasks run as background jobs on the server; this polls their
 * state (fast while something is running, slowly otherwise), announces completions, and
 * refreshes the page's data so finished work appears without a reload.
 */
function JobsBell({ path, href }: { path: string; href: string }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const wrap = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["jobs", "bell"],
    queryFn: () => api<PageOf<JobView> & { active: number }>(`${path}?pageSize=8`),
    refetchInterval: (query) => ((query.state.data?.active ?? 0) > 0 ? 2500 : 20_000),
    placeholderData: keepPreviousData,
  });
  const seen = useRef<Map<string, JobView["status"]> | null>(null);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    const prev = seen.current;
    const next = new Map(q.data.items.map((j) => [j.id, j.status]));
    seen.current = next;
    if (!prev) return;
    let settled = false;
    for (const j of q.data.items) {
      const before = prev.get(j.id);
      const wasActive = before === "queued" || before === "running" || (before === undefined && Date.now() - j.createdAt < 60_000);
      if (wasActive && j.status === "succeeded") (toast.success(`${j.title}: done`), (settled = true));
      if (wasActive && j.status === "failed") (toast.error(`${j.title} failed${j.error ? `: ${j.error}` : ""}`), (settled = true));
    }
    if (settled) {
      setUnread(true);
      // A finished job may have changed anything; refetch whatever is on screen.
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "jobs" || query.queryKey[1] !== "bell" });
    }
  }, [q.data, toast, qc]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => (document.removeEventListener("mousedown", away), document.removeEventListener("keydown", esc));
  }, [open]);
  const active = q.data?.active ?? 0;
  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <IconButton icon="bell" label={active > 0 ? `Activity: ${active} running` : "Activity"} aria-expanded={open} onClick={() => (setOpen((o) => !o), setUnread(false))}>
        {active > 0 || unread ? <span className="pip" /> : null}
      </IconButton>
      {open ? (
        <div className="popover" role="dialog" aria-label="Recent activity">
          <div className="popover-head">
            Recent activity
            <Link href={href} className="link right" onClick={() => setOpen(false)}>View all</Link>
          </div>
          {q.data?.items.length ? (
            q.data.items.map((j) => (
              <div className="job" key={j.id}>
                <div className="grow">
                  <div className="truncate">{j.title}</div>
                  <div className="hint">{j.status === "failed" && j.error ? j.error : <Time at={j.updatedAt} />}</div>
                </div>
                <Badge tone={jobTone(j.status)} running={j.status === "running" || j.status === "queued"}>{jobLabel(j.status)}</Badge>
              </div>
            ))
          ) : (
            <div className="job muted">Nothing yet. Long-running tasks show up here while they work.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function initials(user: { email: string; name?: string }): string {
  const src = (user.name || user.email).trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The application frame: a sticky navigation that never scrolls, beside a main pane that
 * does. The nav collapses to an icon rail (press `[`), where every icon is still a link.
 */
export function Shell({ brand, nav, user, onSignOut, jobs, children }: ShellProps) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      return saved === null ? window.innerWidth < 960 : saved === "1";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !c;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "[" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) toggle();
    };
    const mq = matchMedia("(max-width: 760px)");
    const onNarrow = () => mq.matches && setCollapsed(true);
    onNarrow();
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onNarrow);
    return () => (document.removeEventListener("keydown", onKey), mq.removeEventListener("change", onNarrow));
  }, [toggle]);

  const isActive = (href: string) => (href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`));
  let lastSection: string | undefined;

  return (
    <div className="shell" data-collapsed={collapsed}>
      <nav className="nav" aria-label="Main">
        <Link href="/" className="nav-brand">
          <Logo />
          <span className="nav-brand-text">
            <div className="nav-brand-name truncate">{brand.name}</div>
            {brand.sub ? <div className="nav-brand-sub truncate">{brand.sub}</div> : null}
          </span>
        </Link>
        <div className="nav-list">
          {nav.map((item) => {
            const head = item.section && item.section !== lastSection ? <div className="nav-section" key={`s-${item.section}`}>{item.section}</div> : null;
            lastSection = item.section;
            return (
              <div key={item.href} style={{ display: "contents" }}>
                {head}
                <Link href={item.href} className="nav-item" aria-current={isActive(item.href) ? "page" : undefined} data-tip={item.label} onMouseEnter={item.prefetch} onFocus={item.prefetch}>
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                </Link>
              </div>
            );
          })}
        </div>
        <div className="nav-foot">
          <div className="nav-user">
            <span className="avatar" title={user.email}>{initials(user)}</span>
            <span className="nav-label grow truncate" title={user.email}>{user.name || user.email}</span>
          </div>
          <button type="button" className="nav-item" data-tip="Sign out" onClick={onSignOut}>
            <Icon name="logout" />
            <span className="nav-label">Sign out</span>
          </button>
          <button type="button" className="nav-item" data-tip="Expand menu  [" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? "Expand menu" : "Collapse menu"}>
            <Icon name="panel" />
            <span className="nav-label grow">Collapse</span>
            <kbd className="nav-label muted mono">[</kbd>
          </button>
        </div>
      </nav>
      <ShellContext.Provider value={{ bell: jobs ? <JobsBell {...jobs} /> : null }}>
        <div className="main">{children}</div>
      </ShellContext.Provider>
    </div>
  );
}

// ── Help ──────────────────────────────────────────────────────────────────────

export interface HelpContent {
  /** What this section is, in one or two plain sentences. */
  what: ReactNode;
  /** Terms used on this page. Keep definitions identical across the app (see glossary). */
  terms?: { term: string; def: ReactNode }[];
  /** Why things work the way they do. */
  why?: { q: string; a: ReactNode }[];
  /** Short how-tos. `run` opens the relevant drawer. */
  tasks?: { label: string; detail?: string; run?(): void }[];
  diagram?: { node: ReactNode; caption: string };
  /** Third-party references: open in a new tab or preview beside the page. */
  links?: { label: string; href: string }[];
}

function HelpDrawer({ title, help, open, onClose }: { title: string; help: HelpContent; open: boolean; onClose(): void }) {
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <>
      <Drawer open={open && !preview} onClose={onClose} title={`Help: ${title}`} size="md">
        <section className="help-section">
          <h4>What this is</h4>
          <p>{help.what}</p>
        </section>
        {help.diagram ? (
          <figure className="figure">
            {help.diagram.node}
            <figcaption>{help.diagram.caption}</figcaption>
          </figure>
        ) : null}
        {help.terms?.length ? (
          <section className="help-section">
            <h4>Terminology</h4>
            <dl style={{ margin: 0 }}>
              {help.terms.map((t) => (
                <div className="term" key={t.term}>
                  <dt>{t.term}</dt>
                  <dd>{t.def}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {help.why?.length ? (
          <section className="help-section">
            <h4>Why it works this way</h4>
            {help.why.map((w, i) => (
              <details className="why" key={w.q} open={i === 0}>
                <summary>{w.q}</summary>
                <p>{w.a}</p>
              </details>
            ))}
          </section>
        ) : null}
        {help.tasks?.length ? (
          <section className="help-section">
            <h4>Common tasks</h4>
            <ul className="list-plain stack-sm">
              {help.tasks.map((t) => (
                <li key={t.label}>
                  {t.run ? (
                    <button type="button" className="link" onClick={() => (onClose(), t.run!())}>
                      {t.label}
                      <Icon name="chevron" />
                    </button>
                  ) : (
                    <strong>{t.label}</strong>
                  )}
                  {t.detail ? <div className="hint">{t.detail}</div> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {help.links?.length ? (
          <section className="help-section">
            <h4>References</h4>
            <ul className="list-plain stack-sm">
              {help.links.map((l) => (
                <li key={l.href} className="row-wrap">
                  <ExternalLink href={l.href}>{l.label}</ExternalLink>
                  <button type="button" className="link muted" onClick={() => setPreview(l.href)}>Preview here</button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Drawer>
      <PreviewDrawer url={preview} onClose={() => setPreview(null)} />
    </>
  );
}

// ── Page template ─────────────────────────────────────────────────────────────

export interface TabDef {
  id: string;
  label: string;
  count?: number;
  prefetch?(): void;
}

/** Active tab, mirrored in `?tab=` so it is linkable and survives reload. */
export function useTab<T extends string>(ids: readonly T[]): [T, (id: T) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const raw = new URLSearchParams(search).get("tab") as T | null;
  const active = raw && ids.includes(raw) ? raw : ids[0]!;
  // Switching tabs drops the previous tab's list state (search, page, filters).
  const set = useCallback((id: T) => navigate(id === ids[0] ? location : `${location}?tab=${id}`, { replace: true }), [ids, location, navigate]);
  return [active, set];
}

export interface PageProps {
  title: string;
  description?: string;
  /** Help for this page (or for the active tab). Every page must provide it. */
  help: HelpContent;
  /** Primary action(s), top right. */
  actions?: ReactNode;
  tabs?: TabDef[];
  tab?: string;
  onTab?(id: string): void;
  children: ReactNode;
}

/** Every page uses this template: pinned header (title, description, help, actions, tabs) over a scrolling body. */
export function Page({ title, description, help, actions, tabs, tab, onTab, children }: PageProps) {
  const { bell } = useContext(ShellContext);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <>
      <header className="page-head">
        <div className="page-head-top">
          <div className="grow">
            <h1 className="page-title truncate">{title}</h1>
            {description ? <p className="page-desc truncate">{description}</p> : null}
          </div>
          <div className="row">
            {actions}
            {bell}
            <IconButton icon="help" label="Help for this page" onClick={() => setHelpOpen(true)} />
            <ThemeToggle compact />
          </div>
        </div>
        {tabs?.length ? (
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => onTab?.(t.id)} onMouseEnter={t.prefetch} onFocus={t.prefetch}>
                {t.label}
                {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      <div className="page-body" key={tab ?? "page"}>{children}</div>
      <HelpDrawer title={title} help={help} open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

// ── Loading gate ──────────────────────────────────────────────────────────────

export function Skeleton({ kind = "table" }: { kind?: "table" | "cards" | "form" | "detail" }) {
  if (kind === "cards") {
    return (
      <div className="stack" aria-hidden="true">
        <div className="grid">{[0, 1, 2, 3].map((i) => <div key={i} className="sk sk-card" />)}</div>
        <div className="sk" style={{ height: 260, borderRadius: 12 }} />
      </div>
    );
  }
  if (kind === "form" || kind === "detail") {
    return (
      <div className="card card-pad stack" style={{ maxWidth: 640 }} aria-hidden="true">
        {[40, 70, 55, 62].map((w, i) => (
          <div key={i} className="stack-sm">
            <div className="sk sk-line" style={{ width: 90 }} />
            <div className="sk" style={{ height: 34, width: `${w + 30}%` }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden="true">
      <div className="toolbar"><div className="sk" style={{ height: 32, width: 280 }} /></div>
      <div className="table-wrap">
        {[62, 48, 71, 55, 66, 43].map((w, i) => (
          <div key={i} className="sk-row">
            <div className="sk sk-line" style={{ width: `${w / 2}%` }} />
            <div className="sk sk-line" style={{ width: `${w / 4}%` }} />
            <div className="sk sk-line right" style={{ width: 70 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

type AnyQuery = Pick<UseQueryResult<unknown, Error>, "isPending" | "error" | "refetch" | "data">;

/**
 * Renders its children only once every listed query has data, so a page never appears
 * half-loaded. Fast responses show nothing at all; after 150ms a layout-matched skeleton
 * appears. Failures get a plain message, a Retry button and a copyable reference.
 */
export function Gate({ queries, skeleton, children }: { queries: AnyQuery[]; skeleton?: "table" | "cards" | "form" | "detail"; children(): ReactNode }) {
  const pending = queries.some((q) => q.isPending);
  const failed = queries.find((q) => q.error && q.data === undefined);
  const [slow, setSlow] = useState(false);
  const [verySlow, setVerySlow] = useState(false);
  useEffect(() => {
    if (!pending) return (setSlow(false), setVerySlow(false));
    const a = setTimeout(() => setSlow(true), 150);
    const b = setTimeout(() => setVerySlow(true), 10_000);
    return () => (clearTimeout(a), clearTimeout(b));
  }, [pending]);

  if (failed?.error) {
    const err = failed.error;
    return (
      <div className="card empty" role="alert">
        <div className="empty-icon"><Icon name="alert" /></div>
        <h3>This page could not load</h3>
        <p>{errorMessage(err)}</p>
        <div className="row">
          <Button icon="refresh" onClick={() => queries.forEach((q) => void q.refetch())}>Retry</Button>
          {err instanceof ApiError && err.requestId ? <CopyChip value={err.requestId} /> : null}
        </div>
      </div>
    );
  }
  if (pending) {
    return (
      <>
        <div className="topbar-progress" />
        {slow ? <Skeleton kind={skeleton} /> : null}
        {verySlow ? <p className="muted" role="status">Still loading. The server is taking longer than usual; you can keep waiting or reload the page.</p> : null}
      </>
    );
  }
  return <>{children()}</>;
}

/** Full-screen loader for the moment before the app knows who is signed in. */
export function Splash() {
  return (
    <div className="center-screen" role="status" aria-label="Loading">
      <div className="topbar-progress" />
      <Logo size={40} />
    </div>
  );
}
