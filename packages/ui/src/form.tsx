// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ApiError, errorMessage } from "./api";
import { Icon } from "./icons";
import { Drawer, useConfirm, type DrawerProps } from "./overlay";
import { Button, Callout, Hint } from "./primitives";

export function Field({ label, hint, error, optional, help, children }: { label: string; hint?: ReactNode; error?: string; optional?: boolean; help?: string; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined }) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
        {optional ? <span className="opt">optional</span> : null}
        {help ? <Hint text={help} /> : null}
      </label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": describedBy })}
      {error ? (
        <div className="err" id={`${id}-err`}>
          <Icon name="alert" width={13} height={13} />
          {error}
        </div>
      ) : hint ? (
        <div className="hint" id={`${id}-hint`}>{hint}</div>
      ) : null}
    </div>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={`input ${props.className ?? ""}`} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={`select ${props.className ?? ""}`} />;
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} className={`textarea ${props.className ?? ""}`} />;

/** Rarely used options, folded away. Remembers whether you left it open. */
export function Advanced({ id, changed = 0, children }: { id: string; changed?: number; children: ReactNode }) {
  const key = `rose.adv.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return (
    <details
      className="adv"
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        setOpen(next);
        try {
          localStorage.setItem(key, next ? "1" : "0");
        } catch {
          /* private mode */
        }
      }}
    >
      <summary>
        <Icon name="chevron" />
        Advanced options
        {changed > 0 ? <span className="tab-count">{changed} changed</span> : null}
      </summary>
      <div className="adv-body">{children}</div>
    </details>
  );
}

export interface FormApi<V> {
  values: V;
  errors: Partial<Record<keyof V & string, string>>;
  set<K extends keyof V>(key: K, value: V[K]): void;
  /** Props for a text input bound to a string field. */
  text<K extends keyof V & string>(key: K): { value: string; onChange(e: { target: { value: string } }): void; name: string };
  submitting: boolean;
}

/**
 * A form in a right-side drawer. On success the drawer closes and the caller's cache
 * update makes the result visible immediately; nothing reloads and nothing navigates.
 * Server field errors land on the matching inputs; the first one receives focus.
 */
export function FormDrawer<V extends Record<string, unknown>>({
  open, onClose, title, subtitle, size, initial, submitLabel, onSubmit, children, validate, loading, extraActions,
}: Pick<DrawerProps, "open" | "onClose" | "title" | "subtitle" | "size"> & {
  initial: V;
  submitLabel: string;
  onSubmit(values: V): Promise<unknown>;
  validate?(values: V): Partial<Record<keyof V & string, string>>;
  /** True while the record being edited is still loading: the drawer shows a skeleton instead of empty fields. */
  loading?: boolean;
  /** Secondary actions shown at the left of the footer, e.g. Delete. */
  extraActions?: ReactNode;
  children(form: FormApi<V>): ReactNode;
}) {
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();
  const initialJson = useMemo(() => JSON.stringify(initial), [initial]);

  useEffect(() => {
    if (open) {
      setValues(JSON.parse(initialJson) as V);
      setErrors({});
      setFailure(null);
      setSubmitting(false);
    }
  }, [open, initialJson]);

  const dirty = JSON.stringify(values) !== initialJson;
  const close = async () => {
    if (submitting) return;
    if (dirty && !(await confirm({ title: "Discard changes?", body: "What you entered will be lost.", confirmLabel: "Discard", tone: "danger" }))) return;
    onClose();
  };

  const focusFirstError = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || loading) return;
    const local = validate?.(values) ?? {};
    if (Object.keys(local).length) {
      setErrors(local);
      focusFirstError();
      return;
    }
    setSubmitting(true);
    setFailure(null);
    setErrors({});
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        focusFirstError();
        if (err.fields._) setFailure(err.fields._);
      } else {
        setFailure(errorMessage(err) + (err instanceof ApiError && err.status >= 500 && err.requestId ? ` (reference ${err.requestId})` : ""));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const form: FormApi<V> = {
    values,
    errors: errors as FormApi<V>["errors"],
    submitting,
    set: (key, value) => {
      setValues((v) => ({ ...v, [key]: value }));
      setErrors((e) => (e[key as string] ? { ...e, [key as string]: undefined } : e));
    },
    text: (key) => ({ name: key, value: String(values[key] ?? ""), onChange: (e) => form.set(key, e.target.value as V[typeof key]) }),
  };

  return (
    <Drawer
      open={open}
      onClose={() => void close()}
      title={title}
      subtitle={subtitle}
      size={size}
      footer={
        <>
          {extraActions}
          <span className="grow" />
          <Button onClick={() => void close()} disabled={submitting}>Cancel</Button>
          <Button variant="primary" busy={submitting} disabled={loading} onClick={(e) => void submit(e)}>{submitLabel}</Button>
        </>
      }
    >
      <form ref={formRef} className="stack" onSubmit={(e) => void submit(e)} noValidate>
        {failure ? <Callout tone="bad">{failure}</Callout> : null}
        {loading ? (
          <div className="stack" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="stack-sm">
                <div className="sk sk-line" style={{ width: 90 }} />
                <div className="sk" style={{ height: 36 }} />
              </div>
            ))}
          </div>
        ) : (
          children(form)
        )}
        {/* Enables Enter-to-submit without a visible second button. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">Submit</button>
      </form>
    </Drawer>
  );
}
