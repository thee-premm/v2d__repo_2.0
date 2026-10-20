import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { Button, ConfirmDialog, Empty, ErrorNotice, PageHeader, QueryState, SelectField, TextAreaField, fieldError, useToast } from "../../components/ui";
import { WithMess } from "../supervisor/common";

interface Incident {
  id: number;
  kind: string;
  ingredient: string | null;
  description: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  reportedBy: string;
  reportedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  meal: { mealType: string; serviceDate: string } | null;
}
const KINDS: Record<string, string> = {
  SHORTAGE: "Ingredient shortage",
  SUBSTITUTION: "Substitution made",
  DEVIATION: "Deviation from recipe/plan",
  EQUIPMENT: "Equipment problem",
  QUALITY: "Food quality / safety",
  OTHER: "Other",
};
const TONE: Record<Incident["status"], string> = { OPEN: "warn", ACKNOWLEDGED: "info", RESOLVED: "ok" };

export function ReportIncidentForm({ messId, mealSlotId, onDone }: { messId: number; mealSlotId?: number; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState("SHORTAGE");
  const [ingredientId, setIngredientId] = useState("");
  const [description, setDescription] = useState("");
  const ingredients = useQuery({ queryKey: ["catalog", "ingredients"], queryFn: () => api.get<{ id: number; name: string }[]>("/catalog/ingredients") });
  const m = useMutation({
    mutationFn: () => api.post(`/messes/${messId}/incidents`, { kind, description, ingredientId: ingredientId ? Number(ingredientId) : undefined, mealSlotId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents"] });
      toast("Reported. Your supervisor has been notified.");
      setDescription("");
      onDone?.();
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <ErrorNotice error={m.error && !fieldError(m.error, "description") ? m.error : null} />
      <div className="grid-2">
        <SelectField label="What happened" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        <SelectField label="Ingredient" optional value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}>
          <option value="">—</option>
          {ingredients.data?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </SelectField>
      </div>
      <TextAreaField label="Details" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Paneer delivery 4 kg short; used mixed vegetables instead" error={fieldError(m.error, "description")} />
      <div>
        <Button type="submit" variant="primary" busy={m.isPending} disabled={description.trim().length < 5}>
          Report to supervisor
        </Button>
      </div>
    </form>
  );
}

export default function Incidents({ mode }: { mode: "supervisor" | "kitchen" }) {
  return <WithMess>{(messId) => <Body messId={messId} mode={mode} />}</WithMess>;
}

function Body({ messId, mode }: { messId: number; mode: "supervisor" | "kitchen" }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["incidents", messId], queryFn: () => api.get<Incident[]>(`/messes/${messId}/incidents`) });
  const [resolving, setResolving] = useState<Incident | null>(null);
  const ack = useMutation({
    mutationFn: (id: number) => api.post(`/incidents/${id}`, { status: "ACKNOWLEDGED" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });
  return (
    <div className="page">
      <PageHeader title={mode === "kitchen" ? "Report an issue" : "Kitchen issues"} subtitle="Shortages, substitutions and equipment problems — they affect both waste and forecast accuracy." />
      <div className={mode === "kitchen" ? "split" : "stack"}>
        <div className="stack" style={{ order: mode === "kitchen" ? 2 : 1 }}>
          <QueryState query={q}>
            {(list) =>
              list.length === 0 ? (
                <Empty icon={<ShieldCheck size={22} aria-hidden="true" />} title="No issues reported" />
              ) : (
                <div className="stack" style={{ ["--gap" as string]: "10px" }}>
                  {list.map((i) => (
                    <article key={i.id} className="panel panel-body stack" style={{ ["--gap" as string]: "8px", opacity: i.status === "RESOLVED" ? 0.8 : 1 }}>
                      <div className="row-between">
                        <strong>
                          {KINDS[i.kind]}
                          {i.ingredient && <span className="muted"> · {i.ingredient}</span>}
                        </strong>
                        <span className={`badge badge-${TONE[i.status]}`}>{i.status.toLowerCase()}</span>
                      </div>
                      <p className="text-sm">{i.description}</p>
                      <div className="text-xs muted">
                        {i.reportedBy} · {fmtDateTime(i.reportedAt)}
                        {i.meal && ` · ${i.meal.mealType}, ${fmtDate(i.meal.serviceDate)}`}
                      </div>
                      {i.resolutionNote && <p className="text-sm">Resolution: {i.resolutionNote}</p>}
                      {mode === "supervisor" && i.status !== "RESOLVED" && (
                        <div className="row">
                          {i.status === "OPEN" && (
                            <Button size="sm" busy={ack.isPending && ack.variables === i.id} onClick={() => ack.mutate(i.id)}>
                              Acknowledge
                            </Button>
                          )}
                          <Button size="sm" variant="primary" onClick={() => setResolving(i)}>
                            Resolve
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )
            }
          </QueryState>
        </div>
        {mode === "kitchen" && (
          <section className="panel panel-body" style={{ order: 1 }}>
            <ReportIncidentForm messId={messId} />
          </section>
        )}
      </div>
      <ConfirmDialog
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title="Resolve issue"
        confirmLabel="Mark resolved"
        requireReason
        reasonLabel="How was it resolved?"
        onConfirm={async (note) => {
          await api.post(`/incidents/${resolving!.id}`, { status: "RESOLVED", resolutionNote: note });
          qc.invalidateQueries({ queryKey: ["incidents"] });
          qc.invalidateQueries({ queryKey: ["overview"] });
          toast("Issue resolved.");
        }}
      />
    </div>
  );
}
