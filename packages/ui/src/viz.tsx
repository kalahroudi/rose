// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { formatNumber, Hint } from "./primitives";

export function Kpi({ label, value, sub, help }: { label: string; value: number | string; sub?: ReactNode; help?: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">
        {label}
        {help ? <Hint text={help} /> : null}
      </div>
      <div className="kpi-value">{typeof value === "number" ? formatNumber(value) : value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

/** Small bar chart with direct labels and a table view for exact values. */
export function BarChart({ data, label, valueLabel = "Value" }: { data: { label: string; value: number }[]; label: string; valueLabel?: string }) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 640;
  const H = 150;
  const pad = { l: 8, r: 8, t: 18, b: 22 };
  const step = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.min(28, step * 0.62);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">{label}</span>
        <button type="button" className="link right" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</button>
      </div>
      {table ? (
        <table className="table">
          <thead><tr><th>Day</th><th>{valueLabel}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{formatNumber(d.value)}</td></tr>)}</tbody>
        </table>
      ) : (
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${label}. ${data.map((d) => `${d.label}: ${d.value}`).join(", ")}`}>
          <line className="axis" x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} />
          {data.map((d, i) => {
            const h = d.value === 0 ? 2 : Math.max(4, ((H - pad.t - pad.b) * d.value) / max);
            const x = pad.l + i * step + (step - bw) / 2;
            const y = H - pad.b - h;
            return (
              <g key={d.label}>
                <rect className={d.value === 0 ? "bar bar-0" : "bar"} x={x} y={y} width={bw} height={h} rx={3}><title>{`${d.label}: ${d.value}`}</title></rect>
                {d.value > 0 ? <text className="val" x={x + bw / 2} y={y - 5} textAnchor="middle">{d.value}</text> : null}
                {i % Math.ceil(data.length / 7) === 0 || i === data.length - 1 ? <text x={x + bw / 2} y={H - 6} textAnchor="middle">{d.label}</text> : null}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export interface FlowStep {
  label: string;
  sub?: string;
  tone?: "on" | "ok" | "bad";
  /** Label on the arrow leading into this step. */
  via?: string;
}

/**
 * Flow diagram for help panels: pipelines, lifecycles, request paths. Up to three steps
 * run left to right; longer flows stack top to bottom so the text stays readable in a
 * drawer (pass `horizontal` to force a row where there is room). Uses theme variables,
 * so it follows light and dark mode. Mark the current state with `tone: "on"`.
 */
export function Flow({ steps, title, horizontal = steps.length <= 3 }: { steps: FlowStep[]; title: string; horizontal?: boolean }) {
  const label = `${title}: ${steps.map((s) => s.label).join(", then ")}`;
  if (!horizontal) {
    const W = 400;
    const bh = 38;
    const gap = 24;
    return (
      <svg className="diagram" viewBox={`0 0 ${W} ${steps.length * bh + (steps.length - 1) * gap + 2}`} role="img" aria-label={label}>
        {steps.map((s, i) => {
          const y = 1 + i * (bh + gap);
          return (
            <g key={s.label}>
              {i > 0 ? (
                <>
                  <line className="arrow" x1={W / 2} y1={y - gap + 3} x2={W / 2} y2={y - 8} strokeWidth="1.5" />
                  <path className="arrowhead" d={`M${W / 2} ${y - 3} l-4 -7 h8 z`} />
                  {s.via ? <text className="lbl" x={W / 2 + 10} y={y - gap / 2 + 3}>{s.via}</text> : null}
                </>
              ) : null}
              <rect className={`box ${s.tone ? `box-${s.tone}` : ""}`} x={1} y={y} width={W - 2} height={bh} rx={8} strokeWidth="1.25" />
              <text x={14} y={y + 24} fontWeight="600">{s.label}</text>
              {s.sub ? <text className="sub" x={W - 14} y={y + 24} textAnchor="end">{s.sub}</text> : null}
            </g>
          );
        })}
      </svg>
    );
  }
  const bw = 124;
  const bh = 46;
  const gap = 34;
  const W = steps.length * bw + (steps.length - 1) * gap + 4;
  return (
    <svg className="diagram" viewBox={`0 0 ${W} ${bh + 22}`} role="img" aria-label={label}>
      {steps.map((s, i) => {
        const x = 2 + i * (bw + gap);
        return (
          <g key={s.label}>
            {i > 0 ? (
              <>
                <line className="arrow" x1={x - gap + 4} y1={18 + bh / 2} x2={x - 8} y2={18 + bh / 2} strokeWidth="1.5" />
                <path className="arrowhead" d={`M${x - 3} ${18 + bh / 2} l-7 -4 v8 z`} />
                {s.via ? <text className="lbl" x={x - gap / 2} y={18 + bh / 2 - 7} textAnchor="middle">{s.via}</text> : null}
              </>
            ) : null}
            <rect className={`box ${s.tone ? `box-${s.tone}` : ""}`} x={x} y={18} width={bw} height={bh} rx={8} strokeWidth="1.25" />
            <text x={x + bw / 2} y={18 + (s.sub ? 19 : 27)} textAnchor="middle" fontWeight="600">{s.label}</text>
            {s.sub ? <text className="sub" x={x + bw / 2} y={18 + 34} textAnchor="middle">{s.sub}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

/** "Many things, each walled off" picture used to explain tenant isolation. */
export function IsolationDiagram({ labels = ["acme", "globex", "initech"] }: { labels?: string[] }) {
  return (
    <svg className="diagram" viewBox="0 0 520 190" role="img" aria-label="Each tenant has its own private database and its own encryption key. The operator console can reach only the shared directory, never tenant data.">
      <rect className="box" x="170" y="4" width="180" height="40" rx="8" strokeWidth="1.25" />
      <text x="260" y="22" textAnchor="middle" fontWeight="600">Directory (control plane)</text>
      <text className="sub" x="260" y="36" textAnchor="middle">who exists, who may sign in</text>
      {labels.map((l, i) => {
        const x = 20 + i * 170;
        return (
          <g key={l}>
            <line className="arrow" x1={260} y1={44} x2={x + 70} y2={84} strokeWidth="1.25" strokeDasharray="3 3" />
            <rect className="box box-on" x={x} y={86} width={140} height={96} rx={10} strokeWidth="1.25" />
            <text x={x + 70} y={106} textAnchor="middle" fontWeight="600">{l}</text>
            <rect className="box" x={x + 14} y={116} width={112} height={24} rx={6} strokeWidth="1" />
            <text className="sub" x={x + 70} y={132} textAnchor="middle">private database</text>
            <rect className="box" x={x + 14} y={146} width={112} height={24} rx={6} strokeWidth="1" />
            <text className="sub" x={x + 70} y={162} textAnchor="middle">own encryption key</text>
          </g>
        );
      })}
    </svg>
  );
}
