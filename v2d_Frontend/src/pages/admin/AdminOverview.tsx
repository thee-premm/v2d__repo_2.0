import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtNum, fmtPct, ROLE_LABEL } from "../../lib/format";
import { PageHeader, QueryState, statusLabel } from "../../components/ui";
import type { SlotStatus } from "../../lib/types";

interface Overview {
  institution: { name: string; timezone: string };
  date: string;
  messes: {
    id: number;
    code: string;
    name: string;
    isActive: boolean;
    members: number;
    supervisors: number;
    todayByStatus: Record<string, number>;
    participation7d: number | null;
    dataQuality30d: { closedMeals: number; wasteRecorded: number; reconciled: number; wasteCompleteness: number | null } | null;
  }[];
  accounts: Record<string, Record<string, number> & { total: number }>;
  exceptions: { open_incidents: number; pending_appeals: number; stale_unreconciled: number; started_without_approval: number; sensitive_changes_7d: number };
}

export default function AdminOverview() {
  const q = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.get<Overview>("/admin/overview"), refetchInterval: 60_000 });
  return (
    <div className="page">
      <QueryState query={q} lines={8}>
        {(o) => {
          const ex = o.exceptions;
          const exceptions = [
            { n: ex.stale_unreconciled, text: "closed meals not reconciled since yesterday or earlier", to: "/admin/audit" },
            { n: ex.started_without_approval, text: "meals reached service time without an approved target", to: "/admin/audit" },
            { n: ex.pending_appeals, text: "appeals awaiting a supervisor decision", to: "/admin/audit?action=appeal" },
            { n: ex.open_incidents, text: "kitchen issues unresolved", to: "/admin/audit?action=incident" },
          ].filter((e) => e.n > 0);
          return (
            <>
              <PageHeader title={o.institution.name} subtitle={`Overview · ${fmtDate(o.date, "long")} · ${o.institution.timezone}`} actions={<Link className="btn" to="/admin/analyze">Institution analytics</Link>} />
              <div className="stack" style={{ ["--gap" as string]: "28px" }}>
                <div className="stats">
                  {(["STUDENT", "SUPERVISOR", "KITCHEN_STAFF", "INSTITUTION_ADMIN"] as const).map((r) => (
                    <div className="stat" key={r}>
                      <div className="stat-label">{ROLE_LABEL[r]}s</div>
                      <div className="stat-value num">{fmtNum(o.accounts[r]?.total ?? 0)}</div>
                      <div className="stat-foot">{o.accounts[r]?.INVITED ? `${o.accounts[r].INVITED} not yet activated` : "all activated"}</div>
                    </div>
                  ))}
                  <div className="stat">
                    <div className="stat-label">Sensitive changes</div>
                    <div className="stat-value num">{ex.sensitive_changes_7d}</div>
                    <div className="stat-foot">
                      overrides & corrections, 7 days · <Link to="/admin/audit">review</Link>
                    </div>
                  </div>
                </div>

                {exceptions.length > 0 && (
                  <section className="panel">
                    <div className="panel-head">
                      <h3>Operational exceptions</h3>
                    </div>
                    <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {exceptions.map((e) => (
                        <li key={e.text} className="row" style={{ padding: "10px 20px" }}>
                          <AlertTriangle size={16} color="var(--warn)" aria-hidden="true" />
                          <span>
                            <strong className="num">{e.n}</strong> {e.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="section">
                  <div className="section-title">
                    <h2>Messes</h2>
                    <Link to="/admin/structure" className="text-sm">
                      Manage structure
                    </Link>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Mess</th>
                          <th className="n">Students</th>
                          <th className="n">Supervisors</th>
                          <th>Today</th>
                          <th className="n">Participation (7 d)</th>
                          <th className="n">Waste recorded (30 d)</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {o.messes.map((m) => (
                          <tr key={m.id}>
                            <td>
                              <strong>{m.name}</strong> <span className="text-xs muted mono">{m.code}</span>
                              {!m.isActive && <span className="badge" style={{ marginLeft: 6 }}>Inactive</span>}
                            </td>
                            <td className="n">{fmtNum(m.members)}</td>
                            <td className="n" style={{ color: m.supervisors === 0 ? "var(--danger-text)" : undefined }}>
                              {m.supervisors}
                              {m.supervisors === 0 && " · none!"}
                            </td>
                            <td className="text-sm">
                              {Object.keys(m.todayByStatus).length === 0 ? (
                                <span className="null">No meals</span>
                              ) : (
                                Object.entries(m.todayByStatus)
                                  .map(([s, n]) => `${n} ${statusLabel(s as SlotStatus).toLowerCase()}`)
                                  .join(" · ")
                              )}
                            </td>
                            <td className="n">{fmtPct(m.participation7d)}</td>
                            <td className="n">
                              {m.dataQuality30d?.closedMeals ? `${m.dataQuality30d.wasteRecorded}/${m.dataQuality30d.closedMeals} (${fmtNum(m.dataQuality30d.wasteCompleteness, 0)}%)` : <span className="null">—</span>}
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-ghost" to={`/admin/analyze/mess/${m.id}`}>
                                Analyze <ArrowUpRight size={13} aria-hidden="true" />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
