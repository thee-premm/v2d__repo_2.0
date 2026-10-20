import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BarChart3 } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtKg, fmtMoney, fmtNum, fmtPct, fmtSigned } from "../../lib/format";
import { ColumnChart, HBarChart } from "../../components/charts";
import { Empty, Kind, Notice, PageHeader, QueryState, Stat } from "../../components/ui";
import { Completeness, PeriodBar, usePeriod } from "./common";

interface MessRow {
  messId: number;
  name: string;
  meals: number;
  reconciledMeals: number;
  averageAttendance: number | null;
  participationRate: number | null;
  noShowRate: number | null;
  meanAbsolutePercentError: number | null;
  forecastBias: number | null;
  discardedFoodKg: number | null;
  wastePerServingG: number | null;
  wasteRate: number | null;
  wasteCost: number | null;
  wasteCompletenessRate: number | null;
  baselineChangePercent: number | null;
  avoidedWasteKg: number | null;
}

export default function InstitutionAnalyze() {
  const period = usePeriod("semester");
  const p = period.period;
  const query = qs({ from: p.from, to: p.to, mealTypeId: p.mealTypeId });
  const q = useQuery({ queryKey: ["analytics", "institution", p], queryFn: () => api.get<any>(`/admin/analytics${query}`) });
  return (
    <div className="page">
      <PageHeader title="Institution analytics" subtitle="All messes, normalized per serving so messes of different sizes compare fairly." />
      <PeriodBar state={period} exportHref={`/api/v1/admin/analytics/export.csv${query}`} />
      <QueryState query={q} lines={10}>
        {(r) => {
          const s = r.summary;
          const messes: MessRow[] = r.messes;
          if (s.meals === 0)
            return (
              <Empty icon={<BarChart3 size={22} aria-hidden="true" />} title="No meals in this period">
                Try a longer period.
              </Empty>
            );
          return (
            <div className="stack" style={{ ["--gap" as string]: "32px" }}>
              <div className="stats">
                <Stat label="Meals reconciled" value={String(s.reconciledMeals)} foot={`across ${r.scope.messes} messes`} kind="measured" />
                <Stat label="Students served" value={fmtNum(s.actualAttendance)} foot="meal attendances" kind="measured" />
                <Stat label="Voting participation" value={s.participationRate === null ? null : fmtNum(s.participationRate, 1)} unit="%" kind="measured" />
                <Stat label="Forecast error" value={s.forecast.meanAbsolutePercentError === null ? null : fmtNum(s.forecast.meanAbsolutePercentError, 1)} unit="% MAPE" kind="derived" />
                <Stat label="Discarded food" value={s.discardedFoodKg.value === null ? null : fmtNum(s.discardedFoodKg.value, 0)} unit="kg" foot={`${s.discardedFoodKg.meals} of ${s.closedMeals} meals measured`} kind="measured" />
                <Stat label="Waste per serving" value={s.wastePerServingG.value === null ? null : fmtNum(s.wastePerServingG.value, 0)} unit="g" kind="derived" />
              </div>

              <section className="panel">
                <div className="panel-head">
                  <h3>
                    Estimated impact <Kind kind="estimate" />
                  </h3>
                  <span className="text-xs muted">{r.impact.messesWithBaseline} of {messes.length} messes have a baseline</span>
                </div>
                <div className="panel-body stack">
                  {r.impact.messesWithBaseline === 0 ? (
                    <Notice tone="info" title="No baselines recorded">
                      Without a measured reference period no reduction or saving is claimed. Add a baseline per mess under Policies &amp; meals.
                    </Notice>
                  ) : (
                    <div className="stats" style={{ border: 0 }}>
                      <Stat label="Waste avoided vs baseline" value={r.impact.avoidedWasteKg === null ? null : fmtNum(r.impact.avoidedWasteKg, 0)} unit="kg" />
                      <Stat label="Estimated savings" value={r.impact.estimatedSavings === null ? null : fmtMoney(r.impact.estimatedSavings)} foot={r.impact.savingsCostPerKg ? `at ${fmtMoney(r.impact.savingsCostPerKg)}/kg` : undefined} />
                      <Stat label="Emissions avoided" value={r.impact.avoidedCo2eKg === null ? null : fmtNum(r.impact.avoidedCo2eKg, 0)} unit="kg CO₂e" foot={`${r.assumptions.co2ePerKgFoodWaste} kg CO₂e/kg`} />
                    </div>
                  )}
                  <p className="text-xs muted">{r.impact.method}</p>
                  <p className="text-xs muted">Emission factor: {r.assumptions.co2eFactorSource}.</p>
                </div>
              </section>

              <section className="section">
                <div className="section-title">
                  <h2>Waste per serving by mess</h2>
                  <span className="text-sm muted">grams of discarded food per diner</span>
                </div>
                <div className="panel panel-body">
                  <HBarChart ariaLabel="Waste per serving by mess" unit=" g" data={messes.map((m) => ({ key: String(m.messId), label: m.name, value: m.wastePerServingG, note: m.wasteCompletenessRate !== null ? `${m.wasteCompletenessRate}% of meals measured` : undefined }))} format={(v) => fmtNum(v, 0)} />
                </div>
              </section>

              <section className="section">
                <h2>Mess comparison</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Mess</th>
                        <th className="n">Meals</th>
                        <th className="n">Avg attendance</th>
                        <th className="n">Participation</th>
                        <th className="n">No-show</th>
                        <th className="n">Forecast MAPE</th>
                        <th className="n">Waste g/serving</th>
                        <th className="n">Waste rate</th>
                        <th className="n">Data</th>
                        <th className="n">vs baseline</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {messes.map((m) => (
                        <tr key={m.messId}>
                          <td className="strong">{m.name}</td>
                          <td className="n">{m.meals}</td>
                          <td className="n">{fmtNum(m.averageAttendance, 0)}</td>
                          <td className="n">{fmtPct(m.participationRate)}</td>
                          <td className="n">{fmtPct(m.noShowRate)}</td>
                          <td className="n">{fmtPct(m.meanAbsolutePercentError)}</td>
                          <td className="n">{m.wastePerServingG === null ? <span className="null">not recorded</span> : fmtNum(m.wastePerServingG, 0)}</td>
                          <td className="n">{fmtPct(m.wasteRate)}</td>
                          <td className="n">{m.wasteCompletenessRate === null ? <span className="null">—</span> : `${fmtNum(m.wasteCompletenessRate, 0)}%`}</td>
                          <td className="n">{m.baselineChangePercent === null ? <span className="null">no baseline</span> : `${fmtSigned(-m.baselineChangePercent)}%`}</td>
                          <td>
                            <Link to={`/admin/analyze/mess/${m.messId}`} className="btn btn-sm btn-ghost" aria-label={`Open ${m.name} analytics`}>
                              Drill down <ArrowUpRight size={13} aria-hidden="true" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs muted">"vs baseline": change in waste per serving; negative means less waste than the baseline period.</p>
              </section>

              <div className="grid-2">
                <section className="section">
                  <div className="section-title">
                    <h2>Monthly trend</h2>
                    <span className="text-xs muted">waste per serving (g)</span>
                  </div>
                  <div className="panel panel-body">
                    <ColumnChart ariaLabel="Waste per serving by month" unit=" g" data={r.trends.monthly.map((m: any) => ({ key: m.key, label: m.key, value: m.wastePerServingG }))} />
                    <div className="table-wrap" style={{ marginTop: 12 }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Month</th>
                            <th className="n">Meals</th>
                            <th className="n">Discarded</th>
                            <th className="n">g/serving</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.trends.monthly.map((m: any) => (
                            <tr key={m.key}>
                              <td>{m.key}</td>
                              <td className="n">{m.meals}</td>
                              <td className="n">{fmtKg(m.discardedFoodKg, 0)}</td>
                              <td className="n">{fmtNum(m.wastePerServingG, 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
                <section className="section">
                  <h2>Measurement completeness</h2>
                  <div className="panel panel-body">
                    <Completeness c={s.completeness} />
                  </div>
                </section>
              </div>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
