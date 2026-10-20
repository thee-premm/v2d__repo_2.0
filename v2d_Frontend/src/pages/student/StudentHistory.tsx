import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtTime } from "../../lib/format";
import { Button, Empty, IntentBadge, PageHeader, QueryState } from "../../components/ui";

export interface HistoryItem {
  slotId: number;
  serviceDate: string;
  mealType: { code: string; name: string };
  messName: string;
  status: string;
  intentAtCutoff: string;
  attended: boolean;
  attendedAt: string | null;
  walkIn: string | null;
  classification: string | null;
  note: string | null;
  warning: { id: number; tier: number; status: string } | null;
}

const OUTCOME: Record<string, { label: string; tone: string }> = {
  YES_ATTENDED: { label: "As declared", tone: "ok" },
  NO_ABSENT: { label: "As declared", tone: "ok" },
  YES_NO_SHOW: { label: "Missed after voting yes", tone: "warn" },
  NO_WALK_IN: { label: "Came after voting no", tone: "info" },
  UNVOTED_ATTENDED: { label: "Came without voting", tone: "info" },
  UNVOTED_ABSENT: { label: "Didn't vote, didn't come", tone: "outline" },
  EXCUSED: { label: "Excused", tone: "info" },
};

const PAGE = 20;

export default function StudentHistory() {
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ["student", "history", page],
    queryFn: () => api.get<{ items: HistoryItem[]; total: number }>(`/me/history?limit=${PAGE}&offset=${page * PAGE}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="stack">
      <PageHeader title="Your meal history" subtitle="What you declared at the cutoff, and what the counter recorded — kept separate on purpose." />
      <QueryState query={q} lines={8}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty icon={<History size={22} aria-hidden="true" />} title="No history yet">
              Meals appear here once voting closes.
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Meal history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Meal</th>
                      <th scope="col">You declared</th>
                      <th scope="col">Counter record</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((h) => {
                      const o = h.classification ? OUTCOME[h.classification] : null;
                      return (
                        <tr key={h.slotId}>
                          <td>
                            <div className="strong">{h.mealType.name}</div>
                            <div className="text-sm muted">{fmtDate(h.serviceDate)}</div>
                          </td>
                          <td>{h.intentAtCutoff === "NOT_ELIGIBLE_AT_CUTOFF" ? <span className="muted text-sm">Joined after cutoff</span> : <IntentBadge intent={h.intentAtCutoff} />}</td>
                          <td>
                            {h.attended ? (
                              <span className="text-sm">
                                Ate{h.attendedAt ? <span className="muted"> at {fmtTime(h.attendedAt)}</span> : null}
                                {h.walkIn && <span className="muted"> · walk-in</span>}
                              </span>
                            ) : h.status === "RECONCILED" ? (
                              <span className="text-sm muted">No record</span>
                            ) : (
                              <span className="text-sm muted">Pending</span>
                            )}
                          </td>
                          <td>
                            {o ? <span className={`badge badge-${o.tone}`}>{o.label}</span> : <span className="text-sm muted">Not yet reconciled</span>}
                            {h.warning && (
                              <div className="text-xs muted" style={{ marginTop: 4 }}>
                                Warning {h.warning.status.toLowerCase()}
                              </div>
                            )}
                            {h.note && <div className="text-xs muted">{h.note}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row-between">
                <span className="text-sm muted">
                  {page * PAGE + 1}–{Math.min(data.total, (page + 1) * PAGE)} of {data.total}
                </span>
                <div className="row">
                  <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Newer
                  </Button>
                  <Button size="sm" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage((p) => p + 1)}>
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
