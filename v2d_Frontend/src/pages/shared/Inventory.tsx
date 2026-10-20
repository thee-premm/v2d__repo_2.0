import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, localToday } from "../../lib/format";
import { Button, Dialog, Empty, ErrorNotice, Notice, PageHeader, QueryState, SelectField, TextField, useToast } from "../../components/ui";
import { WithMess } from "../supervisor/common";

interface StockRow {
  ingredientId: number;
  name: string;
  category: string | null;
  unit: string;
  dimension: "MASS" | "VOLUME" | "COUNT";
  onHand: number;
  lastMovement: string | null;
  safetyStock: number | null;
  packSize: number | null;
  belowSafetyStock: boolean;
}
const UNITS: Record<string, string[]> = { MASS: ["kg", "g"], VOLUME: ["l", "ml"], COUNT: ["unit", "dozen"] };
const KIND_LABEL: Record<string, string> = { RECEIPT: "Received", ISSUE: "Issued to kitchen", SPOILAGE: "Spoiled / discarded", ADJUSTMENT: "Stock-count adjustment" };

function MovementDialog({ messId, stock, onClose }: { messId: number; stock: StockRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ingredientId, setIngredientId] = useState("");
  const [kind, setKind] = useState("RECEIPT");
  const [direction, setDirection] = useState("IN");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [note, setNote] = useState("");
  const ing = stock.find((s) => String(s.ingredientId) === ingredientId);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ onHand: number; unit: string; warnings: { message: string }[] }>(`/messes/${messId}/inventory/transactions`, {
        ingredientId: Number(ingredientId),
        kind,
        direction: kind === "ADJUSTMENT" ? direction : undefined,
        quantity: Number(quantity),
        unit: unit || UNITS[ing!.dimension][0],
        unitCost: unitCost ? Number(unitCost) : undefined,
        note: note || undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast(`Recorded. ${ing?.name} now ${fmtNum(r.onHand, 2)} ${r.unit}.`);
      if (r.warnings.length) toast(r.warnings[0].message, "error");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record a stock movement"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!ing || !(Number(quantity) > 0)} onClick={() => m.mutate()}>
            Record
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <SelectField
            label="Ingredient"
            value={ingredientId}
            onChange={(e) => {
              setIngredientId(e.target.value);
              setUnit("");
            }}
          >
            <option value="">Choose…</option>
            {stock.map((s) => (
              <option key={s.ingredientId} value={s.ingredientId}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Movement" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          {kind === "ADJUSTMENT" && (
            <SelectField label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="IN">Add to stock</option>
              <option value="OUT">Remove from stock</option>
            </SelectField>
          )}
          <TextField label="Quantity" type="number" min={0} step="any" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!ing} hint={ing ? `Stored in ${ing.unit}` : undefined}>
            {(ing ? UNITS[ing.dimension] : []).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </SelectField>
          {kind === "RECEIPT" && <TextField label={`Cost per ${ing?.unit ?? "unit"}`} optional type="number" min={0} step="any" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />}
        </div>
        <TextField label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Invoice 2291 from supplier" />
      </div>
    </Dialog>
  );
}

export default function Inventory({ mode }: { mode: "supervisor" | "kitchen" }) {
  return <WithMess>{(messId) => <Body messId={messId} mode={mode} />}</WithMess>;
}

function Body({ messId, mode }: { messId: number; mode: "supervisor" | "kitchen" }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"stock" | "outlook" | "log">("stock");
  const stock = useQuery({ queryKey: ["inventory", messId], queryFn: () => api.get<StockRow[]>(`/messes/${messId}/inventory`) });
  const outlook = useQuery({
    queryKey: ["inventory", messId, "outlook"],
    queryFn: () => api.get<any>(`/messes/${messId}/procurement?from=${localToday()}&to=${localToday(3)}`),
    enabled: tab === "outlook",
  });
  const log = useQuery({ queryKey: ["inventory", messId, "log"], queryFn: () => api.get<any[]>(`/messes/${messId}/inventory/transactions?limit=100`), enabled: tab === "log" });
  const low = (stock.data ?? []).filter((s) => s.belowSafetyStock);
  return (
    <div className="page">
      <PageHeader
        title={mode === "kitchen" ? "Stock" : "Stock & procurement"}
        subtitle="Recorded stock is the sum of receipts, issues, spoilage and adjustments."
        actions={
          <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setOpen(true)} disabled={!stock.data}>
            Record movement
          </Button>
        }
      />
      {low.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="warn" title={`${low.length} ingredient${low.length === 1 ? " is" : "s are"} below safety stock`}>
            {low.map((l) => l.name).join(", ")}
          </Notice>
        </div>
      )}
      <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button role="tab" aria-selected={tab === "stock"} onClick={() => setTab("stock")}>
          On hand
        </button>
        <button role="tab" aria-selected={tab === "outlook"} onClick={() => setTab("outlook")}>
          Next 3 days
        </button>
        <button role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
          Movements
        </button>
      </div>
      {tab === "stock" && (
        <QueryState query={stock}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="No ingredients yet">Add ingredients in Dishes &amp; recipes first.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ingredient</th>
                      <th className="n">On hand</th>
                      <th className="n">Safety stock</th>
                      <th>Last movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.ingredientId}>
                        <td>
                          {s.name}
                          {s.category && <div className="text-xs muted">{s.category}</div>}
                        </td>
                        <td className="n" style={{ color: s.onHand < 0 ? "var(--danger-text)" : undefined }}>
                          {fmtNum(s.onHand, 2)} {s.unit} {s.belowSafetyStock && <span className="badge badge-warn">Low</span>}
                        </td>
                        <td className="n">{s.safetyStock === null ? <span className="null">—</span> : `${fmtNum(s.safetyStock, 1)} ${s.unit}`}</td>
                        <td className="text-sm muted">{s.lastMovement ? fmtDateTime(s.lastMovement) : "Never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>
      )}
      {tab === "outlook" && (
        <QueryState query={outlook}>
          {(o) => (
            <div className="stack">
              <p className="text-sm muted">
                Requirements of {o.meals.length} upcoming meal{o.meals.length === 1 ? "" : "s"} ({fmtDate(o.from)} – {fmtDate(o.to)}), using approved targets where they exist and forecast recommendations otherwise. Current stock is subtracted once; safety stock and pack sizes are applied.
              </p>
              {o.excluded.length > 0 && <Notice tone="info">{o.excluded.length} meal(s) have no target yet and are not included.</Notice>}
              {o.ingredients.length === 0 ? (
                <Empty title="Nothing to procure yet">Meals appear here once voting has closed and a forecast exists.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Ingredient</th>
                        <th className="n">Needed</th>
                        <th className="n">On hand</th>
                        <th className="n">Order</th>
                        <th className="n">Est. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.ingredients.map((i: any) => (
                        <tr key={i.ingredientId}>
                          <td>{i.name}</td>
                          <td className="n">
                            {fmtNum(i.required, 2)} {i.unit}
                          </td>
                          <td className="n">
                            {fmtNum(i.onHand, 2)} {i.unit}
                          </td>
                          <td className="n strong">{i.recommendedProcurement ? `${fmtNum(i.recommendedProcurement, 1)} ${i.unit}` : <span className="null">—</span>}</td>
                          <td className="n">{fmtMoney(i.estimatedCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </QueryState>
      )}
      {tab === "log" && (
        <QueryState query={log}>
          {(rows) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Ingredient</th>
                    <th>Movement</th>
                    <th className="n">Quantity</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td className="text-sm">{fmtDateTime(t.recordedAt)}</td>
                      <td>{t.ingredient}</td>
                      <td className="text-sm">
                        {KIND_LABEL[t.kind]}
                        {t.note && <div className="text-xs muted">{t.note}</div>}
                      </td>
                      <td className="n">
                        {t.quantity > 0 ? "+" : "−"}
                        {fmtNum(Math.abs(t.quantity), 3)} {t.unit}
                      </td>
                      <td className="text-sm">{t.recordedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      )}
      {open && stock.data && <MovementDialog messId={messId} stock={stock.data} onClose={() => setOpen(false)} />}
    </div>
  );
}
