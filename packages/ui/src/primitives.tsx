// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default", size, icon, busy, block, children, className = "", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "lg"; icon?: IconName; busy?: boolean; block?: boolean }) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, size && `btn-${size}`, block && "btn-block", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, small, className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; small?: boolean }) {
  return (
    <button type="button" className={`icon-btn ${small ? "icon-btn-sm" : ""} ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
      {children}
    </button>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

export function Badge({ tone = "neutral", running, plain, children }: { tone?: Tone; running?: boolean; plain?: boolean; children: ReactNode }) {
  return <span className={`badge ${tone !== "neutral" ? `badge-${tone}` : ""} ${running ? "badge-run" : ""} ${plain ? "badge-plain" : ""}`}>{children}</span>;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "sr-only";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Mini copy icon. Turns into a check for a moment and announces the copy to screen readers. */
export function Copy({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void writeClipboard(value).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      });
    },
    [value],
  );
  return (
    <button type="button" className="copy" data-copied={copied} onClick={onClick} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}>
      <Icon name={copied ? "check" : "copy"} />
      <span className="sr-only" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
    </button>
  );
}

/** A monospace value with a copy icon. `flush` removes all spacing between value and icon. */
export function CopyChip({ value, flush, display }: { value: string; flush?: boolean; display?: string }) {
  return (
    <span className={`chip ${flush ? "chip-flush" : ""}`}>
      <span>{display ?? value}</span>
      <Copy value={value} />
    </span>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="codeblock">
      {children}
      <Copy value={children} />
    </div>
  );
}

/** Third-party reference: always a new tab, never leaks the opener or referrer. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" />
    </a>
  );
}

export function Callout({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode }) {
  return (
    <div className={`callout ${tone !== "info" ? `callout-${tone}` : ""}`} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "alert"} />
      <div className="grow">{children}</div>
    </div>
  );
}

/** Inline "?" for a single term. */
export function Hint({ text }: { text: string }) {
  return (
    <button type="button" className="tiphint" data-tip={text} aria-label={text}>
      ?
    </button>
  );
}

export function EmptyState({ icon = "list", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "Never";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "Just now";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function Time({ at }: { at: number | null | undefined }) {
  if (!at) return <span className="muted">Never</span>;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="nowrap">{timeAgo(at)}</time>;
}

export const formatNumber = (n: number): string => n.toLocaleString();
