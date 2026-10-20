import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Pencil } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtNum } from "../../lib/format";
import type { SlotDetail } from "../../lib/types";
import { Button, ConfirmDialog, Dialog, ErrorNotice, IntentBadge, Notice, PageHeader, QueryState, TextAreaField, useToast } from "../../components/ui";

export const CLASS_INFO: Record<string, { label: string; help: string; tone: string }> = {
  YES_ATTENDED: { label: "Voted yes · ate", help: "Declared and attended", tone: "ok" },
  YES_NO_SHOW: { label: "Voted yes · no record", help: "Potential no-show — receives a warning", tone: "warn" },
  EXCUSED: { label: "Excused", help: "Voted yes, absent with an accepted reason", tone: "info" },
  NO_ABSENT: { label: "Voted no · stayed away", help: "Declared and kept to it", tone: "ok" },
  NO_WALK_IN: { label: "Voted no · came anyway", help: "Walk-in (policy or authorized)", tone: "info" },
  UNVOTED_ATTENDED: { label: "No vote · ate", help: "Non-responder who came", tone: "outline" },
  UNVOTED_ABSENT: { label: "No vote · stayed away", help: "Non-responder who didn't come", tone: "outline" },
};
const ORDER = ["YES_ATTENDED", "YES_NO_SHOW", "EXCUSED", "NO_ABSENT", "NO_WALK_IN", "UNVOTED_ATTENDED", "UNVOTED_ABSENT"];

interface Preview {
  state: "READY" | "SERVICE_OPEN";
  summary: { counts: Record<string, number>; eligibleAtCutoff: number; notInSnapshot: number; actualAttendance: number };
  warningPolicy: { enabled: boolean; windowDays: number };
  noShowCandidates: { studentUserId: number; name: string; rollNumber: string; priorWarningsInWindow: number; wouldReceiveTier: number | null }[];
}
interface Reconciled {
  state: "RECONCILED";
  reconciledAt: string;
  reconciledBy: string;
  actualAttendance: number;
  summary: { counts: Record<string, number>; excused?: number; warningsIssued?: number; corrections?: number };
  outcomes: {
    studentUserId: number;
    name: string;
    rollNumber: string;
    intent: string;
    attended: boolean;
    classification: string;
    excuseReason: string | null;
    correctedAt: string | null;
    correctedBy: string | null;
    correctionReason: string | null;
    warning: { id: number; tier: number; status: string } | null;
  }[];
}

function ClassificationTable({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Outcome counts</caption>
        <thead>
          <tr>
            <th>Outcome</th>
            <th>Meaning</th>
            <th className="n">Students</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.map((k) => (
            <tr key={k}>
              <td>
                <span className={`badge badge-${CLASS_INFO[k].tone}`}>{CLASS_INFO[k].label}</span>
              </td>
              <td className="text-sm muted">{CLASS_INFO[k].help}</td>
              <td className="n strong">{fmtNum(counts[k] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CorrectDialog({ slotId, row, onClose }: { slotId: number; row: Reconciled["outcomes"][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [attended, setAttended] = useState(row.attended);
  const [excuse, setExcuse] = useState("");
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/slots/${slotId}/outcomes/${row.studentUserId}/correct`, { attended: attended !== row.attended ? attended : undefined, excuseReason: excuse.trim() || undefined, reason }),
    onSuccess: (d) => {
      qc.setQueryData(["reconciliation", slotId], d);
      toast("Outcome corrected. The student was notified if a warning changed.");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Correct ${row.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={reason.trim().length < 5 || (attended === row.attended && !excuse.trim())} onClick={() => m.mutate()}>
            Save correction
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row text-sm">
          <span className="mono">{row.rollNumber}</span> <IntentBadge intent={row.intent} /> <span className={`badge badge-${CLASS_INFO[row.classification].tone}`}>{CLASS_INFO[row.classification].label}</span>
        </div>
        <ErrorNotice error={m.error} />
        <fieldset className="segmented" aria-label="Attendance">
          <label>
            <input type="radio" checked={attended} onChange={() => setAttended(true)} />
            <span>Ate</span>
          </label>
          <label>
            <input type="radio" checked={!attended} onChange={() => setAttended(false)} />
            <span>Did not eat</span>
          </label>
        </fieldset>
        {row.intent === "YES" && !attended && <TextAreaField label="Excuse" optional rows={2} value={excuse} onChange={(e) => setExcuse(e.target.value)} hint="Excusing removes the no-show warning." />}
        <TextAreaField label="Reason for this correction" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the audit trail with your name." />
      </div>
    </Dialog>
  );
}

export default function Reconcile() {
  const { slotId } = useParams();
  const id = Number(slotId);
  const qc = useQueryClient();
  const toast = useToast();
  const slot = useQuery({ queryKey: ["slot", id], queryFn: () => api.get<SlotDetail>(`/slots/${id}`) });
  const q = useQuery({ queryKey: ["reconciliation", id], queryFn: () => api.get<Preview | Reconciled>(`/slots/${id}/reconciliation`) });
  const [excused, setExcused] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [filter, setFilter] = useState("ALL");
  const [correcting, setCorrecting] = useState<Reconciled["outcomes"][number] | null>(null);
  const excusals = useMemo(() => Object.entries(excused).filter(([, r]) => r.trim().length >= 5).map(([studentUserId, reason]) => ({ studentUserId: Number(studentUserId), reason: reason.trim() })), [excused]);
  const incompleteExcuse = Object.values(excused).some((r) => r.trim().length > 0 && r.trim().length < 5);

  return (
    <div className="page">
      <PageHeader
        back={{ to: `/supervisor/meals/${id}`, label: "Meal" }}
        title={slot.data ? `Reconcile · ${slot.data.mealType.name}, ${fmtDate(slot.data.serviceDate)}` : "Reconcile"}
        subtitle="Compare each student's declaration with the counter record. Warnings are issued only when you finalize."
      />
      <QueryState query={q} lines={8}>
        {(data) => {
          if (data.state === "RECONCILED") {
            const rows = data.outcomes.filter((o) => filter === "ALL" || o.classification === filter);
            return (
              <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                <Notice tone="ok" title={`Reconciled by ${data.reconciledBy} · ${fmtDateTime(data.reconciledAt)}`}>
                  {data.actualAttendance} ate · {data.summary.warningsIssued ?? 0} warning(s) issued · {data.summary.excused ?? 0} excused
                  {data.summary.corrections ? ` · ${data.summary.corrections} later correction(s)` : ""}
                </Notice>
                <ClassificationTable counts={data.summary.counts} />
                <div className="row-between">
                  <h2 style={{ fontSize: "var(--text-lg)" }}>Students</h2>
                  <select className="select" style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by outcome">
                    <option value="ALL">All outcomes ({data.outcomes.length})</option>
                    {ORDER.map((k) => (
                      <option key={k} value={k}>
                        {CLASS_INFO[k].label} ({data.summary.counts[k] ?? 0})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Declared</th>
                        <th>Outcome</th>
                        <th>Notes</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 300).map((o) => (
                        <tr key={o.studentUserId}>
                          <td>
                            <div className="strong">{o.name}</div>
                            <div className="text-xs muted mono">{o.rollNumber}</div>
                          </td>
                          <td>
                            <IntentBadge intent={o.intent} />
                          </td>
                          <td>
                            <span className={`badge badge-${CLASS_INFO[o.classification].tone}`}>{CLASS_INFO[o.classification].label}</span>
                            {o.warning && <div className="text-xs muted">Warning tier {o.warning.tier} · {o.warning.status.toLowerCase()}</div>}
                          </td>
                          <td className="text-sm">
                            {o.excuseReason && <div>Excused: {o.excuseReason}</div>}
                            {o.correctionReason && (
                              <div className="muted">
                                Corrected by {o.correctedBy}: {o.correctionReason}
                              </div>
                            )}
                          </td>
                          <td>
                            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setCorrecting(o)}>
                              Correct
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > 300 && <p className="text-sm muted">Showing the first 300. Use the filter to narrow down.</p>}
                {correcting && <CorrectDialog slotId={id} row={correcting} onClose={() => setCorrecting(null)} />}
              </div>
            );
          }
          return (
            <div className="split">
              <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                {data.state === "SERVICE_OPEN" && (
                  <Notice tone="warn" title="Service is still open">
                    This is a live preview. Close service before reconciling so no one is marked absent while still eating.
                  </Notice>
                )}
                <ClassificationTable counts={data.summary.counts} />
                <section className="section">
                  <div className="section-title">
                    <h2>No-show candidates</h2>
                    <span className="text-sm muted">{data.noShowCandidates.length} voted yes without a counter record</span>
                  </div>
                  {data.noShowCandidates.length === 0 ? (
                    <Notice tone="ok">Everyone who voted yes was verified at the counter.</Notice>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Student</th>
                            <th className="n">Prior warnings ({data.warningPolicy.windowDays} d)</th>
                            <th>If not excused</th>
                            <th>Excuse (optional)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.noShowCandidates.map((c) => (
                            <tr key={c.studentUserId}>
                              <td>
                                <div className="strong">{c.name}</div>
                                <div className="text-xs muted mono">{c.rollNumber}</div>
                              </td>
                              <td className="n">{c.priorWarningsInWindow}</td>
                              <td className="text-sm">{c.wouldReceiveTier ? ["", "Reminder", "Formal warning", "Escalated"][c.wouldReceiveTier] : "No warning (disabled)"}</td>
                              <td style={{ minWidth: 220 }}>
                                <input
                                  className="input"
                                  placeholder="e.g. Medical certificate"
                                  value={excused[c.studentUserId] ?? ""}
                                  onChange={(e) => setExcused({ ...excused, [c.studentUserId]: e.target.value })}
                                  aria-label={`Excuse reason for ${c.name}`}
                                  style={{ minHeight: 32 }}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
              <aside className="panel panel-body stack">
                <h3>Finalize</h3>
                <dl className="dl text-sm">
                  <dt>Eligible at cutoff</dt>
                  <dd className="num">{data.summary.eligibleAtCutoff}</dd>
                  <dt>Ate</dt>
                  <dd className="num">{data.summary.actualAttendance}</dd>
                  <dt>Joined after cutoff</dt>
                  <dd className="num">{data.summary.notInSnapshot}</dd>
                  <dt>Excused</dt>
                  <dd className="num">{excusals.length}</dd>
                  <dt>Warnings to issue</dt>
                  <dd className="num strong">{data.warningPolicy.enabled ? data.noShowCandidates.length - excusals.length : 0}</dd>
                </dl>
                {incompleteExcuse && <p className="field-error text-sm">Excuse reasons need at least 5 characters.</p>}
                <Button variant="primary" icon={<ClipboardCheck size={16} />} disabled={data.state !== "READY" || incompleteExcuse} onClick={() => setConfirm(true)}>
                  Finalize reconciliation
                </Button>
                <p className="text-xs muted">Students are notified of warnings and can appeal. Running this twice has no extra effect.</p>
              </aside>
              <ConfirmDialog
                open={confirm}
                onClose={() => setConfirm(false)}
                title="Finalize reconciliation?"
                body={<p className="text-sm">This records every student's outcome and issues {data.noShowCandidates.length - excusals.length} warning(s). Later changes are corrections with a reason.</p>}
                confirmLabel="Finalize"
                onConfirm={async () => {
                  const res = await api.post<Reconciled>(`/slots/${id}/reconcile`, { excusals });
                  qc.setQueryData(["reconciliation", id], res);
                  qc.invalidateQueries({ queryKey: ["slot", id] });
                  qc.invalidateQueries({ queryKey: ["overview"] });
                  toast("Reconciled.");
                }}
              />
            </div>
          );
        }}
      </QueryState>
      <p className="text-sm muted" style={{ marginTop: 24 }}>
        <Link to="/supervisor/reconcile">All meals to reconcile</Link>
      </p>
    </div>
  );
}
