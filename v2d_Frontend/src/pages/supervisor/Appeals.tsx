import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtTime } from "../../lib/format";
import { Button, Empty, ErrorNotice, PageHeader, QueryState, TextAreaField, useToast } from "../../components/ui";
import { WithMess } from "./common";

interface Appeal {
  id: number;
  status: "PENDING" | "UPHELD" | "WAIVED";
  reason: string;
  submittedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  student: { name: string; rollNumber: string };
  warning: { tier: number; reason: string; issuedAt: string };
  meal: { slotId: number; serviceDate: string; mealType: string };
  evidence: {
    voteEvents: { intent: string; previous_intent: string | null; recorded_at: string }[];
    counterRecords: { verified_at: string; voided_at: string | null; void_reason: string | null; verified_by: string }[];
    yesVoteRecord: { attended: number; no_shows: number };
  } | null;
}

function AppealCard({ a }: { a: Appeal }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: (decision: "UPHELD" | "WAIVED") => api.post(`/appeals/${a.id}/resolve`, { decision, note }),
    onSuccess: (_, decision) => {
      qc.invalidateQueries({ queryKey: ["appeals"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast(decision === "WAIVED" ? "Warning waived. The student was notified." : "Warning upheld. The student was notified.");
    },
  });
  const e = a.evidence;
  return (
    <article className="panel">
      <div className="panel-head">
        <h3>
          {a.student.name} <span className="mono text-sm muted">{a.student.rollNumber}</span>
        </h3>
        <span className="text-sm muted">
          {a.meal.mealType}, {fmtDate(a.meal.serviceDate)} · tier {a.warning.tier}
        </span>
      </div>
      <div className="panel-body grid-2">
        <div className="stack" style={{ ["--gap" as string]: "8px" }}>
          <span className="eyebrow">Student's explanation · {fmtDateTime(a.submittedAt)}</span>
          <blockquote style={{ margin: 0, paddingLeft: 12, borderLeft: "2px solid var(--accent)" }}>{a.reason}</blockquote>
        </div>
        {e && (
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            <span className="eyebrow">Evidence</span>
            <ul className="timeline text-sm">
              {e.voteEvents.map((v, i) => (
                <li key={i}>
                  Voted <strong>{v.intent}</strong>
                  {v.previous_intent && ` (was ${v.previous_intent})`} · {fmtDateTime(v.recorded_at)}
                </li>
              ))}
              {e.counterRecords.length === 0 ? (
                <li>No counter record for this meal</li>
              ) : (
                e.counterRecords.map((c, i) => (
                  <li key={i}>
                    Counter: verified {fmtTime(c.verified_at)} by {c.verified_by}
                    {c.voided_at && ` — voided: ${c.void_reason}`}
                  </li>
                ))
              )}
            </ul>
            <span className="text-sm muted">
              Record overall: attended after voting yes {e.yesVoteRecord.attended} times, no-show {e.yesVoteRecord.no_shows} times.
            </span>
          </div>
        )}
      </div>
      <div className="panel-foot stack" style={{ ["--gap" as string]: "10px" }}>
        <ErrorNotice error={m.error} />
        <TextAreaField label="Decision note to the student" rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} />
        <div className="row">
          <Button variant="primary" busy={m.isPending && m.variables === "WAIVED"} disabled={note.trim().length < 5 || m.isPending} onClick={() => m.mutate("WAIVED")}>
            Accept · waive warning
          </Button>
          <Button busy={m.isPending && m.variables === "UPHELD"} disabled={note.trim().length < 5 || m.isPending} onClick={() => m.mutate("UPHELD")}>
            Decline · uphold warning
          </Button>
        </div>
      </div>
    </article>
  );
}

export default function Appeals() {
  return <WithMess>{(messId) => <Body messId={messId} />}</WithMess>;
}

function Body({ messId }: { messId: number }) {
  const [tab, setTab] = useState<"PENDING" | "DONE">("PENDING");
  const q = useQuery({ queryKey: ["appeals", messId], queryFn: () => api.get<Appeal[]>(`/messes/${messId}/appeals`) });
  return (
    <div className="page">
      <PageHeader title="Appeals" subtitle="Students can appeal a no-show warning once. Decide with the vote history and counter records in front of you." />
      <div className="tabs" role="tablist" style={{ marginBottom: 20 }}>
        <button role="tab" aria-selected={tab === "PENDING"} onClick={() => setTab("PENDING")}>
          Pending {q.data && `(${q.data.filter((a) => a.status === "PENDING").length})`}
        </button>
        <button role="tab" aria-selected={tab === "DONE"} onClick={() => setTab("DONE")}>
          Resolved
        </button>
      </div>
      <QueryState query={q}>
        {(appeals) => {
          const list = appeals.filter((a) => (tab === "PENDING" ? a.status === "PENDING" : a.status !== "PENDING"));
          if (!list.length)
            return (
              <Empty icon={<Scale size={22} aria-hidden="true" />} title={tab === "PENDING" ? "No appeals waiting" : "No resolved appeals yet"}>
                {tab === "PENDING" ? "When a student appeals a warning it will appear here." : undefined}
              </Empty>
            );
          if (tab === "PENDING")
            return (
              <div className="stack">
                {list.map((a) => (
                  <AppealCard key={a.id} a={a} />
                ))}
              </div>
            );
          return (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Meal</th>
                    <th>Decision</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.student.name} <div className="text-xs muted mono">{a.student.rollNumber}</div>
                      </td>
                      <td className="text-sm">
                        {a.meal.mealType}, {fmtDate(a.meal.serviceDate)}
                      </td>
                      <td>
                        <span className={`badge ${a.status === "WAIVED" ? "badge-ok" : "badge-danger"}`}>{a.status === "WAIVED" ? "Waived" : "Upheld"}</span>
                        <div className="text-xs muted">
                          {a.resolvedBy} · {fmtDateTime(a.resolvedAt)}
                        </div>
                      </td>
                      <td className="text-sm">{a.resolutionNote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
