import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { fmtMoney, fmtNum } from "../../lib/format";
import { Button, Dialog, Empty, ErrorNotice, PageHeader, QueryState, SelectField, TextField, useToast } from "../../components/ui";

interface Ingredient {
  id: number;
  name: string;
  dimension: "MASS" | "VOLUME" | "COUNT";
  baseUnit: string;
  costPerBaseUnit: number | null;
  category: string | null;
  isActive: boolean;
}
interface Dish {
  id: number;
  name: string;
  category: string | null;
  isVegetarian: boolean | null;
  portionGrams: number | null;
  isActive: boolean;
  hasRecipe: boolean;
  ingredients: { ingredientId: number; name: string; dimension: string; baseUnit: string; quantityPerServing: number; yieldFactor: number; costPerBaseUnit: number | null }[];
}
const UNITS: Record<string, string[]> = { MASS: ["g", "kg"], VOLUME: ["ml", "l"], COUNT: ["unit", "dozen"] };
const fromBase = (q: number, dim: string) => (dim === "MASS" ? { qty: q * 1000, unit: "g" } : dim === "VOLUME" ? { qty: q * 1000, unit: "ml" } : { qty: q, unit: "unit" });

function RecipeEditor({ dish, ingredients, onClose }: { dish: Dish | null; ingredients: Ingredient[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(dish?.name ?? "");
  const [category, setCategory] = useState(dish?.category ?? "");
  const [veg, setVeg] = useState(dish?.isVegetarian === false ? "no" : dish?.isVegetarian === null ? "" : "yes");
  const [portion, setPortion] = useState(dish?.portionGrams ? String(dish.portionGrams) : "");
  const [lines, setLines] = useState(
    (dish?.ingredients ?? []).map((i) => {
      const b = fromBase(i.quantityPerServing, i.dimension);
      return { ingredientId: String(i.ingredientId), quantity: String(Math.round(b.qty * 1000) / 1000), unit: b.unit, yieldPct: String(Math.round(i.yieldFactor * 100)) };
    }),
  );
  const m = useMutation({
    mutationFn: async () => {
      const body = { name, category: category || undefined, isVegetarian: veg === "" ? undefined : veg === "yes", portionGrams: portion ? Number(portion) : undefined };
      const saved = dish ? await api.patch<Dish>(`/catalog/dishes/${dish.id}`, { ...body, portionGrams: portion ? Number(portion) : null }) : await api.post<Dish>("/catalog/dishes", body);
      return api.put<Dish>(`/catalog/dishes/${saved.id}/ingredients`, {
        ingredients: lines
          .filter((l) => l.ingredientId)
          .map((l) => ({ ingredientId: Number(l.ingredientId), quantity: Number(l.quantity), unit: l.unit, yieldFactor: Number(l.yieldPct) / 100 })),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog"] });
      toast("Dish saved.");
      onClose();
    },
  });
  const byId = new Map(ingredients.map((i) => [String(i.id), i]));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={dish ? `Edit ${dish.name}` : "New dish"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={name.trim().length < 2 || lines.some((l) => l.ingredientId && !(Number(l.quantity) > 0))} onClick={() => m.mutate()}>
            Save dish
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="Category" optional value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. MAIN, RICE, BREAD" />
          <SelectField label="Vegetarian" value={veg} onChange={(e) => setVeg(e.target.value)}>
            <option value="">Not specified</option>
            <option value="yes">Vegetarian</option>
            <option value="no">Non-vegetarian</option>
          </SelectField>
          <TextField label="Cooked portion (g)" optional type="number" min={1} value={portion} onChange={(e) => setPortion(e.target.value)} hint="Used to sanity-check prepared weights." />
        </div>
        <div className="field">
          <span className="field-label">Recipe per serving (raw, as purchased)</span>
          <p className="hint">Yield is the usable share after cleaning/trimming — 90% means 10% is lost in preparation.</p>
          <div className="stack" style={{ ["--gap" as string]: "6px" }}>
            {lines.map((l, i) => {
              const ing = byId.get(l.ingredientId);
              return (
                <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
                  <select
                    className="select"
                    value={l.ingredientId}
                    aria-label="Ingredient"
                    onChange={(e) => {
                      const next = byId.get(e.target.value);
                      setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value, unit: next ? UNITS[next.dimension][0] : x.unit } : x)));
                    }}
                  >
                    <option value="">Ingredient…</option>
                    {ingredients.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <input className="input num" style={{ width: 96 }} type="number" min={0} step="any" value={l.quantity} aria-label="Quantity" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  <select className="select" style={{ width: 84 }} value={l.unit} aria-label="Unit" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>
                    {(ing ? UNITS[ing.dimension] : ["g"]).map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                  <input className="input num" style={{ width: 72 }} type="number" min={1} max={100} value={l.yieldPct} aria-label="Yield percent" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, yieldPct: e.target.value } : x)))} />
                  <span className="text-sm muted">%</span>
                  <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
            <div>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setLines([...lines, { ingredientId: "", quantity: "", unit: "g", yieldPct: "100" }])}>
                Add ingredient
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function IngredientDialog({ ingredient, onClose }: { ingredient: Ingredient | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ingredient?.name ?? "");
  const [dimension, setDimension] = useState(ingredient?.dimension ?? "MASS");
  const [cost, setCost] = useState(ingredient?.costPerBaseUnit !== null && ingredient?.costPerBaseUnit !== undefined ? String(ingredient.costPerBaseUnit) : "");
  const [category, setCategory] = useState(ingredient?.category ?? "");
  const unit = { MASS: "kg", VOLUME: "l", COUNT: "unit" }[dimension];
  const m = useMutation({
    mutationFn: () =>
      ingredient
        ? api.patch(`/catalog/ingredients/${ingredient.id}`, { name, costPerBaseUnit: cost === "" ? null : Number(cost), category: category || undefined })
        : api.post("/catalog/ingredients", { name, dimension, costPerBaseUnit: cost === "" ? undefined : Number(cost), category: category || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={ingredient ? `Edit ${ingredient.name}` : "New ingredient"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={name.trim().length < 2} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField label="Measured by" value={dimension} onChange={(e) => setDimension(e.target.value as Ingredient["dimension"])} disabled={Boolean(ingredient)} hint={ingredient ? "Can't change once created — quantities depend on it." : "Weight, volume or count. Conversions only happen within the same kind."}>
          <option value="MASS">Weight (kg)</option>
          <option value="VOLUME">Volume (l)</option>
          <option value="COUNT">Count (units)</option>
        </SelectField>
        <TextField label={`Cost per ${unit}`} optional type="number" min={0} step="any" value={cost} onChange={(e) => setCost(e.target.value)} hint="Leave empty if unknown — cost estimates will say so instead of guessing." />
        <TextField label="Category" optional value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
    </Dialog>
  );
}

export default function Catalog({ editable }: { editable: boolean }) {
  const [tab, setTab] = useState<"dishes" | "ingredients">("dishes");
  const [editingDish, setEditingDish] = useState<Dish | null | "new">(null);
  const [editingIng, setEditingIng] = useState<Ingredient | null | "new">(null);
  const dishes = useQuery({ queryKey: ["catalog", "dishes"], queryFn: () => api.get<Dish[]>("/catalog/dishes") });
  const ingredients = useQuery({ queryKey: ["catalog", "ingredients"], queryFn: () => api.get<Ingredient[]>("/catalog/ingredients") });
  return (
    <div className="page">
      <PageHeader
        title={editable ? "Dishes & recipes" : "Recipes"}
        subtitle="Recipes turn an approved number of servings into ingredient quantities. Dishes without a recipe are flagged, never guessed."
        actions={
          editable ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => (tab === "dishes" ? setEditingDish("new") : setEditingIng("new"))}>
              {tab === "dishes" ? "New dish" : "New ingredient"}
            </Button>
          ) : undefined
        }
      />
      <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button role="tab" aria-selected={tab === "dishes"} onClick={() => setTab("dishes")}>
          Dishes {dishes.data && `(${dishes.data.length})`}
        </button>
        <button role="tab" aria-selected={tab === "ingredients"} onClick={() => setTab("ingredients")}>
          Ingredients {ingredients.data && `(${ingredients.data.length})`}
        </button>
      </div>
      {tab === "dishes" ? (
        <QueryState query={dishes}>
          {(list) =>
            list.length === 0 ? (
              <Empty title="No dishes yet" />
            ) : (
              <div className="grid-3">
                {list.map((d) => (
                  <article key={d.id} className="panel">
                    <div className="panel-head">
                      <h3>{d.name}</h3>
                      {editable && (
                        <Button size="sm" variant="ghost" onClick={() => setEditingDish(d)}>
                          Edit
                        </Button>
                      )}
                    </div>
                    <div className="panel-body stack" style={{ ["--gap" as string]: "8px" }}>
                      <div className="row text-xs">
                        {d.category && <span className="badge">{d.category}</span>}
                        {d.isVegetarian !== null && <span className={`badge ${d.isVegetarian ? "badge-yes" : "badge-outline"}`}>{d.isVegetarian ? "Veg" : "Non-veg"}</span>}
                        {d.portionGrams && <span className="muted">{d.portionGrams} g portion</span>}
                      </div>
                      {d.hasRecipe ? (
                        <ul className="text-sm" style={{ margin: 0, paddingLeft: 16 }}>
                          {d.ingredients.map((i) => {
                            const b = fromBase(i.quantityPerServing, i.dimension);
                            return (
                              <li key={i.ingredientId}>
                                {i.name} <span className="muted num">{fmtNum(b.qty, 1)} {b.unit}{i.yieldFactor < 1 ? ` · ${Math.round(i.yieldFactor * 100)}% yield` : ""}</span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <span className="badge badge-warn">No recipe — quantities can't be planned</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )
          }
        </QueryState>
      ) : (
        <QueryState query={ingredients}>
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Measured in</th>
                    <th className="n">Cost</th>
                    {editable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.name}
                        {i.category && <div className="text-xs muted">{i.category}</div>}
                      </td>
                      <td>{i.baseUnit}</td>
                      <td className="n">{i.costPerBaseUnit === null ? <span className="null">Unknown</span> : `${fmtMoney(i.costPerBaseUnit)} / ${i.baseUnit}`}</td>
                      {editable && (
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => setEditingIng(i)}>
                            Edit
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      )}
      {editingDish && ingredients.data && <RecipeEditor dish={editingDish === "new" ? null : editingDish} ingredients={ingredients.data} onClose={() => setEditingDish(null)} />}
      {editingIng && <IngredientDialog ingredient={editingIng === "new" ? null : editingIng} onClose={() => setEditingIng(null)} />}
    </div>
  );
}
