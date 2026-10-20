import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, localToday } from "../../lib/format";
import type { SlotListItem } from "../../lib/types";
import { Empty, PageHeader, QueryState, StatusBadge } from "../../components/ui";
import { WithMess } from "./common";

export default function ReconcileList() {
  return <WithMess>{(messId) => <Body messId={messId} />}</WithMess>;
}

function Body({ messId }: { messId: number }) {
  const q = useQuery({
    queryKey: ["slots", messId, "reconcile"],
    queryFn: () => api.get<SlotListItem[]>(`/messes/${messId}/slots?from=${localToday(-14)}&to=${localToday()}`),
  });
  return (
    <div className="page">
      <PageHeader title="Reconcile" subtitle="Meals whose service has closed. Reconciliation compares declarations with the counter and issues warnings fairly." />
      <QueryState query={q}>
        {(slots) => {
          const pending = slots.filter((s) => s.status === "SERVICE_CLOSED" || s.status === "IN_SERVICE");
          const done = slots.filter((s) => s.status === "RECONCILED").reverse();
          return (
            <div className="stack" style={{ ["--gap" as string]: "28px" }}>
              <section className="section">
                <h2 style={{ fontSize: "var(--text-lg)" }}>Waiting</h2>
                {pending.length === 0 ? (
                  <Empty icon={<ClipboardCheck size={22} aria-hidden="true" />} title="Nothing to reconcile">
                    Meals appear here once service closes.
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Meal</th>
                          <th>Status</th>
                          <th className="n">Yes at cutoff</th>
                          <th className="n">Verified</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {pending.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <strong>{s.mealType.name}</strong> <span className="muted text-sm">{fmtDate(s.serviceDate)}</span>
                            </td>
                            <td>
                              <StatusBadge status={s.status} />
                            </td>
                            <td className="n">{s.summary.snapshot?.yes ?? "—"}</td>
                            <td className="n">{s.summary.attended}</td>
                            <td>
                              <Link className="btn btn-sm btn-primary" to={`/supervisor/meals/${s.id}/reconcile`}>
                                {s.status === "IN_SERVICE" ? "Preview" : "Reconcile"}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="section">
                <h2 style={{ fontSize: "var(--text-lg)" }}>Reconciled in the last two weeks</h2>
                {done.length === 0 ? (
                  <p className="text-sm muted">None yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Meal</th>
                          <th className="n">Yes at cutoff</th>
                          <th className="n">Ate</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {done.slice(0, 30).map((s) => (
                          <tr key={s.id}>
                            <td>
                              {s.mealType.name} <span className="muted text-sm">{fmtDate(s.serviceDate)}</span>
                            </td>
                            <td className="n">{s.summary.snapshot?.yes ?? "—"}</td>
                            <td className="n">{s.summary.attended}</td>
                            <td>
                              <Link to={`/supervisor/meals/${s.id}/reconcile`} className="text-sm">
                                View
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
