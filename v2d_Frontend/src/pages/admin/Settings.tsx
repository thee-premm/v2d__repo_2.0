import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { Button, Dialog, ErrorNotice, Kind, PageHeader, QueryState, SelectField, TextAreaField, TextField, useToast } from "../../components/ui";
import { useMealTypes, type MealType } from "../supervisor/Meals";
import { useMesses } from "./Accounts";

interface Settings {
  walkIn: { noVoter: string; unvoted: string };
  warnings: { enabled: boolean; windowDays: number; appealWindowDays: number };
  service: { earlyStartMinutes: number };
  forecast: { serviceLevel: number; historyWindowDays: number; maxHistorySlots: number; priors: Record<"yes" | "no" | "unvoted", { rate: number; strength: number }> };
  analytics: { foodCostPerKg: number | null; co2ePerKgFoodWaste: number; co2eFactorSource: string };
  notifications: { closingReminderMinutes: number };
}
interface Inst {
  name: string;
  timezone: string;
  currency: string;
  settings: Settings;
}

function PolicyForm({ inst }: { inst: Inst }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<Settings>(inst.settings);
  const [meta, setMeta] = useState({ name: inst.name, timezone: inst.timezone, currency: inst.currency });
  useEffect(() => setS(inst.settings), [inst.settings]);
  const save = useMutation({
    mutationFn: async () => {
      await api.patch("/admin/institution", meta);
      return api.put("/admin/settings", s);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "institution"] });
      qc.invalidateQueries({ queryKey: ["session"] });
      toast("Policies saved. Changes are recorded in the audit trail.");
    },
  });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const prior = (g: "yes" | "no" | "unvoted", label: string) => (
    <TextField
      label={label}
      type="number"
      min={0}
      max={100}
      step="1"
      value={Math.round(s.forecast.priors[g].rate * 100)}
      onChange={(e) => setS({ ...s, forecast: { ...s.forecast, priors: { ...s.forecast.priors, [g]: { ...s.forecast.priors[g], rate: num(e.target.value) / 100 } } } })}
      hint="% who attend"
    />
  );
  return (
    <form
      className="stack"
      style={{ ["--gap" as string]: "20px" }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorNotice error={save.error} />
      <section className="panel">
        <div className="panel-head">
          <h3>Institution</h3>
        </div>
        <div className="panel-body grid-3">
          <TextField label="Name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          <TextField label="Timezone" value={meta.timezone} onChange={(e) => setMeta({ ...meta, timezone: e.target.value })} hint="IANA name, e.g. Asia/Kolkata. Deadlines are evaluated in it." />
          <TextField label="Currency" value={meta.currency} maxLength={3} onChange={(e) => setMeta({ ...meta, currency: e.target.value.toUpperCase() })} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Walk-ins at the counter</h3>
        </div>
        <div className="panel-body grid-2">
          <SelectField label="Student who voted NO arrives" value={s.walkIn.noVoter} onChange={(e) => setS({ ...s, walkIn: { ...s.walkIn, noVoter: e.target.value } })}>
            <option value="REQUIRE_AUTHORIZATION">Counter must authorize, with a reason</option>
            <option value="ALLOW">Admit automatically (recorded as walk-in)</option>
          </SelectField>
          <SelectField label="Student who did not vote arrives" value={s.walkIn.unvoted} onChange={(e) => setS({ ...s, walkIn: { ...s.walkIn, unvoted: e.target.value } })}>
            <option value="ALLOW">Admit automatically (recorded as walk-in)</option>
            <option value="REQUIRE_AUTHORIZATION">Counter must authorize, with a reason</option>
          </SelectField>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>No-show warnings</h3>
        </div>
        <div className="panel-body stack">
          <label className="check">
            <input type="checkbox" checked={s.warnings.enabled} onChange={(e) => setS({ ...s, warnings: { ...s.warnings, enabled: e.target.checked } })} />
            <span>Issue warnings when a YES voter has no counter record after reconciliation (never a fine)</span>
          </label>
          <div className="grid-3">
            <TextField label="Tier window (days)" type="number" min={1} max={365} value={s.warnings.windowDays} onChange={(e) => setS({ ...s, warnings: { ...s.warnings, windowDays: num(e.target.value) } })} hint="Warnings in this window raise the tier" />
            <TextField label="Appeal window (days)" type="number" min={1} max={60} value={s.warnings.appealWindowDays} onChange={(e) => setS({ ...s, warnings: { ...s.warnings, appealWindowDays: num(e.target.value) } })} />
            <TextField label="Counter may open early (min)" type="number" min={0} max={180} value={s.service.earlyStartMinutes} onChange={(e) => setS({ ...s, service: { earlyStartMinutes: num(e.target.value) } })} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>
            Forecasting <Kind kind="estimate" />
          </h3>
        </div>
        <div className="panel-body stack">
          <div className="grid-3">
            <TextField
              label="Service level (%)"
              type="number"
              min={50}
              max={99.5}
              step="0.5"
              value={Math.round(s.forecast.serviceLevel * 1000) / 10}
              onChange={(e) => setS({ ...s, forecast: { ...s.forecast, serviceLevel: num(e.target.value) / 100 } })}
              hint="Chance the recommended target covers attendance. Higher = more buffer."
            />
            <TextField label="History window (days)" type="number" min={7} max={365} value={s.forecast.historyWindowDays} onChange={(e) => setS({ ...s, forecast: { ...s.forecast, historyWindowDays: num(e.target.value) } })} />
            <TextField label="Reminder before cutoff (min)" type="number" min={5} max={1440} value={s.notifications.closingReminderMinutes} onChange={(e) => setS({ ...s, notifications: { closingReminderMinutes: num(e.target.value) } })} />
          </div>
          <p className="text-sm muted">Starting assumptions, used until reconciled history exists (each counts as {s.forecast.priors.yes.strength} observations, so real data quickly takes over):</p>
          <div className="grid-3">
            {prior("yes", "Yes voters")}
            {prior("no", "No voters")}
            {prior("unvoted", "Non-voters")}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>
            Analytics factors <Kind kind="estimate" />
          </h3>
        </div>
        <div className="panel-body grid-2">
          <TextField
            label={`Food cost per kg (${meta.currency})`}
            optional
            type="number"
            min={0}
            step="any"
            value={s.analytics.foodCostPerKg ?? ""}
            onChange={(e) => setS({ ...s, analytics: { ...s.analytics, foodCostPerKg: e.target.value === "" ? null : Number(e.target.value) } })}
            hint="Used only when ingredient costs can't derive it. Empty = unknown (no cost shown)."
          />
          <TextField label="kg CO₂e per kg food waste" type="number" min={0} step="0.1" value={s.analytics.co2ePerKgFoodWaste} onChange={(e) => setS({ ...s, analytics: { ...s.analytics, co2ePerKgFoodWaste: num(e.target.value) } })} />
          <TextField label="Source of the emission factor" value={s.analytics.co2eFactorSource} onChange={(e) => setS({ ...s, analytics: { ...s.analytics, co2eFactorSource: e.target.value } })} hint="Shown wherever emissions appear." />
        </div>
      </section>

      <div>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save policies
        </Button>
      </div>
    </form>
  );
}

function MealTypeDialog({ t, onClose }: { t: MealType | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: t?.code ?? "",
    name: t?.name ?? "",
    defaultServiceStart: t?.defaultServiceStart ?? "12:30",
    defaultServiceEnd: t?.defaultServiceEnd ?? "14:30",
    defaultCutoffMinutes: String(t?.defaultCutoffMinutes ?? 180),
    defaultOpenHours: String(t?.defaultOpenHours ?? 36),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, defaultServiceStart: f.defaultServiceStart, defaultServiceEnd: f.defaultServiceEnd, defaultCutoffMinutes: Number(f.defaultCutoffMinutes), defaultOpenHours: Number(f.defaultOpenHours) };
      return t ? api.patch(`/admin/meal-types/${t.id}`, body) : api.post("/admin/meal-types", { ...body, code: f.code });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org", "meal-types"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t ? `Edit ${t.name}` : "New meal type"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          {!t && <TextField label="Code" value={f.code} onChange={set("code")} className="mono" hint="e.g. SNACKS" />}
          <TextField label="Name" value={f.name} onChange={set("name")} />
          <TextField label="Service starts" type="time" value={f.defaultServiceStart} onChange={set("defaultServiceStart")} />
          <TextField label="Service ends" type="time" value={f.defaultServiceEnd} onChange={set("defaultServiceEnd")} />
          <TextField label="Voting closes (minutes before)" type="number" min={0} value={f.defaultCutoffMinutes} onChange={set("defaultCutoffMinutes")} hint="e.g. 600 = evening before breakfast" />
          <TextField label="Voting opens (hours before)" type="number" min={1} value={f.defaultOpenHours} onChange={set("defaultOpenHours")} />
        </div>
      </div>
    </Dialog>
  );
}

function BaselineDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const messes = useMesses();
  const [f, setF] = useState({ messId: "", label: "Pre-deployment weighing", periodStart: "", periodEnd: "", discardedGPerServing: "", basis: "MEASURED", sourceNote: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api.post("/admin/baselines", { ...f, messId: Number(f.messId), discardedGPerServing: Number(f.discardedGPerServing) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "baselines"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record a waste baseline"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!f.messId || !f.periodStart || !f.periodEnd || f.discardedGPerServing === "" || f.sourceNote.length < 5} onClick={() => m.mutate()}>
            Save baseline
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="text-sm muted">A baseline is the reference rate of discarded food that reductions are measured against. Prefer a measured period before Vote2Dine was in use, and say how it was measured.</p>
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <SelectField label="Mess" value={f.messId} onChange={set("messId")}>
            <option value="">Choose…</option>
            {messes.data?.map((ms) => (
              <option key={ms.id} value={ms.id}>
                {ms.name}
              </option>
            ))}
          </SelectField>
          <TextField label="Label" value={f.label} onChange={set("label")} />
          <TextField label="Period from" type="date" value={f.periodStart} onChange={set("periodStart")} />
          <TextField label="Period to" type="date" value={f.periodEnd} onChange={set("periodEnd")} />
          <TextField label="Discarded food (g per serving)" type="number" min={0} step="any" value={f.discardedGPerServing} onChange={set("discardedGPerServing")} />
          <SelectField label="Basis" value={f.basis} onChange={set("basis")}>
            <option value="MEASURED">Measured (weighed)</option>
            <option value="ESTIMATED">Estimated</option>
          </SelectField>
        </div>
        <TextAreaField label="How was it determined?" rows={2} value={f.sourceNote} onChange={set("sourceNote")} placeholder="e.g. Bins weighed after every meal for 14 days by the mess committee" />
      </div>
    </Dialog>
  );
}

export default function SettingsPage() {
  const inst = useQuery({ queryKey: ["admin", "institution"], queryFn: () => api.get<Inst>("/admin/institution") });
  const types = useMealTypes();
  const baselines = useQuery({ queryKey: ["admin", "baselines"], queryFn: () => api.get<any[]>("/admin/baselines") });
  const [editingType, setEditingType] = useState<MealType | null | "new">(null);
  const [addingBaseline, setAddingBaseline] = useState(false);
  return (
    <div className="page">
      <PageHeader title="Policies & meals" subtitle="Rules every mess in the institution follows. All changes are audited." />
      <div className="stack" style={{ ["--gap" as string]: "32px" }}>
        <QueryState query={inst}>{(i) => <PolicyForm inst={i} />}</QueryState>

        <section className="section">
          <div className="section-title">
            <h2>Meal types</h2>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setEditingType("new")}>
              New meal type
            </Button>
          </div>
          <QueryState query={types}>
            {(list) => (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Meal</th>
                      <th>Service</th>
                      <th>Voting</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.name} <span className="mono text-xs muted">{t.code}</span>
                        </td>
                        <td className="mono">
                          {t.defaultServiceStart}–{t.defaultServiceEnd}
                        </td>
                        <td className="text-sm">
                          opens {t.defaultOpenHours} h before · closes {t.defaultCutoffMinutes >= 60 ? `${Math.round((t.defaultCutoffMinutes / 60) * 10) / 10} h` : `${t.defaultCutoffMinutes} min`} before
                        </td>
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => setEditingType(t)}>
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryState>
        </section>

        <section className="section">
          <div className="section-title">
            <h2>Waste baselines</h2>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddingBaseline(true)}>
              Record baseline
            </Button>
          </div>
          <QueryState query={baselines}>
            {(list) =>
              list.length === 0 ? (
                <p className="text-sm muted">No baselines yet. Without one, analytics report waste but claim no reduction.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Mess</th>
                        <th>Baseline</th>
                        <th className="n">g/serving</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((b) => (
                        <tr key={b.id}>
                          <td>{b.messName}</td>
                          <td className="text-sm">
                            {b.label}
                            <div className="muted text-xs">
                              {fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)} · {b.basis.toLowerCase()}
                            </div>
                          </td>
                          <td className="n">{b.discardedGPerServing}</td>
                          <td className="text-sm">
                            {b.sourceNote}
                            <div className="muted text-xs">by {b.createdByName}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </QueryState>
        </section>
      </div>
      {editingType && <MealTypeDialog t={editingType === "new" ? null : editingType} onClose={() => setEditingType(null)} />}
      {addingBaseline && <BaselineDialog onClose={() => setAddingBaseline(false)} />}
    </div>
  );
}
