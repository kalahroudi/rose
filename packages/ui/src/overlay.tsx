// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { Button, CopyChip, IconButton } from "./primitives";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Traps focus inside a layer, closes on Escape, and returns focus to the trigger afterwards. */
function useLayer(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("input, select, textarea") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        if (items.length === 0) return;
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) (e.preventDefault(), z.focus());
        else if (!e.shiftKey && document.activeElement === z) (e.preventDefault(), a.focus());
      }
    };
    el?.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);
  return ref;
}

export interface DrawerProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  subtitle?: ReactNode;
  size?: "md" | "lg" | "xl";
  footer?: ReactNode;
  children: ReactNode;
  /** Render children edge to edge (used for embedded previews). */
  bare?: boolean;
}

/** Right-side overlay. Every action in the product happens in one of these; the page behind stays put. */
export function Drawer({ open, onClose, title, subtitle, size = "md", footer, children, bare }: DrawerProps) {
  const ref = useLayer(open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" data-size={size} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={ref}>
        <div className="drawer-head">
          <div className="grow">
            <h2 className="drawer-title">{title}</h2>
            {subtitle ? <div className="page-desc">{subtitle}</div> : null}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {bare ? children : <div className="drawer-body">{children}</div>}
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}

/** Preview a third-party page beside your work. Some sites refuse to be embedded; the header link is the fallback. */
export function PreviewDrawer({ url, onClose }: { url: string | null; onClose(): void }) {
  return (
    <Drawer open={!!url} onClose={onClose} size="xl" bare title="Reference preview" subtitle={url ? <a className="link" href={url} target="_blank" rel="noopener noreferrer">Open in a new tab if the preview stays blank<Icon name="external" /></a> : null}>
      {url ? <iframe className="drawer-frame" src={url} title="Reference preview" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /> : null}
    </Drawer>
  );
}

// ── Confirmations ─────────────────────────────────────────────────────────────

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
}
interface DangerOptions {
  title: string;
  /** One sentence: what will be lost. */
  body: ReactNode;
  /** The exact name the person must type. */
  name: string;
  confirmLabel: string;
}
type Pending = ({ kind: "confirm" } & ConfirmOptions) | ({ kind: "danger" } & DangerOptions);

interface ConfirmApi {
  /** Reversible or low-risk action: plain confirm / cancel. */
  (options: ConfirmOptions): Promise<boolean>;
  /** Data loss: the person must type the resource name. */
  danger(options: DangerOptions): Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <UiProvider>");
  return ctx;
}

function ConfirmDialog({ pending, done }: { pending: Pending; done(result: boolean): void }) {
  const ref = useLayer(true, () => done(false));
  const [typed, setTyped] = useState("");
  const ready = pending.kind === "confirm" || typed === pending.name;
  return createPortal(
    <>
      <div className="scrim scrim-dialog" onClick={() => done(false)} />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={pending.title} ref={ref}>
        <h2 className="dialog-title">{pending.title}</h2>
        {pending.body ? <div className="dim">{pending.body}</div> : null}
        {pending.kind === "danger" ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) done(true);
            }}
          >
            <label className="hint" htmlFor="confirm-name">
              Type <CopyChip value={pending.name} flush /> to confirm
            </label>
            <input id="confirm-name" className="input mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus />
          </form>
        ) : null}
        <div className="dialog-foot">
          <Button onClick={() => done(false)} data-autofocus={pending.kind === "confirm" ? true : undefined}>Cancel</Button>
          <Button variant={pending.kind === "danger" || pending.tone === "danger" ? "danger" : "primary"} disabled={!ready} onClick={() => done(true)}>
            {pending.confirmLabel}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Toasts ────────────────────────────────────────────────────────────────────

interface ToastItem {
  id: number;
  tone: "ok" | "bad";
  message: string;
  action?: { label: string; run(): void };
}
interface ToastApi {
  success(message: string, action?: ToastItem["action"]): void;
  /** Failures stay until dismissed. */
  error(message: string): void;
}
const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <UiProvider>");
  return ctx;
}

let toastSeq = 0;

/** Hosts confirmations and toasts. Mount once at the root of an app. */
export function UiProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<(v: boolean) => void>(undefined);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const confirm = useMemo<ConfirmApi>(() => {
    const ask = (p: Pending) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setPending(p);
      });
    const fn = ((o: ConfirmOptions) => ask({ kind: "confirm", ...o })) as ConfirmApi;
    fn.danger = (o) => ask({ kind: "danger", ...o });
    return fn;
  }, []);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useMemo<ToastApi>(
    () => ({
      success(message, action) {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-3), { id, tone: "ok", message, action }]);
        setTimeout(() => dismiss(id), action ? 8000 : 4500);
      },
      error(message) {
        setToasts((t) => [...t.slice(-3), { id: ++toastSeq, tone: "bad", message }]);
      },
    }),
    [dismiss],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={toast}>
        {children}
        {pending ? (
          <ConfirmDialog
            pending={pending}
            done={(result) => {
              setPending(null);
              resolver.current?.(result);
            }}
          />
        ) : null}
        {createPortal(
          <div className="toasts" role="status" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.tone}`}>
                <Icon name={t.tone === "ok" ? "check" : "alert"} />
                <span className="grow">{t.message}</span>
                {t.action ? (
                  <button type="button" onClick={() => (t.action!.run(), dismiss(t.id))}>
                    {t.action.label}
                  </button>
                ) : null}
                <button type="button" className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}
