import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";

export interface Dish {
  id: number;
  name: string;
  category: string | null;
  isVegetarian: boolean | null;
  portionGrams: number | null;
  hasRecipe: boolean;
  isActive: boolean;
}
export interface MenuLine {
  dishId: number;
  uptakeFraction: number;
}

export function useDishes() {
  return useQuery({ queryKey: ["catalog", "dishes"], queryFn: () => api.get<Dish[]>("/catalog/dishes"), staleTime: 60_000 });
}

/**
 * Menu editor: dishes in serving order, each with the share of diners
 * expected to take it (drives ingredient quantities).
 */
export function MenuPicker({ value, onChange }: { value: MenuLine[]; onChange: (v: MenuLine[]) => void }) {
  const dishes = useDishes();
  const [adding, setAdding] = useState("");
  const byId = new Map((dishes.data ?? []).map((d) => [d.id, d]));
  const available = (dishes.data ?? []).filter((d) => d.isActive && !value.some((v) => v.dishId === d.id));
  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      {value.length === 0 && <p className="text-sm muted">No dishes yet. Students see the menu when they vote.</p>}
      {value.length > 0 && (
        <ul className="panel ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {value.map((line, i) => {
            const d = byId.get(line.dishId);
            return (
              <li key={line.dishId} className="row" style={{ padding: "8px 12px", flexWrap: "nowrap" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="strong text-sm">{d?.name ?? `Dish ${line.dishId}`}</span>
                  {d && !d.hasRecipe && <span className="badge badge-warn" style={{ marginLeft: 8 }}>No recipe</span>}
                </span>
                <label className="row text-sm" style={{ ["--gap" as string]: "6px", flexWrap: "nowrap" }}>
                  <span className="muted">Taken by</span>
                  <input
                    type="number"
                    className="input num"
                    style={{ width: 72, minHeight: 32, padding: "4px 8px" }}
                    min={1}
                    max={100}
                    value={Math.round(line.uptakeFraction * 100)}
                    onChange={(e) => {
                      const pct = Math.min(100, Math.max(1, Number(e.target.value) || 100));
                      onChange(value.map((v, j) => (j === i ? { ...v, uptakeFraction: pct / 100 } : v)));
                    }}
                    aria-label={`Share of diners taking ${d?.name ?? "dish"} (%)`}
                  />
                  <span className="muted">%</span>
                </label>
                <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${d?.name ?? "dish"}`}>
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select className="select" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Dish to add" disabled={dishes.isLoading}>
          <option value="">{dishes.isLoading ? "Loading dishes…" : "Choose a dish to add…"}</option>
          {available.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.hasRecipe ? "" : " (no recipe)"}
            </option>
          ))}
        </select>
        <Button
          icon={<Plus size={15} />}
          disabled={!adding}
          onClick={() => {
            onChange([...value, { dishId: Number(adding), uptakeFraction: 1 }]);
            setAdding("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
