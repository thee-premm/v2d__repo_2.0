import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hourglass, Play, Scale, Undo2 } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtTime } from "../../lib/format";
import type { SlotBase } from "../../lib/types";
import { Button, ConfirmDialog, Dialog, ErrorNotice, Kind, Notice, PageHeader, QueryState, SelectField, StatusBadge, TextAreaField, TextField, fieldError, useToast } from "../../components/ui";
import { ReportIncidentForm } from "../shared/Incidents";

interface Task {
  id: number;
  dishId: number;
  dishName: string;
  category: string | null;
  plannedServings: number;
  expectedKg: number | null;
  status: "PENDING" | "IN_PROGRESS" | "DONE";
  preparedKg: number | null;
  preparedMeasurement: string | null;
  deviationNote: string | null;
  completedAt: string | null;
  completedBy: string | null;
}
interface FoodLog {
  id: number;
  category: string;
  quantityKg: number;
  measurement: string;
  dishName: string | null;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
  voided: boolean;
  voidReason: string | null;
}
interface KitchenView {
  slot: SlotBase;
  approvedServings: number | null;
  canRecord: boolean;
  tasks: Task[];
  foodLogs: FoodLog[];
  incidents: { id: number; kind: string; description: string; status: string; reportedAt: string }[];
}

const CATEGORY: Record<string, { label: string; help: string }> = {
  REUSABLE_SURPLUS: { label: "Reusable surplus", help: "Cooked, not served, safe to repurpose" },
  DISCARDED_SURPLUS: { label: "Discarded leftovers", help: "Cooked, not served, thrown away" },
  PLATE_WASTE: { label: "Plate waste", help: "Served but left on plates" },
  KITCHEN_WASTE: { label: "Kitchen (prep) waste", help: "Peels, trimmings, spoilage during preparation" },
};

function CompleteDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qty, setQty] = useState(task.preparedKg !== null ? String(task.preparedKg) : task.expectedKg !== null ? String(task.expectedKg) : "");
  const [unit, setUnit] = useState("kg");
  const [measurement, setMeasurement] = useState(task.preparedMeasurement ?? "MEASURED");
  const [note, setNote] = useState(task.deviationNote ?? "");
  const m = useMutation({
    mutationFn: () => api.post(`/prep-tasks/${task.id}/complete`, { preparedQuantity: Number(qty), unit, measurement, deviationNote: note.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchen"] });
      toast(`${task.dishName} recorded as prepared.`);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${task.dishName} — prepared`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!(Number(qty) >= 0) || qty === ""} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="text-sm muted">
          Planned for {task.plannedServings} servings{task.expectedKg !== null && <> · about {fmtNum(task.expectedKg, 1)} kg cooked expected</>}.
        </p>
        <ErrorNotice error={m.error && !fieldError(m.error, "deviationNote") ? m.error : null} />
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
          <div style={{ flex: 1 }}>
            <TextField label="Cooked weight" type="number" min={0} step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div style={{ width: 96 }}>
            <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="kg">kg</option>
              <option value="g">g</option>
            </SelectField>
          </div>
        </div>
        <fieldset className="segmented" aria-label="How was it determined?">
          <label>
            <input type="radio" checked={measurement === "MEASURED"} onChange={() => setMeasurement("MEASURED")} />
            <span>
              <Scale size={14} aria-hidden="true" /> Weighed
            </span>
          </label>
          <label>
            <input type="radio" checked={measurement === "ESTIMATED"} onChange={() => setMeasurement("ESTIMATED")} />
            <span>Estimated</span>
          </label>
        </fieldset>
        <TextAreaField label="Substitution or deviation" optional rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Used moong dal — toor dal ran short" error={fieldError(m.error, "deviationNote")} />
      </div>
    </Dialog>
  );
}

function FoodLogForm({ slotId, dishes, slotStatus }: { slotId: number; dishes: { id: number; name: string }[]; slotStatus: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const servedStarted = ["IN_SERVICE", "SERVICE_CLOSED", "RECONCILED"].includes(slotStatus);
  const [category, setCategory] = useState(servedStarted ? "DISCARDED_SURPLUS" : "KITCHEN_WASTE");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("kg");
  const [measurement, setMeasurement] = useState("MEASURED");
  const [dishId, setDishId] = useState("");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/slots/${slotId}/food-logs`, { category, quantity: Number(qty), unit, measurement, dishId: dishId ? Number(dishId) : undefined, note: note.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kitchen"] });
      toast(`${CATEGORY[category].label}: ${qty} ${unit} recorded.`);
      setQty("");
      setNote("");
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
      <ErrorNotice error={m.error} />
      <SelectField label="What are you recording?" value={category} onChange={(e) => setCategory(e.target.value)} hint={CATEGORY[category].help}>
        {Object.entries(CATEGORY).map(([k, v]) => (
          <option key={k} value={k} disabled={!servedStarted && k !== "KITCHEN_WASTE"}>
            {v.label}
            {!servedStarted && k !== "KITCHEN_WASTE" ? " (after service starts)" : ""}
          </option>
        ))}
      </SelectField>
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
        <div style={{ flex: 1 }}>
          <TextField label="Weight" type="number" min={0} step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} hint="0 is a valid measurement." />
        </div>
        <div style={{ width: 96 }}>
          <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="kg">kg</option>
            <option value="g">g</option>
          </SelectField>
        </div>
      </div>
      <fieldset className="segmented" aria-label="How was it determined?">
        <label>
          <input type="radio" checked={measurement === "MEASURED"} onChange={() => setMeasurement("MEASURED")} />
          <span>
            <Scale size={14} aria-hidden="true" /> Weighed
          </span>
        </label>
        <label>
          <input type="radio" checked={measurement === "ESTIMATED"} onChange={() => setMeasurement("ESTIMATED")} />
          <span>Estimated</span>
        </label>
      </fieldset>
      <SelectField label="Dish" optional value={dishId} onChange={(e) => setDishId(e.target.value)}>
        <option value="">Whole meal</option>
        {dishes.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </SelectField>
      <TextField label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} />
      <div>
        <Button type="submit" variant="primary" busy={m.isPending} disabled={qty === "" || !(Number(qty) >= 0)}>
          Record
        </Button>
      </div>
    </form>
  );
}

export default function KitchenMeal() {
  const { slotId } = useParams();
  const id = Number(slotId);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["kitchen", "slot", id], queryFn: () => api.get<KitchenView>(`/slots/${id}/kitchen`), refetchInterval: 30_000 });
  const req = useQuery({ queryKey: ["kitchen", "req", id], queryFn: () => api.get<any>(`/slots/${id}/requirements`) });
  const [completing, setCompleting] = useState<Task | null>(null);
  const [voiding, setVoiding] = useState<number | null>(null);
  const start = useMutation({
    mutationFn: (taskId: number) => api.post(`/prep-tasks/${taskId}/start`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kitchen"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });

  return (
    <div className="page">
      <QueryState query={q} lines={8}>
        {(v) => {
          const s = v.slot;
          const canPrep = v.canRecord && ["APPROVED", "IN_SERVICE", "SERVICE_CLOSED"].includes(s.status);
          const active = v.foodLogs.filter((f) => !f.voided);
          const totals = Object.keys(CATEGORY).map((k) => ({ k, kg: active.filter((f) => f.category === k).reduce((a, f) => a + f.quantityKg, 0), n: active.filter((f) => f.category === k).length }));
          return (
            <>
              <PageHeader
                back={{ to: "/kitchen", label: "Preparation" }}
                title={`${s.mealType.name} · ${fmtDate(s.serviceDate)}`}
                subtitle={
                  <span className="row">
                    <StatusBadge status={s.status} /> <span className="mono">Serve {fmtTime(s.serviceStartsAt)}–{fmtTime(s.serviceEndsAt)}</span>
                  </span>
                }
                actions={
                  v.approvedServings !== null ? (
                    <div style={{ textAlign: "right" }}>
                      <div className="big-number num">{v.approvedServings}</div>
                      <div className="text-xs muted">servings approved</div>
                    </div>
                  ) : undefined
                }
              />
              {v.approvedServings === null && (
                <div style={{ marginBottom: 20 }}>
                  <Notice tone="warn" title="Not approved yet">
                    <Hourglass size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> Wait for the supervisor to approve a target before cooking.
                  </Notice>
                </div>
              )}
              <div className="split">
                <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                  <section className="panel">
                    <div className="panel-head">
                      <h3>Dishes</h3>
                      <span className="text-xs muted">{v.tasks.filter((t) => t.status === "DONE").length} of {v.tasks.length} done</span>
                    </div>
                    {v.tasks.length === 0 ? (
                      <div className="panel-body text-sm muted">Dishes appear once the target is approved.</div>
                    ) : (
                      <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {v.tasks.map((t) => (
                          <li key={t.id} className="task" data-status={t.status}>
                            <span className="task-check" aria-hidden="true">
                              <Check size={16} />
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div className="task-name strong">{t.dishName}</div>
                              <div className="text-sm muted num">
                                {t.plannedServings} servings{t.expectedKg !== null && ` · ~${fmtNum(t.expectedKg, 1)} kg`}
                                {t.status === "DONE" && t.preparedKg !== null && (
                                  <>
                                    {" "}
                                    · made <strong style={{ color: "var(--ink)" }}>{fmtNum(t.preparedKg, 2)} kg</strong> <Kind kind={t.preparedMeasurement ?? "MEASURED"} />
                                  </>
                                )}
                              </div>
                              {t.deviationNote && <div className="text-xs" style={{ color: "var(--accent-text)" }}>{t.deviationNote}</div>}
                            </div>
                            <div className="row" style={{ flexWrap: "nowrap" }}>
                              {canPrep && t.status === "PENDING" && (
                                <Button size="sm" icon={<Play size={14} />} busy={start.isPending && start.variables === t.id} onClick={() => start.mutate(t.id)}>
                                  Start
                                </Button>
                              )}
                              {canPrep && (
                                <Button size="sm" variant={t.status === "DONE" ? "ghost" : "primary"} onClick={() => setCompleting(t)}>
                                  {t.status === "DONE" ? "Correct" : "Mark done"}
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="panel">
                    <div className="panel-head">
                      <h3>Ingredients</h3>
                      <span className="text-xs muted">Raw quantities, before trimming</span>
                    </div>
                    <QueryState query={req}>
                      {(r) =>
                        r.ingredients.length === 0 ? (
                          <div className="panel-body text-sm muted">No recipe quantities available.</div>
                        ) : (
                          <table className="table">
                            <tbody>
                              {r.ingredients.map((i: any) => (
                                <tr key={i.ingredientId}>
                                  <td>{i.name}</td>
                                  <td className="n strong">
                                    {fmtNum(i.required, i.unit === "unit" ? 0 : 2)} {i.unit}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )
                      }
                    </QueryState>
                    {req.data?.missingRecipes?.length > 0 && (
                      <div className="panel-foot text-sm" style={{ color: "var(--warn-text)" }}>
                        No recipe for {req.data.missingRecipes.map((d: any) => d.name).join(", ")} — use your usual quantities and note it.
                      </div>
                    )}
                  </section>
                </div>

                <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                  {v.canRecord && (
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Leftovers & waste</h3>
                      </div>
                      <div className="panel-body">
                        <FoodLogForm slotId={s.id} slotStatus={s.status} dishes={v.tasks.map((t) => ({ id: t.dishId, name: t.dishName }))} />
                      </div>
                    </section>
                  )}
                  <section className="panel">
                    <div className="panel-head">
                      <h3>Recorded</h3>
                    </div>
                    <div className="panel-body stack" style={{ ["--gap" as string]: "10px" }}>
                      <dl className="dl text-sm">
                        {totals.map((t) => (
                          <div key={t.k} style={{ display: "contents" }}>
                            <dt>{CATEGORY[t.k].label}</dt>
                            <dd className="num">{t.n ? `${fmtNum(t.kg, 2)} kg` : <span className="muted">Not recorded</span>}</dd>
                          </div>
                        ))}
                      </dl>
                      {v.foodLogs.length > 0 && (
                        <ul className="ruled text-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                          {v.foodLogs.map((f) => (
                            <li key={f.id} className="row" style={{ padding: "6px 0", flexWrap: "nowrap", opacity: f.voided ? 0.55 : 1 }}>
                              <span style={{ flex: 1, minWidth: 0, textDecoration: f.voided ? "line-through" : undefined }}>
                                {CATEGORY[f.category].label}: <strong>{fmtNum(f.quantityKg, 2)} kg</strong> {f.measurement === "ESTIMATED" && <Kind kind="estimate" />}
                                <span className="text-xs muted" style={{ display: "block" }}>
                                  {f.recordedBy} · {fmtDateTime(f.recordedAt)}
                                  {f.dishName && ` · ${f.dishName}`}
                                  {f.voided && ` · voided: ${f.voidReason}`}
                                </span>
                              </span>
                              {!f.voided && v.canRecord && (
                                <button className="icon-btn" onClick={() => setVoiding(f.id)} aria-label="Void this entry" title="Void (wrong entry)">
                                  <Undo2 size={15} />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>
                  {v.canRecord && (
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Report a problem</h3>
                      </div>
                      <div className="panel-body">
                        <ReportIncidentForm messId={s.messId} mealSlotId={s.id} />
                      </div>
                    </section>
                  )}
                </div>
              </div>
              {completing && <CompleteDialog task={completing} onClose={() => setCompleting(null)} />}
              <ConfirmDialog
                open={voiding !== null}
                onClose={() => setVoiding(null)}
                title="Void this entry?"
                body={<p className="text-sm">The entry stays in the record, marked void. Add a corrected entry afterwards if needed.</p>}
                confirmLabel="Void entry"
                tone="danger"
                requireReason
                onConfirm={async (reason) => {
                  await api.post(`/food-logs/${voiding}/void`, { reason });
                  qc.invalidateQueries({ queryKey: ["kitchen"] });
                }}
              />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
