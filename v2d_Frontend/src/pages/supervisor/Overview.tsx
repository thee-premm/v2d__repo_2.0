import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, ChevronRight, ClipboardCheck, MessageSquareWarning, Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtTime, relativeDay } from "../../lib/format";
import type { SlotListItem } from "../../lib/types";
import { Composition, Empty, Meter, PageHeader, QueryState, StatusBadge } from "../../components/ui";
import { NextActionLink, WithMess } from "./common";

interface Overview {
  date: string;
  today: SlotListItem[];
  upcoming: SlotListItem[];
  attention: {
    pendingAppeals: number;
    openIncidents: number;
    awaitingReconciliation: { id: number; serviceDate: string; mealType: string }[];
    awaitingApproval: { id: number; serviceDate: string; mealType: string; serviceStartsAt: string }[];
    unpublishedSoon: { id: number; serviceDate: string; mealType: string; votingClosesAt: string }[];
  };
}

function MealRow({ s }: { s: SlotListItem }) {
  const snap = s.summary.snapshot;
  const live = !snap && (s.status === "OPEN" || s.status === "DRAFT");
  const target = s.summary.approvedServings;
  return (
    <div className="meal-row">
      <div>
        <div className="strong" style={{ fontSize: "var(--text-lg)" }}>
          {s.mealType.name}
        </div>
        <div className="mono text-sm muted">
          {fmtTime(s.serviceStartsAt)}–{fmtTime(s.serviceEndsAt)}
        </div>
      </div>
      <div className="stack" style={{ ["--gap" as string]: "8px", minWidth: 0 }}>
        <div className="row">
          <StatusBadge status={s.status} />
          {s.status === "OPEN" && <span className="text-sm muted">closes {fmtTime(s.votingClosesAt)}</span>}
          {s.flags.specialEvent && <span className="badge badge-accent">Special</span>}
        </div>
        {snap ? (
          <Composition yes={snap.yes} no={snap.no} unvoted={snap.unvoted} />
        ) : live ? (
          <span className="text-sm muted num">
            {s.summary.liveYes} yes · {s.summary.liveNo} no so far
          </span>
        ) : null}
      </div>
      <div className="stack text-sm" style={{ ["--gap" as string]: "6px" }}>
        {target !== null ? (
          <>
            <div className="row-between num">
              <span className="muted">Served / target</span>
              <strong>
                {fmtNum(s.summary.attended)} / {fmtNum(target)}
              </strong>
            </div>
            <Meter value={s.summary.attended} max={target} label="Attendance against target" />
          </>
        ) : s.summary.recommendedServings !== null ? (
          <div className="row-between num">
            <span className="muted">Recommended</span>
            <strong>{s.summary.recommendedServings}</strong>
          </div>
        ) : (
          <span className="muted">No target yet</span>
        )}
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <NextActionLink slot={s} />
        <Link to={`/supervisor/meals/${s.id}`} className="icon-btn" aria-label={`Open ${s.mealType.name}`}>
          <ChevronRight size={18} />
        </Link>
      </div>
    </div>
  );
}

function Attention({ a }: { a: Overview["attention"] }) {
  const items = [
    ...a.awaitingApproval.map((x) => ({ key: `a${x.id}`, icon: AlertTriangle, tone: "warn", text: `Approve target · ${x.mealType}, ${relativeDay(x.serviceDate)}`, sub: `Service ${fmtDateTime(x.serviceStartsAt)}`, to: `/supervisor/meals/${x.id}` })),
    ...a.awaitingReconciliation.map((x) => ({ key: `r${x.id}`, icon: ClipboardCheck, tone: "warn", text: `Reconcile · ${x.mealType}, ${relativeDay(x.serviceDate)}`, sub: "Service closed", to: `/supervisor/meals/${x.id}/reconcile` })),
    ...a.unpublishedSoon.map((x) => ({ key: `d${x.id}`, icon: CalendarPlus, tone: "danger", text: `Unpublished · ${x.mealType}, ${relativeDay(x.serviceDate)}`, sub: `Cutoff ${fmtDateTime(x.votingClosesAt)}`, to: `/supervisor/meals/${x.id}` })),
    ...(a.pendingAppeals ? [{ key: "ap", icon: MessageSquareWarning, tone: "info", text: `${a.pendingAppeals} appeal${a.pendingAppeals === 1 ? "" : "s"} to review`, sub: "Students are waiting", to: "/supervisor/appeals" }] : []),
    ...(a.openIncidents ? [{ key: "in", icon: Wrench, tone: "info", text: `${a.openIncidents} kitchen issue${a.openIncidents === 1 ? "" : "s"} open`, sub: "Reported by the kitchen", to: "/supervisor/incidents" }] : []),
  ];
  return (
    <section className="panel" aria-labelledby="attention-title">
      <div className="panel-head">
        <h3 id="attention-title">Needs attention</h3>
        <span className="badge">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="panel-body text-sm muted">Nothing waiting on you.</div>
      ) : (
        <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((it) => (
            <li key={it.key}>
              <Link to={it.to} className="row" style={{ padding: "12px 20px", textDecoration: "none", color: "inherit", flexWrap: "nowrap" }}>
                <it.icon size={17} color={`var(--${it.tone})`} aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="strong text-sm" style={{ display: "block" }}>
                    {it.text}
                  </span>
                  <span className="text-xs muted">{it.sub}</span>
                </span>
                <ChevronRight size={16} className="muted" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function SupervisorOverview() {
  return (
    <WithMess>
      {(messId, messName) => <OverviewBody messId={messId} messName={messName} />}
    </WithMess>
  );
}

function OverviewBody({ messId, messName }: { messId: number; messName: string }) {
  const q = useQuery({ queryKey: ["overview", messId], queryFn: () => api.get<Overview>(`/messes/${messId}/overview`), refetchInterval: 30_000 });
  return (
    <div className="page">
      <PageHeader
        title={messName}
        subtitle={q.data ? `Today · ${fmtDate(q.data.date, "long")}` : "Today"}
        actions={
          <Link to="/supervisor/meals" className="btn">
            <CalendarPlus size={16} aria-hidden="true" /> Plan meals
          </Link>
        }
      />
      <QueryState query={q} lines={6}>
        {(data) => (
          <div className="split">
            <div className="stack" style={{ ["--gap" as string]: "28px" }}>
              <section className="section">
                <div className="section-title">
                  <h2>Today's meals</h2>
                </div>
                {data.today.length === 0 ? (
                  <Empty title="No meals scheduled today" action={<Link to="/supervisor/meals" className="btn btn-primary btn-sm">Schedule meals</Link>}>
                    Students can't vote until meals are scheduled and published.
                  </Empty>
                ) : (
                  <div className="panel ruled">
                    {data.today.map((s) => (
                      <MealRow key={s.id} s={s} />
                    ))}
                  </div>
                )}
              </section>
              <section className="section">
                <div className="section-title">
                  <h2>Next two days</h2>
                  <Link to="/supervisor/meals" className="text-sm">
                    Full schedule
                  </Link>
                </div>
                {data.upcoming.length === 0 ? (
                  <Empty title="Nothing scheduled yet">Schedule meals ahead so voting can open in time.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Meal</th>
                          <th>Status</th>
                          <th className="n">Yes so far</th>
                          <th>Menu</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.upcoming.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <Link className="row-link" to={`/supervisor/meals/${s.id}`}>
                                {s.mealType.name}
                              </Link>
                              <div className="text-xs muted">{relativeDay(s.serviceDate)}</div>
                            </td>
                            <td>
                              <StatusBadge status={s.status} />
                            </td>
                            <td className="n">{s.status === "DRAFT" ? <span className="null">—</span> : s.summary.liveYes}</td>
                            <td className="text-sm">{s.menu.length ? s.menu.map((m) => m.name).join(", ") : <span className="null">No menu</span>}</td>
                            <td>
                              <NextActionLink slot={s} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
            <Attention a={data.attention} />
          </div>
        )}
      </QueryState>
    </div>
  );
}
