import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChefHat, ChevronRight, Hourglass, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtTime, localToday } from "../../lib/format";
import type { MenuItem, SlotBase } from "../../lib/types";
import { Empty, Meter, PageHeader, QueryState, StatusBadge } from "../../components/ui";
import { WithMess } from "../supervisor/common";

interface BoardMeal extends SlotBase {
  menu: MenuItem[];
  approvedServings: number | null;
  approvedAt: string | null;
  pendingRecommendation: number | null;
  tasks: { pending: number; inProgress: number; done: number };
  openIncidents: number;
}

export default function KitchenBoard() {
  return <WithMess>{(messId, messName) => <Board messId={messId} messName={messName} />}</WithMess>;
}

function Board({ messId, messName }: { messId: number; messName: string }) {
  const [day, setDay] = useState(0);
  const date = localToday(day);
  const q = useQuery({
    queryKey: ["kitchen", "board", messId, date],
    queryFn: () => api.get<{ date: string; meals: BoardMeal[] }>(`/kitchen/board?messId=${messId}&date=${date}`),
    refetchInterval: 30_000,
  });
  return (
    <div className="page">
      <PageHeader
        title="Preparation"
        subtitle={`${messName} · ${fmtDate(date, "long")}`}
        actions={
          <div className="segmented" role="radiogroup" aria-label="Day">
            {[
              [0, "Today"],
              [1, "Tomorrow"],
            ].map(([v, l]) => (
              <label key={v}>
                <input type="radio" checked={day === v} onChange={() => setDay(v as number)} />
                <span>{l}</span>
              </label>
            ))}
          </div>
        }
      />
      <QueryState query={q} lines={6}>
        {(data) =>
          data.meals.length === 0 ? (
            <Empty icon={<ChefHat size={22} aria-hidden="true" />} title="Nothing to prepare yet">
              Meals appear here once student voting has closed for them.
            </Empty>
          ) : (
            <div className="panel ruled">
              {data.meals.map((m) => {
                const total = m.tasks.pending + m.tasks.inProgress + m.tasks.done;
                return (
                  <Link key={m.id} to={`/kitchen/meals/${m.id}`} className="kitchen-meal" style={{ textDecoration: "none", color: "inherit" }}>
                    <div>
                      <div className="strong" style={{ fontSize: "var(--text-xl)" }}>
                        {m.mealType.name}
                      </div>
                      <div className="mono text-sm muted">
                        Serve {fmtTime(m.serviceStartsAt)}
                      </div>
                    </div>
                    <div className="stack" style={{ ["--gap" as string]: "8px", minWidth: 0 }}>
                      <div className="row">
                        <StatusBadge status={m.status} />
                        {m.openIncidents > 0 && (
                          <span className="badge badge-warn">
                            <TriangleAlert size={12} aria-hidden="true" /> {m.openIncidents} issue{m.openIncidents === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      <div className="text-sm" style={{ color: "var(--ink-2)" }}>
                        {m.menu.map((d) => d.name).join(" · ") || "No menu"}
                      </div>
                      {total > 0 && (
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <div style={{ flex: 1, maxWidth: 260 }}>
                            <Meter value={m.tasks.done} max={total} label="Dishes prepared" />
                          </div>
                          <span className="text-xs muted num">
                            {m.tasks.done}/{total} dishes done
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      {m.approvedServings !== null ? (
                        <div style={{ textAlign: "right" }}>
                          <div className="big-number num">{m.approvedServings}</div>
                          <div className="text-xs muted">servings approved</div>
                        </div>
                      ) : (
                        <div style={{ textAlign: "right", maxWidth: 180 }}>
                          <div className="row text-sm" style={{ color: "var(--warn-text)", justifyContent: "flex-end", flexWrap: "nowrap" }}>
                            <Hourglass size={14} aria-hidden="true" /> Awaiting approval
                          </div>
                          {m.pendingRecommendation !== null && <div className="text-xs muted">Recommended {m.pendingRecommendation} — not final</div>}
                        </div>
                      )}
                      <ChevronRight size={20} className="muted" aria-hidden="true" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}
