# Forecasting and analytics

## Forecasting method (`modules/forecasting/model.js`, version `vote-rates-beta-1.0`)

At cutoff every eligible student is in exactly one group — **YES**, **NO** or **UNVOTED** — so groups never double-count. UNVOTED is never treated as NO, and YES voters are not assumed to attend with certainty.

For each group *g*, the attendance rate is learned from this mess's **reconciled** meals of the same meal type (last `historyWindowDays`, up to `maxHistorySlots`, excluding holidays and special events) and shrunk toward a documented starting assumption with a Beta prior:

```
α_g = prior_g · k_g + attended_g        β_g = (1 − prior_g) · k_g + (total_g − attended_g)
rate_g = α_g / (α_g + β_g)

E[attendance] = Σ n_g · rate_g
Var           = Σ n_g · rate_g · (1 − rate_g)   (students attend independently)
              + Σ n_g² · Var[rate_g]            (uncertainty in the rate)
Recommended servings = min(eligible, ceil(E + z · σ)),  z = Φ⁻¹(service level)
Safety buffer        = recommended − ceil(E)
80 % range           = E ± 1.2816 σ (clipped to [0, eligible])
```

Default starting assumptions (institution policy, editable): YES 90 %, NO 3 %, UNVOTED 40 %, each weighted as 20 observations — real history dominates quickly. Default service level: 90 %.

| Method label | When |
|---|---|
| `VOTE_RATES_WITH_HISTORY` | ≥ 3 reconciled meals in the window |
| `VOTE_RATES_PRIOR_ONLY` | fewer — starting assumptions dominate; warned as `NO_HISTORY`/`LIMITED_HISTORY` |
| `CONSERVATIVE_FALLBACK` | the model threw; target = YES + UNVOTED, warned as `MODEL_FAILURE` |

Every forecast is persisted as a new version with its counts, rates, posterior parameters, history window, warnings and explanation. A supervisor approves it or overrides it with a reason; the approved plan records which forecast version it used. Accuracy (MAE, bias, MAPE, interval hit rate, target coverage) is evaluated against reconciled attendance (`GET /messes/:id/forecast-accuracy`, Analyze).

Not yet modelled (documented next steps): day-of-week and menu effects, exam calendars, weather.

## Ingredient planning (`modules/planning`)

```
dish servings   = ceil(approved servings × uptake fraction)
raw quantity    = dish servings × quantity per serving ÷ yield factor
shortfall       = max(0, required + safety stock − stock on hand)
to procure      = shortfall rounded up to pack size, at least the minimum order
```

Dishes without a recipe are listed as missing — quantities are never guessed. Requirements are frozen at approval for reproducibility. The procurement outlook sums upcoming meals (approved targets, else recommendations) and subtracts stock once.

## Metric definitions

All metrics come from `modules/analytics/metrics.js`, used by both supervisor and institution views. **Kinds:** MEASURED (counted/weighed), MANUAL (a person's decision), ESTIMATE (model or assumed factor), DERIVED (arithmetic on the others).

| Metric | Unit | Kind | Definition |
|---|---|---|---|
| Eligible at cutoff | students | measured | Members of the mess on the service date when voting closed |
| Voting participation | % | measured | (YES + NO) ÷ eligible |
| Non-response | % | measured | UNVOTED ÷ eligible |
| Actual attendance | students | measured | Attended at reconciliation (counter records after corrections) |
| YES show rate | % | measured | YES_ATTENDED ÷ YES voters |
| No-show rate | % | measured | YES_NO_SHOW ÷ YES voters (excused cases are not no-shows) |
| Walk-in share | % | measured | (NO_WALK_IN + UNVOTED_ATTENDED) ÷ attendance |
| Predicted attendance | students | estimate | Forecast used by the approved plan |
| Forecast error / bias | students | derived | predicted − actual; bias = mean error (positive = over-prediction) |
| MAE / MAPE | students / % | derived | mean \|error\|; mean \|error\| ÷ actual (meals with actual > 0) |
| Approved servings | servings | manual | Supervisor-approved target |
| Target above attendance | servings | derived | approved − actual |
| Food prepared | kg | measured | Σ prepared weight of every dish (only when every dish is recorded) |
| Reusable surplus / discarded leftovers / plate waste / kitchen waste | kg | measured | Σ food-log entries of that category (none → not recorded) |
| Discarded food | kg | measured | discarded leftovers + plate waste (needs both) |
| Food served | kg | derived | prepared − reusable surplus − discarded leftovers |
| Waste per serving | g | derived | discarded food × 1000 ÷ actual attendance |
| Waste rate | % | derived | discarded food ÷ prepared |
| Food cost per kg | currency/kg | estimate | issued ingredient cost ÷ prepared kg; else planned ingredient cost ÷ prepared kg; else the configured rate; else unknown |
| Cost of discarded food | currency | estimate | discarded food × cost per kg |
| Emissions | kg CO₂e | estimate | discarded food × factor (default 2.5, FAO 2013: ~3.3 Gt CO₂e / 1.3 Gt food wasted) |
| Change vs baseline | % | derived | (baseline g/serving − observed g/serving) ÷ baseline. Describes change, not cause |
| Waste avoided vs baseline | kg | estimate | (baseline − observed) g/serving × measured servings ÷ 1000 |
| Ingredient use vs plan | % | derived | (issued − planned) ÷ planned, for meals with issues recorded |
| Waste completeness | % | measured | closed meals with discarded food recorded ÷ closed meals |

Aggregation rules:

- Rates over many meals are **ratios of sums** over meals where both parts are known, not averages of per-meal ratios.
- Totals report how many meals they cover ("142 of 174 meals measured").
- A missing input makes the metric `null`; the UI shows "Not recorded", CSV exports leave the cell blank and say so in the header.
- Messes are compared on normalized metrics (g/serving, %, MAPE), not raw totals.
- No reduction is claimed without an admin-recorded baseline; savings use the observed cost basis and are labelled estimates.

## Recommendations

Rule-based findings, each with its evidence and a minimum sample: persistent forecast bias by meal type (≥ 5 meals, ≥ 3 students and ≥ 5 %), high non-response (≥ 30 %), targets consistently above attendance, meals that ran short, incomplete waste data (< 80 %), high-waste weekdays and dishes (≥ 1.5× average, correlation only), frequent overrides, unresolved incidents.

## Exports

`/messes/:id/analytics/export.csv` and `/admin/analytics/export.csv` include report title, scope, period, filters, generation time (UTC), the requesting user, currency, the "blank = not recorded" note, the data, and the metric definitions. Cells are protected against spreadsheet formula injection.
