import { Fragment, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, qs } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { Button, Empty, PageHeader, QueryState } from "../../components/ui";
import { useMesses } from "./Accounts";

interface AuditEvent {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  mess: { id: number; name: string } | null;
  actor: { name: string; username: string | null };
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: string;
}

const FILTERS = [
  ["", "Everything"],
  ["plan.", "Target approvals & overrides"],
  ["outcome.", "Reconciliation corrections"],
  ["attendance.", "Walk-ins, late entries, voids"],
  ["slot.", "Meal lifecycle"],
  ["role.", "Role changes"],
  ["user.", "Account changes"],
  ["institution.", "Policy changes"],
  ["appeal.", "Appeals"],
  ["auth.", "Sign-ins"],
  ["food_log.", "Food & waste records"],
];

export default function Audit() {
  const [params] = useSearchParams();
  const [action, setAction] = useState(params.get("action") ?? "plan.");
  const [messId, setMessId] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const messes = useMesses();
  const limit = 50;
  const q = useQuery({
    queryKey: ["admin", "audit", action, messId, page],
    queryFn: () => api.get<{ total: number; items: AuditEvent[] }>(`/admin/audit${qs({ action, messId, limit, offset: page * limit })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="page">
      <PageHeader title="Audit trail" subtitle="Append-only record of consequential changes: who, when, why, and what changed. Entries cannot be edited or deleted." />
      <div className="row" style={{ marginBottom: 16 }}>
        <select className="select" style={{ width: "auto" }} value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} aria-label="Type of change">
          {FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: "auto" }} value={messId} onChange={(e) => { setMessId(e.target.value); setPage(0); }} aria-label="Mess">
          <option value="">All messes</option>
          {messes.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <QueryState query={q} lines={8}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty title="No matching events" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Who</th>
                      <th>What</th>
                      <th>Reason</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <Fragment key={e.id}>
                        <tr>
                          <td className="text-sm" style={{ whiteSpace: "nowrap" }}>
                            {fmtDateTime(e.createdAt)}
                          </td>
                          <td className="text-sm">
                            {e.actor.name}
                            {e.actor.username && <div className="mono text-xs muted">{e.actor.username}</div>}
                          </td>
                          <td className="text-sm">
                            <span className="mono">{e.action}</span>
                            <div className="text-xs muted">
                              {e.entityType} {e.entityId}
                              {e.mess && ` · ${e.mess.name}`}
                            </div>
                          </td>
                          <td className="text-sm">{e.reason ?? <span className="null">—</span>}</td>
                          <td>
                            {(e.before !== null || e.after !== null) && (
                              <Button size="sm" variant="ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                                {open === e.id ? "Hide" : "Details"}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {open === e.id && (
                          <tr>
                            <td colSpan={5} style={{ background: "var(--surface-2)" }}>
                              <div className="grid-2">
                                <div>
                                  <div className="eyebrow">Before</div>
                                  <pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(e.before, null, 2) ?? "—"}</pre>
                                </div>
                                <div>
                                  <div className="eyebrow">After</div>
                                  <pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(e.after, null, 2) ?? "—"}</pre>
                                </div>
                              </div>
                              {e.requestId && <div className="text-xs muted" style={{ marginTop: 6 }}>Request {e.requestId}</div>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row-between" style={{ marginTop: 12 }}>
                <span className="text-sm muted">
                  {page * limit + 1}–{Math.min(d.total, (page + 1) * limit)} of {d.total}
                </span>
                <div className="row">
                  <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Newer
                  </Button>
                  <Button size="sm" disabled={(page + 1) * limit >= d.total} onClick={() => setPage(page + 1)}>
                    Older
                  </Button>
                </div>
              </div>
            </>
          )
        }
      </QueryState>
    </div>
  );
}
