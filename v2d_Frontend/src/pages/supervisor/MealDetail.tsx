import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Calculator, CheckCircle2, ClipboardCheck, Lock, Pencil, Play, RefreshCw, ScanLine, Send, Square } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtKg, fmtMoney, fmtNum, fmtTime, localDateTimeValue } from "../../lib/format";
import type { SlotDetail, SlotStatus } from "../../lib/types";
import { Button, Composition, ConfirmDialog, Dialog, ErrorNotice, Kind, Notice, PageHeader, QueryState, StatusBadge, TextAreaField, TextField, fieldError, useToast } from "../../components/ui";
import { MenuPicker, type MenuLine } from "./MenuPicker";

const STEPS: { status: SlotStatus; label: string }[] = [
  { status: "DRAFT", label: "Draft" },
  { status: "OPEN", label: "Voting" },
  { status: "LOCKED", label: "Locked" },
  { status: "FORECAST_READY", label: "Forecast" },
  { status: "APPROVED", label: "Approved" },
  { status: "IN_SERVICE", label: "Serving" },
  { status: "SERVICE_CLOSED", label: "Closed" },
  { status: "RECONCILED", label: "Reconciled" },
];

function Lifecycle({ status }: { status: SlotStatus }) {
  if (status === "CANCELLED") return <Notice tone="danger" title="This meal was cancelled" />;
  const idx = STEPS.findIndex((s) => s.status === status);
  return (
    <ol className="lifecycle" aria-label="Meal lifecycle">
      {STEPS.map((s, i) => (
        <li key={s.status} data-done={i < idx} data-current={i === idx} aria-current={i === idx ? "step" : undefined}>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

interface Requirements {
  basis: string;
  servings: number | null;
  ingredients: { ingredientId: number; name: string; unit: string; required: number; onHand?: number; onHandAtApproval?: number; recommendedProcurement: number | null; estimatedCost: number | null; usedIn: string[] }[];
  missingRecipes: { dishId: number; name: string }[];
  estimatedIngredientCost: number | null;
}

function RequirementsPanel({ slotId, servings, frozen }: { slotId: number; servings: number | null; frozen: boolean }) {
  const q = useQuery({
    queryKey: ["requirements", slotId, frozen ? "plan" : servings],
    queryFn: () => api.get<Requirements>(`/slots/${slotId}/requirements${!frozen && servings !== null ? `?servings=${servings}` : ""}`),
    enabled: frozen || servings !== null,
  });
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>
          <Calculator size={15} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" />
          Ingredients {servings !== null && <span className="muted text-sm">for {fmtNum(servings)} servings</span>}
        </h3>
        {q.data && <span className="text-xs muted">{q.data.basis === "APPROVED_PLAN" ? "Frozen at approval" : "Preview — not yet approved"}</span>}
      </div>
      <div className="panel-body stack" style={{ ["--gap" as string]: "12px" }}>
        <QueryState query={q}>
          {(r) => (
            <>
              {r.missingRecipes.length > 0 && (
                <Notice tone="warn" title={`${r.missingRecipes.length} dish${r.missingRecipes.length === 1 ? " has" : "es have"} no recipe`}>
                  {r.missingRecipes.map((m) => m.name).join(", ")} — quantities for {r.missingRecipes.length === 1 ? "it are" : "them are"} not calculated. Add a recipe in Dishes &amp; recipes.
                </Notice>
              )}
              {r.ingredients.length === 0 ? (
                <p className="text-sm muted">No recipe quantities to show.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ingredient</th>
                        <th className="n">Needed</th>
                        <th className="n">In stock</th>
                        <th className="n">To procure</th>
                        <th className="n">Est. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.ingredients.map((i) => (
                        <tr key={i.ingredientId}>
                          <td>
                            {i.name}
                            <div className="text-xs muted">{i.usedIn.join(", ")}</div>
                          </td>
                          <td className="n">
                            {fmtNum(i.required, 2)} {i.unit}
                          </td>
                          <td className="n">{(i.onHand ?? i.onHandAtApproval) === null || (i.onHand ?? i.onHandAtApproval) === undefined ? <span className="null">—</span> : `${fmtNum(i.onHand ?? i.onHandAtApproval!, 1)} ${i.unit}`}</td>
                          <td className="n">{i.recommendedProcurement ? `${fmtNum(i.recommendedProcurement, 1)} ${i.unit}` : <span className="null">—</span>}</td>
                          <td className="n">{fmtMoney(i.estimatedCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="row-between text-sm">
                <span className="muted">
                  Raw quantity = servings × share taking the dish × recipe quantity ÷ yield. <Kind kind="estimate" />
                </span>
                {r.estimatedIngredientCost !== null && <strong>Total {fmtMoney(r.estimatedIngredientCost)}</strong>}
              </div>
            </>
          )}
        </QueryState>
      </div>
    </section>
  );
}

function ForecastPanel({ slot, onRegenerate, regenerating }: { slot: SlotDetail; onRegenerate?: () => void; regenerating: boolean }) {
  const f = slot.forecast!;
  const groups = [
    { key: "yes", label: "Voted yes", n: f.counts.yes, rate: f.rates.yes, tone: "var(--yes)" },
    { key: "no", label: "Voted no", n: f.counts.no, rate: f.rates.no, tone: "var(--no)" },
    { key: "unvoted", label: "Did not vote", n: f.counts.unvoted, rate: f.rates.unvoted, tone: "var(--unvoted)" },
  ];
  const methodLabel: Record<string, string> = {
    VOTE_RATES_WITH_HISTORY: "Vote-group rates learned from this mess's history",
    VOTE_RATES_PRIOR_ONLY: "Starting assumptions (not enough history yet)",
    CONSERVATIVE_FALLBACK: "Conservative fallback (model unavailable)",
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>
          Forecast <Kind kind="estimate" />
        </h3>
        <div className="row">
          <span className="text-xs muted">
            v{f.version} · {fmtDateTime(f.generatedAt)}
          </span>
          {onRegenerate && (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} busy={regenerating} onClick={onRegenerate}>
              Re-run
            </Button>
          )}
        </div>
      </div>
      <div className="panel-body stack" style={{ ["--gap" as string]: "16px" }}>
        <div className="row" style={{ ["--gap" as string]: "32px", alignItems: "flex-end" }}>
          <div>
            <div className="text-sm muted">Expected attendance</div>
            <div className="big-number num">{fmtNum(f.predictedAttendance, 1)}</div>
            {f.interval && (
              <div className="text-sm muted num">
                {Math.round(f.interval.level * 100)}% range {fmtNum(f.interval.low, 0)}–{fmtNum(f.interval.high, 0)}
              </div>
            )}
          </div>
          <div>
            <div className="text-sm muted">Recommended servings</div>
            <div className="big-number num" style={{ color: "var(--brand-text)" }}>
              {fmtNum(f.recommendedServings)}
            </div>
            <div className="text-sm muted num">
              +{f.safetyBufferServings} buffer · covers {Math.round(f.serviceLevel * 100)}% of likely outcomes
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">How the forecast is calculated</caption>
            <thead>
              <tr>
                <th>Group at cutoff</th>
                <th className="n">Students</th>
                <th className="n">Attendance rate</th>
                <th className="n">Expected</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>
                    <span className="row" style={{ ["--gap" as string]: "8px" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: g.tone }} aria-hidden="true" />
                      {g.label}
                    </span>
                  </td>
                  <td className="n">{g.n}</td>
                  <td className="n">{fmtNum(g.rate * 100, 1)}%</td>
                  <td className="n">{fmtNum(g.n * g.rate, 1)}</td>
                </tr>
              ))}
              <tr>
                <td className="strong">Total</td>
                <td className="n strong">{f.counts.eligible}</td>
                <td />
                <td className="n strong">{fmtNum(f.predictedAttendance, 1)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <dl className="dl text-sm">
          <dt>Method</dt>
          <dd>{methodLabel[f.method] ?? f.method}</dd>
          <dt>History used</dt>
          <dd>
            {f.historySlotCount} reconciled meal{f.historySlotCount === 1 ? "" : "s"}
            {f.inputs?.history?.from && (
              <span className="muted">
                {" "}
                ({fmtDate(f.inputs.history.from)} – {fmtDate(f.inputs.history.to)})
              </span>
            )}
          </dd>
          <dt>Model</dt>
          <dd className="mono text-xs">{f.modelVersion}</dd>
        </dl>
        {f.warnings.map((w) => (
          <Notice key={w.code} tone={w.code === "MODEL_FAILURE" ? "danger" : "warn"}>
            {w.message}
          </Notice>
        ))}
      </div>
    </section>
  );
}

function ApprovePanel({ slot }: { slot: SlotDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const recommended = slot.forecast?.recommendedServings ?? null;
  const [servings, setServings] = useState<string>(String(slot.plan?.approvedServings ?? recommended ?? ""));
  const [reason, setReason] = useState("");
  useEffect(() => setServings(String(slot.plan?.approvedServings ?? recommended ?? "")), [slot.plan?.approvedServings, recommended]);
  const n = Number(servings);
  const isOverride = recommended === null || n !== recommended;
  const isRevision = Boolean(slot.plan);
  const needsReason = isOverride || isRevision;
  const m = useMutation({
    mutationFn: () => api.post<SlotDetail>(`/slots/${slot.id}/approve`, { servings: n, reason: reason.trim() || undefined }),
    onSuccess: (d) => {
      qc.setQueryData(["slot", slot.id], d);
      qc.invalidateQueries({ queryKey: ["requirements", slot.id] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setReason("");
      toast(`Target of ${n} servings approved. The kitchen has been notified.`);
    },
  });
  return (
    <section className="panel" style={{ borderColor: isRevision ? undefined : "var(--accent)" }}>
      <div className="panel-head">
        <h3>{isRevision ? "Revise the approved target" : "Approve the preparation target"}</h3>
      </div>
      <form
        className="panel-body stack"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <ErrorNotice error={m.error && !fieldError(m.error, "reason") ? m.error : null} />
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ width: 180 }}>
            <TextField label="Servings to prepare" type="number" min={0} inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value)} />
          </div>
          {recommended !== null && n !== recommended && (
            <Button size="sm" variant="ghost" onClick={() => setServings(String(recommended))}>
              Use recommendation ({recommended})
            </Button>
          )}
        </div>
        {needsReason && (
          <TextAreaField
            label={isOverride ? `Why ${recommended === null ? "this number" : n > recommended ? "more" : "fewer"} than recommended?` : "Why change the approved target?"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            hint="Recorded with the plan and visible in the audit trail."
            error={fieldError(m.error, "reason")}
          />
        )}
        <div>
          <Button type="submit" variant="primary" icon={<CheckCircle2 size={16} />} busy={m.isPending} disabled={!servings || Number.isNaN(n) || n < 0 || (needsReason && reason.trim().length < 5)}>
            {isRevision ? "Save revised target" : isOverride ? "Approve override" : "Approve recommendation"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function EditTimesDialog({ slot, onClose }: { slot: SlotDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    serviceStart: fmtTime(slot.serviceStartsAt),
    serviceEnd: fmtTime(slot.serviceEndsAt),
    votingOpensAt: localDateTimeValue(slot.votingOpensAt),
    votingClosesAt: localDateTimeValue(slot.votingClosesAt),
    notes: slot.notes ?? "",
  });
  const m = useMutation({
    mutationFn: () => api.patch<SlotDetail>(`/slots/${slot.id}`, { ...form, notes: form.notes || null }),
    onSuccess: (d) => {
      qc.setQueryData(["slot", slot.id], d);
      onClose();
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit schedule"
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
        {slot.status === "OPEN" && <Notice tone="info">Voting is open. Students are notified if the cutoff or service times change.</Notice>}
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <TextField label="Service starts" type="time" value={form.serviceStart} onChange={set("serviceStart")} error={fieldError(m.error, "serviceStart")} />
          <TextField label="Service ends" type="time" value={form.serviceEnd} onChange={set("serviceEnd")} error={fieldError(m.error, "serviceEnd")} />
          <TextField label="Voting opens" type="datetime-local" value={form.votingOpensAt} onChange={set("votingOpensAt")} error={fieldError(m.error, "votingOpensAt")} />
          <TextField label="Voting closes" type="datetime-local" value={form.votingClosesAt} onChange={set("votingClosesAt")} error={fieldError(m.error, "votingClosesAt")} />
        </div>
        <TextField label="Note to students" value={form.notes} onChange={set("notes")} optional maxLength={500} />
      </div>
    </Dialog>
  );
}

function EditMenuDialog({ slot, onClose }: { slot: SlotDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState<MenuLine[]>(slot.menu.map((m) => ({ dishId: m.dishId, uptakeFraction: m.uptakeFraction })));
  const m = useMutation({
    mutationFn: () => api.put<SlotDetail>(`/slots/${slot.id}/menu`, { menu }),
    onSuccess: (d) => {
      qc.setQueryData(["slot", slot.id], d);
      qc.invalidateQueries({ queryKey: ["requirements", slot.id] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Edit menu"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>
            Save menu
          </Button>
        </>
      }
    >
      <div className="stack">
        {slot.status === "OPEN" && <Notice tone="info">Voting is open — students will be told the menu changed and can still change their vote.</Notice>}
        <ErrorNotice error={m.error} />
        <MenuPicker value={menu} onChange={setMenu} />
      </div>
    </Dialog>
  );
}

export default function MealDetail() {
  const { slotId } = useParams();
  const id = Number(slotId);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["slot", id], queryFn: () => api.get<SlotDetail>(`/slots/${id}`), refetchInterval: 30_000 });
  const [dialog, setDialog] = useState<null | "times" | "menu" | "cancel" | "close">(null);

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; done: string }) => api.post<SlotDetail>(`/slots/${id}/${path}`, body ?? {}),
    onSuccess: (d, v) => {
      qc.setQueryData(["slot", id], d);
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["slots"] });
      toast(v.done);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const run = (path: string, done: string, body?: unknown) => action.mutateAsync({ path, done, body });
  const busy = (path: string) => action.isPending && action.variables?.path === path;

  return (
    <div className="page">
      <QueryState query={q} lines={8}>
        {(slot) => {
          const can = (a: string) => slot.actions.includes(a);
          const servingsForPreview = slot.plan?.approvedServings ?? slot.forecast?.recommendedServings ?? null;
          return (
            <>
              <PageHeader
                back={{ to: "/supervisor/meals", label: "Meals & menus" }}
                title={`${slot.mealType.name} · ${fmtDate(slot.serviceDate, "long")}`}
                subtitle={
                  <span className="row" style={{ ["--gap" as string]: "10px" }}>
                    <StatusBadge status={slot.status} />
                    <span className="mono">
                      {fmtTime(slot.serviceStartsAt)}–{fmtTime(slot.serviceEndsAt)}
                    </span>
                    <span>{slot.messName}</span>
                  </span>
                }
                actions={
                  <>
                    {can("PUBLISH") && (
                      <Button variant="primary" icon={<Send size={15} />} busy={busy("publish")} onClick={() => run("publish", "Published. Students can vote once voting opens.")}>
                        Publish
                      </Button>
                    )}
                    {can("LOCK") && (
                      <Button variant="primary" icon={<Lock size={15} />} busy={busy("lock")} onClick={() => run("lock", "Voting closed and the forecast is ready.")}>
                        Close voting now
                      </Button>
                    )}
                    {can("START_SERVICE") && (
                      <Button variant="primary" icon={<Play size={15} />} busy={busy("start-service")} onClick={() => run("start-service", "Service started — the counter is open.")}>
                        Start service
                      </Button>
                    )}
                    {can("VERIFY_ATTENDANCE") && (
                      <Link className="btn btn-primary" to={`/supervisor/counter?meal=${slot.id}`}>
                        <ScanLine size={15} aria-hidden="true" /> Open counter
                      </Link>
                    )}
                    {can("CLOSE_SERVICE") && (
                      <Button icon={<Square size={14} />} onClick={() => setDialog("close")}>
                        Close service
                      </Button>
                    )}
                    {can("RECONCILE") && (
                      <Link className="btn btn-primary" to={`/supervisor/meals/${slot.id}/reconcile`}>
                        <ClipboardCheck size={15} aria-hidden="true" /> Reconcile
                      </Link>
                    )}
                    {slot.status === "RECONCILED" && (
                      <Link className="btn" to={`/supervisor/meals/${slot.id}/reconcile`}>
                        View reconciliation
                      </Link>
                    )}
                  </>
                }
              />
              <div className="stack" style={{ ["--gap" as string]: "24px" }}>
                <Lifecycle status={slot.status} />
                {slot.status === "DRAFT" && new Date(slot.votingClosesAt).getTime() < new Date(slot.serverTime).getTime() && (
                  <Notice tone="danger" title="The voting cutoff for this draft has passed">
                    Edit the times to reopen it, or cancel it.
                  </Notice>
                )}
                <div className="split">
                  <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Declarations</h3>
                        <span className="text-xs muted">
                          {slot.votes?.source === "CUTOFF_SNAPSHOT" ? `Snapshot locked ${fmtDateTime(slot.votes.lockedAt ?? null)}` : slot.status === "DRAFT" ? "Not published" : "Live — changes until cutoff"}
                        </span>
                      </div>
                      <div className="panel-body stack">
                        {slot.votes ? (
                          <>
                            <div className="row num" style={{ ["--gap" as string]: "28px" }}>
                              <div>
                                <div className="text-sm muted">Eligible</div>
                                <div className="stat-value">{slot.votes.eligible}</div>
                              </div>
                              <div>
                                <div className="text-sm muted">Participation</div>
                                <div className="stat-value">{slot.votes.eligible ? Math.round(((slot.votes.yes + slot.votes.no) / slot.votes.eligible) * 100) : 0}%</div>
                              </div>
                            </div>
                            <Composition yes={slot.votes.yes} no={slot.votes.no} unvoted={slot.votes.unvoted} />
                            <p className="text-xs muted">Students who did not vote are not treated as "no" — the forecast estimates how many of them will come.</p>
                          </>
                        ) : (
                          <p className="muted text-sm">No declarations yet.</p>
                        )}
                      </div>
                    </section>

                    {slot.forecast && <ForecastPanel slot={slot} regenerating={busy("forecast")} onRegenerate={can("FORECAST") ? () => run("forecast", "Forecast re-run with the latest history.") : undefined} />}
                    {slot.status === "LOCKED" && !slot.forecast && (
                      <Notice tone="warn" title="No forecast yet" action={can("FORECAST") ? <Button size="sm" onClick={() => run("forecast", "Forecast generated.")}>Generate</Button> : undefined}>
                        You can still approve a target manually with a reason.
                      </Notice>
                    )}
                    {can("APPROVE") && <ApprovePanel slot={slot} />}
                    {slot.plan && (
                      <section className="panel">
                        <div className="panel-head">
                          <h3>
                            Approved plan <Kind kind="manual" />
                          </h3>
                          {slot.plan.isOverride && <span className="badge badge-accent">Override</span>}
                        </div>
                        <div className="panel-body">
                          <dl className="dl">
                            <dt>Servings</dt>
                            <dd className="strong num">{slot.plan.approvedServings}</dd>
                            <dt>Recommended</dt>
                            <dd className="num">{slot.plan.recommendedServings ?? "—"}</dd>
                            {slot.plan.overrideReason && (
                              <>
                                <dt>Reason</dt>
                                <dd>{slot.plan.overrideReason}</dd>
                              </>
                            )}
                            <dt>Approved</dt>
                            <dd>
                              {slot.plan.approvedBy} · {fmtDateTime(slot.plan.approvedAt)}
                            </dd>
                          </dl>
                        </div>
                      </section>
                    )}
                    {(slot.plan || slot.forecast) && <RequirementsPanel slotId={slot.id} servings={servingsForPreview} frozen={Boolean(slot.plan)} />}
                  </div>

                  <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Schedule</h3>
                        {can("EDIT") && (
                          <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setDialog("times")}>
                            Edit
                          </Button>
                        )}
                      </div>
                      <div className="panel-body">
                        <dl className="dl">
                          <dt>Voting opens</dt>
                          <dd className="num">{fmtDateTime(slot.votingOpensAt)}</dd>
                          <dt>Voting closes</dt>
                          <dd className="num strong">{fmtDateTime(slot.votingClosesAt)}</dd>
                          <dt>Service</dt>
                          <dd className="num">
                            {fmtTime(slot.serviceStartsAt)}–{fmtTime(slot.serviceEndsAt)}
                          </dd>
                          {slot.notes && (
                            <>
                              <dt>Note</dt>
                              <dd>{slot.notes}</dd>
                            </>
                          )}
                        </dl>
                        <p className="text-xs muted" style={{ marginTop: 10 }}>
                          Times in {slot.timezone}.
                        </p>
                      </div>
                    </section>

                    <section className="panel">
                      <div className="panel-head">
                        <h3>Menu</h3>
                        {can("EDIT_MENU") && (
                          <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setDialog("menu")}>
                            Edit
                          </Button>
                        )}
                      </div>
                      {slot.menu.length ? (
                        <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                          {slot.menu.map((m) => (
                            <li key={m.dishId} className="row-between" style={{ padding: "8px 20px" }}>
                              <span className="text-sm">
                                {m.name} {!m.hasRecipe && <span className="badge badge-warn">No recipe</span>}
                              </span>
                              <span className="text-xs muted num">{Math.round(m.uptakeFraction * 100)}% take it</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="panel-body text-sm muted">No menu yet — publishing requires at least one dish.</div>
                      )}
                    </section>

                    {["APPROVED", "IN_SERVICE", "SERVICE_CLOSED", "RECONCILED"].includes(slot.status) && (
                      <section className="panel">
                        <div className="panel-head">
                          <h3>Service</h3>
                        </div>
                        <div className="panel-body">
                          <dl className="dl">
                            <dt>Verified at counter</dt>
                            <dd className="num">
                              {slot.attendance.verified}
                              {slot.attendance.walk_ins ? <span className="muted"> ({slot.attendance.walk_ins} walk-ins)</span> : null}
                            </dd>
                            <dt>Preparation</dt>
                            <dd className="num">
                              {slot.prep.DONE ?? 0} of {(slot.prep.DONE ?? 0) + (slot.prep.IN_PROGRESS ?? 0) + (slot.prep.PENDING ?? 0)} dishes done
                            </dd>
                            <dt>Leftovers</dt>
                            <dd>{slot.foodLogs.DISCARDED_SURPLUS !== undefined || slot.foodLogs.REUSABLE_SURPLUS !== undefined ? `${fmtKg(slot.foodLogs.REUSABLE_SURPLUS ?? null)} reusable · ${fmtKg(slot.foodLogs.DISCARDED_SURPLUS ?? null)} discarded` : <span className="muted">Not recorded</span>}</dd>
                            <dt>Plate waste</dt>
                            <dd>{slot.foodLogs.PLATE_WASTE !== undefined ? fmtKg(slot.foodLogs.PLATE_WASTE) : <span className="muted">Not recorded</span>}</dd>
                            {slot.reconciliation && (
                              <>
                                <dt>Actual attendance</dt>
                                <dd className="strong num">{slot.reconciliation.actualAttendance}</dd>
                              </>
                            )}
                          </dl>
                        </div>
                      </section>
                    )}

                    {can("CANCEL") && (
                      <Button variant="danger" icon={<Ban size={15} />} onClick={() => setDialog("cancel")}>
                        Cancel this meal
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              {dialog === "times" && <EditTimesDialog slot={slot} onClose={() => setDialog(null)} />}
              {dialog === "menu" && <EditMenuDialog slot={slot} onClose={() => setDialog(null)} />}
              <ConfirmDialog
                open={dialog === "cancel"}
                onClose={() => setDialog(null)}
                title="Cancel this meal?"
                body={<p className="text-sm">{slot.status === "DRAFT" ? "The draft will be cancelled." : "Every eligible student will be notified. This cannot be undone."}</p>}
                confirmLabel="Cancel meal"
                tone="danger"
                requireReason
                reasonLabel="Reason (shown to students)"
                onConfirm={(reason) => run("cancel", "Meal cancelled.", { reason })}
              />
              <ConfirmDialog
                open={dialog === "close"}
                onClose={() => setDialog(null)}
                title="Close service now?"
                body={
                  <p className="text-sm">
                    The counter stops accepting regular verifications ({slot.attendance.verified} recorded so far). Late entries afterwards need a reason. Service closes automatically at {fmtTime(slot.serviceEndsAt)}.
                  </p>
                }
                confirmLabel="Close service"
                onConfirm={() => run("close-service", "Service closed. Reconcile when ready.")}
              />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
