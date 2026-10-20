import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtDate, fmtKg, fmtMoney, fmtNum, fmtPct, fmtSigned } from "../../lib/format";
import { useSession } from "../../lib/session";
import { ColumnChart, LineChart } from "../../components/charts";
import { Empty, Kind, Notice, PageHeader, QueryState, Stat } from "../../components/ui";
import { useMessScope } from "../../shell/messScope";
import { Completeness, PeriodBar, Recommendations, usePeriod } from "./common";

interface MB {
  value: number | null;
  meals: number;
}
interface MessReport {
  scope: { messId: number; messName: string; institution: string };
  currency: string;
  assumptions: { co2ePerKgFoodWaste: number; co2eFactorSource: string; configuredFoodCostPerKg: number | null };
  summary: {
    meals: number;
    closedMeals: number;
    reconciledMeals: number;
    participationRate: number | null;
    nonResponseRate: number | null;
    averageAttendance: number | null;
    noShowRate: number | null;
    walkInShare: number | null;
    forecast: { meals: number; meanAbsoluteError: number | null; forecastBias: number | null; meanAbsolutePercentError: number | null };
    shortfallMeals: number;
    preparedKg: MB;
    reusableSurplusKg: MB;
    discardedSurplusKg: MB;
    plateWasteKg: MB;
    kitchenWasteKg: MB;
    discardedFoodKg: MB;
    wastePerServingG: MB;
    wasteRate: MB;
    wasteCost: MB;
    co2eKg: MB;
    completeness: any;
  };
  baseline: { available: boolean; reason?: string; baseline?: { label: string; periodStart: string; periodEnd: string; gPerServing: number; basis: string; sourceNote: string }; observedGPerServing?: number; changePercent?: number; avoidedWasteKg?: number; interpretation?: string };
  trends: {
    byMealType: TrendRow[];
    byDayOfWeek: TrendRow[];
    byDate: TrendRow[];
    byDish: { dishId: number; name: string; meals: number; wastePerServingG: number | null; wasteMeasuredMeals: number }[];
  };
  ingredientVariance: { ingredientId: number; name: string; unit: string; meals: number; planned: number; issued: number; variancePercent: number | null; varianceCost: number | null }[];
  recommendations: any[];
  meals: any[];
}
interface TrendRow {
  key: string;
  label: string;
  meals: number;
  participationRate: number | null;
  averageAttendance: number | null;
  noShowRate: number | null;
  forecastBias: number | null;
  meanAbsolutePercentError: number | null;
  discardedFoodKg: number | null;
  wastePerServingG: number | null;
  wasteRate: number | null;
  wasteMeasuredMeals: number;
}

function Coverage({ m, of }: { m: MB; of: number }) {
  return <>{m.value === null ? `No measurements in ${of} closed meals` : `${m.meals} of ${of} closed meals`}</>;
}

function TrendTable({ rows, caption }: { rows: TrendRow[]; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th />
            <th className="n">Meals</th>
            <th className="n">Participation</th>
            <th className="n">Avg attendance</th>
            <th className="n">No-show</th>
            <th className="n">Forecast bias</th>
            <th className="n">Waste g/serving</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="strong">{r.label}</td>
              <td className="n">{r.meals}</td>
              <td className="n">{fmtPct(r.participationRate)}</td>
              <td className="n">{fmtNum(r.averageAttendance, 1)}</td>
              <td className="n">{fmtPct(r.noShowRate)}</td>
              <td className="n">{fmtSigned(r.forecastBias)}</td>
              <td className="n">{r.wastePerServingG === null ? <span className="null">not recorded</span> : fmtNum(r.wastePerServingG, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MessAnalyze() {
  const params = useParams();
  const { session } = useSession();
  const adminMode = Boolean(params.messId);
  return adminMode ? <Report messId={Number(params.messId)} adminMode /> : <SupervisorReport key={session?.user.id} />;
}

function SupervisorReport() {
  const { messId } = useMessScope();
  if (messId === null) return <div className="page"><Empty title="No mess assigned" /></div>;
  return <Report messId={messId} adminMode={false} />;
}

function Report({ messId, adminMode }: { messId: number; adminMode: boolean }) {
  const period = usePeriod("30d");
  const p = period.period;
  const query = qs({ from: p.from, to: p.to, mealTypeId: p.mealTypeId });
  const q = useQuery({ queryKey: ["analytics", "mess", messId, p], queryFn: () => api.get<MessReport>(`/messes/${messId}/analytics${query}`) });
  const [showMeals, setShowMeals] = useState(false);

  return (
    <div className="page">
      <PageHeader
        back={adminMode ? { to: "/admin/analyze", label: "Institution analytics" } : undefined}
        title={q.data ? `Analyze · ${q.data.scope.messName}` : "Analyze"}
        subtitle="Operational results from recorded data. Estimates are labelled; missing data is shown as missing."
      />
      <PeriodBar state={period} exportHref={`/api/v1/messes/${messId}/analytics/export.csv${query}`} />
      <QueryState query={q} lines={10}>
        {(r) => {
          const s = r.summary;
          if (s.meals === 0)
            return (
              <Empty icon={<BarChart3 size={22} aria-hidden="true" />} title="No meals in this period">
                Analytics start once meals have been locked and served. Try a longer period.
              </Empty>
            );
          const reconciled = r.meals.filter((m) => m.actualAttendance !== null && m.predictedAttendance !== null);
          return (
            <div className="stack" style={{ ["--gap" as string]: "32px" }}>
              <div className="stats" aria-label="Key results">
                <Stat label="Meals reconciled" value={`${s.reconciledMeals}`} foot={`of ${s.meals} in period`} kind="measured" />
                <Stat label="Average attendance" value={fmtNum(s.averageAttendance, 0)} unit="per meal" kind="measured" />
                <Stat label="Voting participation" value={s.participationRate === null ? null : fmtNum(s.participationRate, 1)} unit="%" foot={s.nonResponseRate !== null ? `${fmtNum(s.nonResponseRate, 1)}% did not vote` : undefined} kind="measured" />
                <Stat label="No-show rate" value={s.noShowRate === null ? null : fmtNum(s.noShowRate, 1)} unit="%" foot="of yes voters" kind="measured" />
                <Stat label="Forecast error" value={s.forecast.meanAbsolutePercentError === null ? null : fmtNum(s.forecast.meanAbsolutePercentError, 1)} unit="% MAPE" foot={s.forecast.forecastBias !== null ? `bias ${fmtSigned(s.forecast.forecastBias)} students/meal` : undefined} kind="derived" />
                <Stat label="Discarded food" value={s.discardedFoodKg.value === null ? null : fmtNum(s.discardedFoodKg.value, 1)} unit="kg" foot={<Coverage m={s.discardedFoodKg} of={s.closedMeals} />} kind="measured" />
                <Stat label="Waste per serving" value={s.wastePerServingG.value === null ? null : fmtNum(s.wastePerServingG.value, 0)} unit="g" foot={s.wasteRate.value !== null ? `${fmtNum(s.wasteRate.value, 1)}% of food prepared` : undefined} kind="derived" />
                <Stat label="Cost of discarded food" value={s.wasteCost.value === null ? null : fmtMoney(s.wasteCost.value)} foot="ingredient cost basis" kind="estimate" />
              </div>

              <div className="grid-2">
                <section className="panel">
                  <div className="panel-head">
                    <h3>Measurement completeness</h3>
                  </div>
                  <div className="panel-body">
                    <Completeness c={s.completeness} />
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <h3>Findings</h3>
                    <span className="text-xs muted">Rule-based, with evidence</span>
                  </div>
                  <div className="panel-body">
                    <Recommendations items={r.recommendations} />
                  </div>
                </section>
              </div>

              <section className="section">
                <div className="section-title">
                  <h2>Waste per serving</h2>
                  <span className="text-sm muted">Discarded leftovers + plate waste ÷ diners, per day</span>
                </div>
                <div className="panel panel-body">
                  <ColumnChart
                    ariaLabel="Waste per serving by day, grams"
                    unit=" g"
                    data={r.trends.byDate.map((d) => ({ key: d.key, label: fmtDate(d.key).replace(/^\w+, /, ""), value: d.wastePerServingG, detail: <div className="t-row"><span>Meals measured</span><strong>{d.wasteMeasuredMeals} of {d.meals}</strong></div> }))}
                    reference={r.baseline.available && r.baseline.baseline ? { value: r.baseline.baseline.gPerServing, label: `Baseline ${r.baseline.baseline.gPerServing} g` } : undefined}
                  />
                  <p className="text-xs muted" style={{ marginTop: 8 }}>
                    Dotted marks: days with no complete waste record.
                  </p>
                </div>
              </section>

              <section className="section">
                <div className="section-title">
                  <h2>Forecast vs actual attendance</h2>
                  <span className="text-sm muted">{reconciled.length} reconciled meals</span>
                </div>
                <div className="panel panel-body">
                  {reconciled.length < 2 ? (
                    <p className="text-sm muted">At least two reconciled meals with a forecast are needed.</p>
                  ) : (
                    <LineChart
                      ariaLabel="Actual and predicted attendance per meal"
                      series={[{ label: "Actual" }, { label: "Predicted" }]}
                      data={reconciled.map((m) => ({ key: String(m.slotId), label: `${fmtDate(m.serviceDate).replace(/^\w+, /, "")} ${m.mealType[0]}`, a: m.actualAttendance, b: m.predictedAttendance }))}
                    />
                  )}
                </div>
              </section>

              <section className="section">
                <h2>By meal</h2>
                <TrendTable rows={r.trends.byMealType} caption="Results by meal type" />
              </section>
              <section className="section">
                <h2>By day of week</h2>
                <TrendTable rows={r.trends.byDayOfWeek} caption="Results by day of week" />
              </section>

              <div className="grid-2">
                <section className="section">
                  <div className="section-title">
                    <h2>By dish</h2>
                    <span className="text-xs muted">Meals that served each dish · correlation, not cause</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Dish</th>
                          <th className="n">Meals</th>
                          <th className="n">Waste g/serving</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.trends.byDish.slice(0, 12).map((d) => (
                          <tr key={d.dishId}>
                            <td>{d.name}</td>
                            <td className="n">{d.meals}</td>
                            <td className="n">{d.wastePerServingG === null ? <span className="null">not recorded</span> : fmtNum(d.wastePerServingG, 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="section">
                  <div className="section-title">
                    <h2>Ingredient use vs plan</h2>
                    <span className="text-xs muted">Issues recorded against meals</span>
                  </div>
                  {r.ingredientVariance.length === 0 ? (
                    <p className="text-sm muted">No ingredient issues were linked to meals in this period, so usage can't be compared with the plan.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Ingredient</th>
                            <th className="n">Planned</th>
                            <th className="n">Issued</th>
                            <th className="n">Variance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.ingredientVariance.map((v) => (
                            <tr key={v.ingredientId}>
                              <td>
                                {v.name} <span className="text-xs muted">({v.meals} meals)</span>
                              </td>
                              <td className="n">
                                {fmtNum(v.planned, 1)} {v.unit}
                              </td>
                              <td className="n">
                                {fmtNum(v.issued, 1)} {v.unit}
                              </td>
                              <td className="n" style={{ color: v.variancePercent !== null && Math.abs(v.variancePercent) > 10 ? "var(--warn-text)" : undefined }}>
                                {v.variancePercent === null ? "—" : `${fmtSigned(v.variancePercent)}%`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>

              <div className="grid-2">
                <section className="panel">
                  <div className="panel-head">
                    <h3>
                      Food flow <Kind kind="measured" />
                    </h3>
                  </div>
                  <div className="panel-body">
                    <dl className="dl">
                      <dt>Prepared</dt>
                      <dd>{fmtKg(s.preparedKg.value)} <span className="text-xs muted">({s.preparedKg.meals} meals)</span></dd>
                      <dt>Reusable surplus</dt>
                      <dd>{fmtKg(s.reusableSurplusKg.value)} <span className="text-xs muted">({s.reusableSurplusKg.meals} meals)</span></dd>
                      <dt>Discarded leftovers</dt>
                      <dd>{fmtKg(s.discardedSurplusKg.value)} <span className="text-xs muted">({s.discardedSurplusKg.meals} meals)</span></dd>
                      <dt>Plate waste</dt>
                      <dd>{fmtKg(s.plateWasteKg.value)} <span className="text-xs muted">({s.plateWasteKg.meals} meals)</span></dd>
                      <dt>Kitchen prep waste</dt>
                      <dd>{fmtKg(s.kitchenWasteKg.value)} <span className="text-xs muted">({s.kitchenWasteKg.meals} meals, reported separately)</span></dd>
                    </dl>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <h3>
                      Against baseline <Kind kind="derived" />
                    </h3>
                  </div>
                  <div className="panel-body stack">
                    {!r.baseline.available ? (
                      <p className="text-sm muted">
                        {r.baseline.reason === "NO_BASELINE"
                          ? "No baseline has been recorded for this mess, so no reduction is claimed. An institution admin can add a measured pre-deployment baseline."
                          : "No measured waste in this period to compare."}
                      </p>
                    ) : (
                      <>
                        <div className="row" style={{ ["--gap" as string]: "28px" }}>
                          <div>
                            <div className="text-sm muted">Baseline</div>
                            <div className="stat-value num">{r.baseline.baseline!.gPerServing} g</div>
                          </div>
                          <div>
                            <div className="text-sm muted">This period</div>
                            <div className="stat-value num">{fmtNum(r.baseline.observedGPerServing!, 0)} g</div>
                          </div>
                          <div>
                            <div className="text-sm muted">Change</div>
                            <div className="stat-value num" style={{ color: (r.baseline.changePercent ?? 0) > 0 ? "var(--ok-text)" : "var(--danger-text)" }}>
                              {(r.baseline.changePercent ?? 0) > 0 ? "−" : "+"}
                              {fmtNum(Math.abs(r.baseline.changePercent ?? 0), 1)}%
                            </div>
                          </div>
                        </div>
                        <p className="text-sm">
                          About <strong>{fmtKg(r.baseline.avoidedWasteKg ?? null)}</strong> less discarded food than the baseline rate would imply <Kind kind="estimate" />.
                        </p>
                        <p className="text-xs muted">
                          Baseline: {r.baseline.baseline!.label} ({fmtDate(r.baseline.baseline!.periodStart)} – {fmtDate(r.baseline.baseline!.periodEnd)}, {r.baseline.baseline!.basis.toLowerCase()}). {r.baseline.interpretation}
                        </p>
                      </>
                    )}
                    {s.co2eKg.value !== null && (
                      <p className="text-xs muted">
                        Discarded food ≈ {fmtNum(s.co2eKg.value, 0)} kg CO₂e <Kind kind="estimate" /> at {r.assumptions.co2ePerKgFoodWaste} kg CO₂e/kg ({r.assumptions.co2eFactorSource}).
                      </p>
                    )}
                  </div>
                </section>
              </div>

              <section className="section">
                <div className="section-title">
                  <h2>Every meal</h2>
                  <button className="btn btn-sm" onClick={() => setShowMeals((v) => !v)} aria-expanded={showMeals}>
                    {showMeals ? "Hide" : `Show ${r.meals.length} meals`}
                  </button>
                </div>
                {showMeals && (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Meal</th>
                          <th className="n">Eligible</th>
                          <th className="n">Yes / No / —</th>
                          <th className="n">Predicted</th>
                          <th className="n">Target</th>
                          <th className="n">Actual</th>
                          <th className="n">Discarded</th>
                          <th className="n">g/serving</th>
                          <th>Data</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.meals.map((m) => (
                          <tr key={m.slotId}>
                            <td>
                              {m.mealTypeName} <span className="text-xs muted">{fmtDate(m.serviceDate)}</span>
                            </td>
                            <td className="n">{fmtNum(m.eligible)}</td>
                            <td className="n">
                              {m.yes ?? "—"} / {m.no ?? "—"} / {m.unvoted ?? "—"}
                            </td>
                            <td className="n">{fmtNum(m.predictedAttendance, 1)}</td>
                            <td className="n">{fmtNum(m.approvedServings)}</td>
                            <td className="n">{fmtNum(m.actualAttendance)}</td>
                            <td className="n">{m.discardedFoodKg === null ? <span className="null">—</span> : fmtNum(m.discardedFoodKg, 2)}</td>
                            <td className="n">{m.wastePerServingG === null ? <span className="null">—</span> : fmtNum(m.wastePerServingG, 0)}</td>
                            <td className="text-xs">
                              <span className={`badge ${m.quality.waste === "MEASURED" ? "badge-ok" : m.quality.waste === "MISSING" ? "badge-outline" : "badge-warn"}`}>waste {m.quality.waste.toLowerCase()}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              {r.assumptions.configuredFoodCostPerKg === null && s.wasteCost.value === null && (
                <Notice tone="info">Cost estimates need ingredient costs on recipes, or a food cost per kg in institution policies.</Notice>
              )}
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
