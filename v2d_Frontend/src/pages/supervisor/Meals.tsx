import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, localToday } from "../../lib/format";
import type { SlotListItem } from "../../lib/types";
import { Button, Dialog, ErrorNotice, PageHeader, QueryState, SelectField, StatusBadge, TextField, fieldError, useToast } from "../../components/ui";
import { WithMess } from "./common";
import { MenuPicker, type MenuLine } from "./MenuPicker";

export interface MealType {
  id: number;
  code: string;
  name: string;
  defaultServiceStart: string;
  defaultServiceEnd: string;
  defaultCutoffMinutes: number;
  defaultOpenHours: number;
  isActive: boolean;
}
export function useMealTypes() {
  return useQuery({ queryKey: ["org", "meal-types"], queryFn: () => api.get<MealType[]>("/org/meal-types"), staleTime: 300_000 });
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

function NewMealDialog({ messId, onClose, defaultDate }: { messId: number; onClose: () => void; defaultDate: string }) {
  const types = useMealTypes();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [mealTypeId, setMealTypeId] = useState("");
  const [serviceDate, setServiceDate] = useState(defaultDate);
  const [serviceStart, setServiceStart] = useState("");
  const [serviceEnd, setServiceEnd] = useState("");
  const [closes, setCloses] = useState("");
  const [notes, setNotes] = useState("");
  const [special, setSpecial] = useState(false);
  const [menu, setMenu] = useState<MenuLine[]>([]);
  const type = types.data?.find((t) => String(t.id) === mealTypeId);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>(`/messes/${messId}/slots`, {
        mealTypeId: Number(mealTypeId),
        serviceDate,
        serviceStart: serviceStart || undefined,
        serviceEnd: serviceEnd || undefined,
        votingClosesAt: closes || undefined,
        notes: notes || undefined,
        isSpecialEvent: special,
        menu,
      }),
    onSuccess: (slot) => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast("Meal created as a draft. Publish it so students can vote.");
      navigate(`/supervisor/meals/${slot.id}`);
    },
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New meal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!mealTypeId || !serviceDate} onClick={() => m.mutate()}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <SelectField label="Meal" value={mealTypeId} onChange={(e) => setMealTypeId(e.target.value)} error={fieldError(m.error, "mealTypeId")}>
            <option value="">Choose…</option>
            {types.data?.filter((t) => t.isActive).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
          <TextField label="Date" type="date" value={serviceDate} min={localToday()} onChange={(e) => setServiceDate(e.target.value)} error={fieldError(m.error, "serviceDate")} />
          <TextField label="Service starts" type="time" value={serviceStart} placeholder={type?.defaultServiceStart} onChange={(e) => setServiceStart(e.target.value)} hint={type ? `Default ${type.defaultServiceStart}` : undefined} optional />
          <TextField label="Service ends" type="time" value={serviceEnd} onChange={(e) => setServiceEnd(e.target.value)} hint={type ? `Default ${type.defaultServiceEnd}` : undefined} optional error={fieldError(m.error, "serviceEnd")} />
          <TextField
            label="Voting closes"
            type="datetime-local"
            value={closes}
            onChange={(e) => setCloses(e.target.value)}
            hint={type ? `Default: ${type.defaultCutoffMinutes / 60} h before service. Opens ${type.defaultOpenHours} h before.` : "Defaults come from the meal type"}
            optional
            error={fieldError(m.error, "votingClosesAt")}
          />
          <TextField label="Note to students" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} optional placeholder="e.g. Festival dinner" />
        </div>
        <label className="check">
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>
            Special event <span className="muted text-sm">— the forecast will warn that past meals may not reflect demand</span>
          </span>
        </label>
        <div className="field">
          <span className="field-label">Menu</span>
          <MenuPicker value={menu} onChange={setMenu} />
        </div>
      </div>
    </Dialog>
  );
}

function ScheduleDialog({ messId, onClose, from }: { messId: number; onClose: () => void; from: string }) {
  const types = useMealTypes();
  const qc = useQueryClient();
  const [fromDate, setFrom] = useState(from);
  const [toDate, setTo] = useState(addDays(from, 6));
  const [selected, setSelected] = useState<number[]>([]);
  const [copy, setCopy] = useState(true);
  const m = useMutation({
    mutationFn: () => api.post<{ created: unknown[]; skipped: { serviceDate: string; mealType: string; reason: string }[] }>(`/messes/${messId}/schedule`, { fromDate, toDate, mealTypeIds: selected, copyMenuFromDaysBefore: copy ? 7 : undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Schedule meals for a period"
      footer={
        m.data ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={m.isPending} disabled={!selected.length} onClick={() => m.mutate()}>
              Create drafts
            </Button>
          </>
        )
      }
    >
      {m.data ? (
        <div className="stack">
          <p>
            Created <strong>{m.data.created.length}</strong> draft meal{m.data.created.length === 1 ? "" : "s"}. Review each menu, then publish.
          </p>
          {m.data.skipped.length > 0 && (
            <details>
              <summary className="text-sm">{m.data.skipped.length} skipped</summary>
              <ul className="text-sm">
                {m.data.skipped.map((s, i) => (
                  <li key={i}>
                    {fmtDate(s.serviceDate)} {s.mealType}: {s.reason === "ALREADY_SCHEDULED" ? "already scheduled" : "cutoff already passed"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <div className="stack">
          <ErrorNotice error={m.error} />
          <div className="grid-2">
            <TextField label="From" type="date" value={fromDate} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="To" type="date" value={toDate} onChange={(e) => setTo(e.target.value)} hint="Up to 31 days" />
          </div>
          <fieldset className="stack" style={{ ["--gap" as string]: "6px" }}>
            <legend className="field-label">Meals</legend>
            {types.data?.filter((t) => t.isActive).map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} />
                <span>
                  {t.name} <span className="muted text-sm mono">{t.defaultServiceStart}–{t.defaultServiceEnd}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            <span>Copy each menu from the same meal one week earlier</span>
          </label>
          <p className="text-sm muted">Meals are created as drafts with the meal type's default times. Existing meals are never overwritten.</p>
        </div>
      )}
    </Dialog>
  );
}

export default function Meals() {
  return <WithMess>{(messId, messName) => <MealsBody messId={messId} messName={messName} />}</WithMess>;
}

function MealsBody({ messId, messName }: { messId: number; messName: string }) {
  const [week, setWeek] = useState(() => mondayOf(localToday()));
  const [dialog, setDialog] = useState<null | "new" | "range">(null);
  const types = useMealTypes();
  const to = addDays(week, 6);
  const q = useQuery({ queryKey: ["slots", messId, week], queryFn: () => api.get<SlotListItem[]>(`/messes/${messId}/slots?from=${week}&to=${to}`) });
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  const today = localToday();

  return (
    <div className="page">
      <PageHeader
        title="Meals & menus"
        subtitle={messName}
        actions={
          <>
            <Button icon={<CalendarRange size={16} />} onClick={() => setDialog("range")}>
              Schedule a period
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setDialog("new")}>
              New meal
            </Button>
          </>
        }
      />
      <div className="row-between" style={{ marginBottom: 16 }}>
        <div className="row">
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={16} />} onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week" />
          <strong>
            {fmtDate(week)} – {fmtDate(to)}
          </strong>
          <Button size="sm" variant="ghost" icon={<ChevronRight size={16} />} onClick={() => setWeek(addDays(week, 7))} aria-label="Next week" />
          {week !== mondayOf(today) && (
            <Button size="sm" onClick={() => setWeek(mondayOf(today))}>
              This week
            </Button>
          )}
        </div>
        <span className="text-sm muted">Click a meal to edit its menu, publish it, or follow it through service.</span>
      </div>
      <QueryState query={q} lines={7}>
        {(slots) => (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Meals for the week</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 130 }}>
                    Date
                  </th>
                  {activeTypes.map((t) => (
                    <th key={t.id} scope="col">
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d} style={d === today ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}>
                    <th scope="row" style={{ fontWeight: d === today ? 600 : 500, textTransform: "none", letterSpacing: 0, fontSize: "var(--text-md)", color: "var(--ink)", background: "transparent" }}>
                      {fmtDate(d)}
                    </th>
                    {activeTypes.map((t) => {
                      const s = slots.find((x) => x.serviceDate === d && x.mealType.id === t.id && x.status !== "CANCELLED") ?? slots.find((x) => x.serviceDate === d && x.mealType.id === t.id);
                      return (
                        <td key={t.id} style={{ verticalAlign: "top" }}>
                          {s ? (
                            <Link to={`/supervisor/meals/${s.id}`} style={{ display: "block", textDecoration: "none", color: "inherit" }} aria-label={`${t.name} on ${fmtDate(d)}`}>
                              <StatusBadge status={s.status} />
                              <div className="text-xs muted" style={{ marginTop: 6 }}>
                                {s.menu.length ? s.menu.map((m) => m.name).join(", ") : "No menu"}
                              </div>
                              {s.status !== "DRAFT" && s.status !== "CANCELLED" && (
                                <div className="text-xs num" style={{ marginTop: 4 }}>
                                  {s.summary.snapshot ? `${s.summary.snapshot.yes} yes · ${s.summary.snapshot.unvoted} no vote` : `${s.summary.liveYes} yes so far`}
                                  {s.summary.approvedServings !== null && ` · target ${s.summary.approvedServings}`}
                                </div>
                              )}
                            </Link>
                          ) : (
                            <span className="text-xs null">Not scheduled</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
      {dialog === "new" && <NewMealDialog messId={messId} onClose={() => setDialog(null)} defaultDate={addDays(today, 1)} />}
      {dialog === "range" && <ScheduleDialog messId={messId} onClose={() => setDialog(null)} from={week < today ? addDays(today, 1) : week} />}
    </div>
  );
}
