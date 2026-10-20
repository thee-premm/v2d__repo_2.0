import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { Button, Dialog, Empty, ErrorNotice, Notice, PageHeader, QueryState, TextAreaField, fieldError, useToast } from "../../components/ui";

interface Warning {
  id: number;
  tier: number;
  tierLabel: string;
  reason: string;
  status: "ACTIVE" | "APPEALED" | "UPHELD" | "WAIVED" | "VOIDED";
  issuedAt: string;
  meal: { serviceDate: string; mealType: string; messName: string };
  appealDeadline: string;
  canAppeal: boolean;
  appeal: { reason: string; status: string; submittedAt: string; resolvedAt: string | null; resolutionNote: string | null } | null;
}

const STATUS_TONE: Record<Warning["status"], string> = { ACTIVE: "warn", APPEALED: "info", UPHELD: "danger", WAIVED: "ok", VOIDED: "ok" };
const STATUS_LABEL: Record<Warning["status"], string> = { ACTIVE: "Active", APPEALED: "Under review", UPHELD: "Upheld", WAIVED: "Waived", VOIDED: "Withdrawn" };

function AppealDialog({ warning, onClose }: { warning: Warning; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/me/warnings/${warning.id}/appeal`, { reason }),
    onSuccess: () => {
      toast("Appeal submitted. Your supervisor will review it.");
      qc.invalidateQueries({ queryKey: ["student", "warnings"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Appeal this warning"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={reason.trim().length < 10} onClick={() => m.mutate()}>
            Submit appeal
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="text-sm muted">
          {warning.meal.mealType} on {fmtDate(warning.meal.serviceDate)} · {warning.tierLabel}. You can appeal once; explain what happened and mention anything the supervisor can check (for example, if the counter couldn't find you).
        </p>
        <TextAreaField label="What happened?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={5} hint={`${reason.trim().length}/2000 · at least 10 characters`} error={fieldError(m.error, "reason")} autoFocus />
        <ErrorNotice error={m.error && !fieldError(m.error, "reason") ? m.error : null} />
      </div>
    </Dialog>
  );
}

export default function StudentWarnings() {
  const q = useQuery({ queryKey: ["student", "warnings"], queryFn: () => api.get<{ policy: { windowDays: number; appealWindowDays: number }; items: Warning[] }>("/me/warnings") });
  const [appealing, setAppealing] = useState<Warning | null>(null);
  return (
    <div className="stack">
      <PageHeader title="Warnings & appeals" subtitle="A warning is recorded when you voted yes but the counter didn't record you after service. There are no fines." />
      <QueryState query={q}>
        {(data) => (
          <>
            <Notice tone="info">
              Warnings count over the last {data.policy.windowDays} days: a first one is a reminder, a second a formal warning, a third goes to review. You can appeal within {data.policy.appealWindowDays} days.
            </Notice>
            {data.items.length === 0 ? (
              <Empty icon={<ShieldCheck size={22} aria-hidden="true" />} title="No warnings">
                Thanks for keeping your votes accurate.
              </Empty>
            ) : (
              <div className="stack" style={{ ["--gap" as string]: "12px" }}>
                {data.items.map((w) => (
                  <article key={w.id} className="panel">
                    <div className="panel-body stack" style={{ ["--gap" as string]: "10px" }}>
                      <div className="row-between">
                        <div className="row">
                          <h3 style={{ fontSize: "var(--text-base)" }}>
                            {w.meal.mealType}, {fmtDate(w.meal.serviceDate)}
                          </h3>
                          <span className="badge badge-outline">{w.tierLabel}</span>
                        </div>
                        <span className={`badge badge-${STATUS_TONE[w.status]}`}>{STATUS_LABEL[w.status]}</span>
                      </div>
                      <p className="text-sm">{w.reason}</p>
                      {w.appeal && (
                        <div className="stack" style={{ ["--gap" as string]: "6px", paddingLeft: 12, borderLeft: "2px solid var(--line-strong)" }}>
                          <div className="text-sm">
                            <span className="muted">Your appeal ({fmtDateTime(w.appeal.submittedAt)}):</span> {w.appeal.reason}
                          </div>
                          {w.appeal.resolutionNote && (
                            <div className="text-sm">
                              <span className="muted">Decision:</span> {w.appeal.resolutionNote}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="row-between">
                        <span className="text-xs muted">Issued {fmtDateTime(w.issuedAt)}</span>
                        {w.canAppeal ? (
                          <Button size="sm" variant="primary" onClick={() => setAppealing(w)}>
                            Appeal · by {fmtDate(w.appealDeadline.slice(0, 10))}
                          </Button>
                        ) : w.status === "ACTIVE" ? (
                          <span className="text-xs muted">Appeal window closed</span>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </QueryState>
      {appealing && <AppealDialog warning={appealing} onClose={() => setAppealing(null)} />}
    </div>
  );
}
