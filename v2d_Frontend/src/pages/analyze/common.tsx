import { useMemo, useState } from "react";
import { Download, Lightbulb } from "lucide-react";
import { localToday } from "../../lib/format";
import { useMealTypes } from "../supervisor/Meals";

export interface Period {
  from: string;
  to: string;
  mealTypeId: string;
}

const PRESETS = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "semester", label: "This semester" },
  { key: "year", label: "Academic year" },
  { key: "custom", label: "Custom" },
] as const;

function presetRange(key: string): { from: string; to: string } | null {
  const today = localToday();
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (key) {
    case "7d":
      return { from: localToday(-6), to: today };
    case "30d":
      return { from: localToday(-29), to: today };
    case "month":
      return { from: `${y}-${pad(m)}-01`, to: today };
    case "lastMonth": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: `${ly}-${pad(lm)}-01`, to: `${ly}-${pad(lm)}-${lastDay(ly, lm)}` };
    }
    case "semester":
      // Indian academic calendar: odd semester Jul–Dec, even semester Jan–Jun.
      return m >= 7 ? { from: `${y}-07-01`, to: today } : { from: `${y}-01-01`, to: today };
    case "year":
      return m >= 7 ? { from: `${y}-07-01`, to: today } : { from: `${y - 1}-07-01`, to: today };
    default:
      return null;
  }
}

export function usePeriod(initial = "30d") {
  const [preset, setPreset] = useState(initial);
  const [custom, setCustom] = useState(() => presetRange(initial)!);
  const [mealTypeId, setMealTypeId] = useState("");
  const range = presetRange(preset) ?? custom;
  const period: Period = useMemo(() => ({ ...range, mealTypeId }), [range.from, range.to, mealTypeId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { period, preset, setPreset, custom, setCustom, mealTypeId, setMealTypeId };
}

export function PeriodBar({ state, exportHref, showMealType = true }: { state: ReturnType<typeof usePeriod>; exportHref: string; showMealType?: boolean }) {
  const types = useMealTypes();
  return (
    <div className="row-between" style={{ marginBottom: 20 }}>
      <div className="row">
        <select className="select" style={{ width: "auto" }} value={state.preset} onChange={(e) => state.setPreset(e.target.value)} aria-label="Reporting period">
          {PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        {state.preset === "custom" && (
          <>
            <input type="date" className="input" style={{ width: "auto" }} value={state.custom.from} max={state.custom.to} onChange={(e) => state.setCustom({ ...state.custom, from: e.target.value })} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" className="input" style={{ width: "auto" }} value={state.custom.to} min={state.custom.from} onChange={(e) => state.setCustom({ ...state.custom, to: e.target.value })} aria-label="To" />
          </>
        )}
        {showMealType && (
          <select className="select" style={{ width: "auto" }} value={state.mealTypeId} onChange={(e) => state.setMealTypeId(e.target.value)} aria-label="Meal type">
            <option value="">All meals</option>
            {types.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <a className="btn" href={exportHref} download>
        <Download size={15} aria-hidden="true" /> Export CSV
      </a>
    </div>
  );
}

export interface Recommendation {
  severity: "HIGH" | "MEDIUM" | "LOW";
  code: string;
  title: string;
  detail: string;
}

export function Recommendations({ items }: { items: Recommendation[] }) {
  if (!items.length) return <p className="text-sm muted">No findings for this period. Findings appear only when enough meals support them.</p>;
  const tone = { HIGH: "danger", MEDIUM: "warn", LOW: "info" } as const;
  return (
    <ul className="stack" style={{ ["--gap" as string]: "10px", listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((r, i) => (
        <li key={i} className={`notice notice-${tone[r.severity]}`}>
          <Lightbulb size={17} aria-hidden="true" />
          <div className="stack" style={{ ["--gap" as string]: "2px" }}>
            <div className="notice-title">{r.title}</div>
            <div className="text-sm">{r.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Coverage bar for waste measurements: how much of the period the totals actually describe. */
export function Completeness({ c }: { c: { closedMeals: number; wasteMeasured: number; wasteEstimated: number; wastePartial: number; wasteMissing: number; preparedRecorded: number; reconciled: number } }) {
  const total = c.closedMeals || 1;
  const parts = [
    { k: "Measured", n: c.wasteMeasured, bg: "var(--viz-1)" },
    { k: "Estimated", n: c.wasteEstimated, bg: "var(--viz-2)" },
    { k: "Partial", n: c.wastePartial, bg: "repeating-linear-gradient(135deg, var(--unvoted-soft) 0 3px, var(--unvoted) 3px 4px)" },
    { k: "Not recorded", n: c.wasteMissing, bg: "var(--viz-track)" },
  ];
  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      <div className="composition" style={{ height: 12 }} role="img" aria-label={parts.map((p) => `${p.k} ${p.n}`).join(", ")}>
        {parts.filter((p) => p.n > 0).map((p) => (
          <span key={p.k} style={{ flexGrow: p.n / total, background: p.bg }} />
        ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.k} className="key">
            <span className="sw" style={{ background: p.bg, border: p.k === "Not recorded" ? "1px solid var(--line-strong)" : undefined }} /> {p.k} <strong>{p.n}</strong>
          </span>
        ))}
      </div>
      <p className="text-xs muted">
        Of {c.closedMeals} closed meals: {c.reconciled} reconciled, {c.preparedRecorded} with preparation weights. Waste totals cover measured and estimated meals only — missing meals are not counted as zero.
      </p>
    </div>
  );
}
