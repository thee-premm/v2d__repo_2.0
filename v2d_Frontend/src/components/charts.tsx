import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * Small SVG charts following one spec:
 *  - single y-axis, solid hairline grid, clean ticks
 *  - columns/bars ≤ 24 px thick, 4 px rounded data-end, square at the baseline
 *  - lines 2 px; markers ≥ 8 px with a 2 px surface ring; series 2 uses hollow
 *    markers so identity never relies on colour alone
 *  - a missing value is drawn as an explicit "not recorded" gap, never a 0 bar
 *  - hover/focus tooltip on every mark; legend for ≥ 2 series
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

const compact = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}K` : String(Math.round(v * 10) / 10));

/** Rounded-top bar path (square at the baseline). */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}
function hbarPath(x: number, y: number, w: number, h: number, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

export interface ColumnDatum {
  key: string;
  label: string;
  value: number | null;
  detail?: ReactNode;
}

export function ColumnChart({
  data,
  height = 200,
  format = (v: number) => compact(v),
  unit = "",
  reference,
  ariaLabel,
  labelEvery,
}: {
  data: ColumnDatum[];
  height?: number;
  format?: (v: number) => string;
  unit?: string;
  reference?: { value: number; label: string };
  ariaLabel: string;
  labelEvery?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const m = { top: 14, right: 12, bottom: 26, left: 40 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const max = Math.max(...data.map((d) => d.value ?? 0), reference?.value ?? 0, 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, Math.max(3, band - 2));
  const y = (v: number) => m.top + ih - (v / top) * ih;
  const every = labelEvery ?? Math.max(1, Math.ceil(data.length / Math.floor(iw / 56)));

  return (
    <div className="chart-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg className="chart" width={width} height={height} role="img" aria-label={ariaLabel}>
        <g className="grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
              <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {compact(t)}
              </text>
            </g>
          ))}
        </g>
        {data.map((d, i) => {
          const cx = m.left + band * i + band / 2;
          const x = cx - bw / 2;
          const show = (e: { currentTarget: SVGGElement }) => {
            const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const host = ref.current!.getBoundingClientRect();
            setTip({
              x: cx + rect.left - host.left,
              y: (d.value === null ? y(0) : y(d.value)) + rect.top - host.top,
              content: (
                <>
                  <div className="t-title">{d.label}</div>
                  <div className="t-row">
                    <span>Value</span>
                    <strong className="num">{d.value === null ? "Not recorded" : `${format(d.value)}${unit}`}</strong>
                  </div>
                  {d.detail}
                </>
              ),
            });
          };
          return (
            <g key={d.key} tabIndex={0} onMouseEnter={show} onFocus={show} onBlur={() => setTip(null)} aria-label={`${d.label}: ${d.value === null ? "not recorded" : format(d.value) + unit}`}>
              <rect x={m.left + band * i} y={m.top} width={band} height={ih} fill="transparent" />
              {d.value === null ? (
                <g>
                  <line x1={cx - Math.max(3, bw / 2)} x2={cx + Math.max(3, bw / 2)} y1={y(0) - 4} y2={y(0) - 4} stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="2 2" />
                </g>
              ) : (
                <path d={barPath(x, y(d.value), bw, y(0) - y(d.value))} fill="var(--viz-1)" />
              )}
              {i % every === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
        {reference && reference.value > 0 && (
          <g>
            <line x1={m.left} x2={width - m.right} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--accent)" strokeWidth="1.5" />
            <text x={width - m.right} y={y(reference.value) - 6} textAnchor="end" style={{ fill: "var(--accent-text)", fontWeight: 600 }}>
              {reference.label}
            </text>
          </g>
        )}
        <line className="axis" x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" />
      </svg>
      {tip && (
        <div className="chart-tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.content}
        </div>
      )}
    </div>
  );
}

export interface LinePoint {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
}

/** Two series on one axis (e.g. predicted vs actual). Series b uses hollow markers. */
export function LineChart({
  data,
  series,
  height = 220,
  ariaLabel,
  unit = "",
}: {
  data: LinePoint[];
  series: [{ label: string }, { label: string }];
  height?: number;
  ariaLabel: string;
  unit?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 16, right: 64, bottom: 26, left: 40 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const max = Math.max(1, ...data.flatMap((d) => [d.a ?? 0, d.b ?? 0]));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const x = (i: number) => m.left + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => m.top + ih - (v / top) * ih;
  const path = (k: "a" | "b") => {
    let d = "";
    let pen = false;
    data.forEach((p, i) => {
      const v = p[k];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)} `;
      pen = true;
    });
    return d;
  };
  const lastIdx = (k: "a" | "b") => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i][k] !== null) return i;
    return -1;
  };
  const every = Math.max(1, Math.ceil(data.length / Math.floor(iw / 64)));
  const markers = data.length <= 40;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - m.left) / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };

  const endLabel = (k: "a" | "b", text: string) => {
    const i = lastIdx(k);
    if (i < 0) return null;
    return (
      <text x={x(i) + 8} y={y(data[i][k]!)} dy="0.32em" style={{ fill: "var(--ink-2)", fontWeight: 500 }}>
        {text}
      </text>
    );
  };
  const ia = lastIdx("a");
  const ib = lastIdx("b");
  const close = ia >= 0 && ib >= 0 && Math.abs(y(data[ia].a!) - y(data[ib].b!)) < 14;

  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      <div className="legend">
        <span className="key">
          <svg width="22" height="10" aria-hidden="true">
            <line x1="0" x2="22" y1="5" y2="5" stroke="var(--viz-1)" strokeWidth="2" />
            <circle cx="11" cy="5" r="4" fill="var(--viz-1)" />
          </svg>
          {series[0].label}
        </span>
        <span className="key">
          <svg width="22" height="10" aria-hidden="true">
            <line x1="0" x2="22" y1="5" y2="5" stroke="var(--viz-2)" strokeWidth="2" />
            <circle cx="11" cy="5" r="3.5" fill="var(--surface)" stroke="var(--viz-2)" strokeWidth="2" />
          </svg>
          {series[1].label}
        </span>
      </div>
      <div className="chart-wrap" ref={ref}>
        <svg className="chart" width={width} height={height} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <g className="grid">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
                <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
          </g>
          {data.map((p, i) =>
            i % every === 0 ? (
              <text key={p.key} x={x(i)} y={height - 8} textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + ih} stroke="var(--line-strong)" />}
          <path d={path("a")} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <path d={path("b")} fill="none" stroke="var(--viz-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {data.map((p, i) => (
            <g key={p.key}>
              {p.a !== null && (markers || hover === i) && <circle cx={x(i)} cy={y(p.a)} r={4} fill="var(--viz-1)" stroke="var(--surface)" strokeWidth="2" />}
              {p.b !== null && (markers || hover === i) && <circle cx={x(i)} cy={y(p.b)} r={3.5} fill="var(--surface)" stroke="var(--viz-2)" strokeWidth="2" />}
            </g>
          ))}
          {!close && endLabel("a", series[0].label)}
          {!close && endLabel("b", series[1].label)}
          <line className="axis" x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" />
        </svg>
        {hover !== null && data[hover] && (
          <div className="chart-tooltip" style={{ left: x(hover), top: y(Math.max(data[hover].a ?? 0, data[hover].b ?? 0)) }}>
            <div className="t-title">{data[hover].label}</div>
            <div className="t-row">
              <span>
                <svg width="10" height="10" aria-hidden="true">
                  <circle cx="5" cy="5" r="4" fill="var(--viz-1)" />
                </svg>
                {series[0].label}
              </span>
              <strong className="num">{data[hover].a === null ? "—" : `${compact(data[hover].a!)}${unit}`}</strong>
            </div>
            <div className="t-row">
              <span>
                <svg width="10" height="10" aria-hidden="true">
                  <circle cx="5" cy="5" r="3.5" fill="var(--surface)" stroke="var(--viz-2)" strokeWidth="2" />
                </svg>
                {series[1].label}
              </span>
              <strong className="num">{data[hover].b === null ? "—" : `${compact(data[hover].b!)}${unit}`}</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number | null;
  note?: string;
}

/** Horizontal comparison bars, value at the tip; null renders "not recorded". */
export function HBarChart({ data, format = (v: number) => compact(v), unit = "", ariaLabel, highlight }: { data: BarDatum[]; format?: (v: number) => string; unit?: string; ariaLabel: string; highlight?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const rowH = 34;
  const labelW = Math.min(180, Math.max(100, width * 0.3));
  const valueW = 96;
  const iw = Math.max(40, width - labelW - valueW);
  const max = Math.max(1, ...data.map((d) => d.value ?? 0));
  const height = data.length * rowH + 4;
  const sorted = useMemo(() => [...data].sort((a, b) => (b.value ?? -1) - (a.value ?? -1)), [data]);
  return (
    <div className="chart-wrap" ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={ariaLabel}>
        {sorted.map((d, i) => {
          const y0 = i * rowH + 6;
          const w = d.value === null ? 0 : (d.value / max) * iw;
          return (
            <g key={d.key}>
              <title>{`${d.label}: ${d.value === null ? "not recorded" : format(d.value) + unit}${d.note ? ` (${d.note})` : ""}`}</title>
              <text x={0} y={y0 + 11} dy="0.32em" style={{ fill: "var(--ink-2)", fontSize: 12, fontWeight: d.key === highlight ? 600 : 400 }}>
                {d.label.length > 24 ? `${d.label.slice(0, 23)}…` : d.label}
              </text>
              <rect x={labelW} y={y0 + 4} width={iw} height={14} rx={3} fill="var(--viz-track)" />
              {d.value !== null && <path d={hbarPath(labelW, y0 + 4, Math.max(2, w), 14)} fill={d.key === highlight ? "var(--viz-2)" : "var(--viz-1)"} />}
              <text x={labelW + iw + 8} y={y0 + 11} dy="0.32em" style={{ fill: d.value === null ? "var(--ink-3)" : "var(--ink)", fontSize: 12, fontWeight: 500 }} className="num">
                {d.value === null ? "not recorded" : `${format(d.value)}${unit}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
