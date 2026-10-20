/**
 * Vote-conditioned attendance forecast (pure functions, no I/O).
 *
 * At cutoff every eligible student is in exactly one group — YES, NO or
 * UNVOTED — so the groups never double-count. Each group has its own
 * attendance rate, estimated from this mess's reconciled history for the same
 * meal type and shrunk toward a documented prior (Beta–Binomial):
 *
 *   rate_g ~ Beta(α_g, β_g),  α_g = prior_g·k_g + attended_g,  β_g = (1−prior_g)·k_g + (total_g − attended_g)
 *   E[attendance] = Σ_g n_g · E[rate_g]
 *   Var           = Σ_g n_g·r_g·(1−r_g)          (students attend independently)
 *                 + Σ_g n_g²·Var[rate_g]          (uncertainty in the rate itself)
 *
 * Recommended servings = ceil(E + z·σ), with z the one-sided normal quantile
 * of the configured service level, capped at the number of eligible students
 * (no one else can attend). The difference is the safety buffer.
 */
export const MODEL_VERSION = "vote-rates-beta-1.0";

export const METHODS = Object.freeze({
  HISTORY: "VOTE_RATES_WITH_HISTORY",
  PRIOR: "VOTE_RATES_PRIOR_ONLY",
  FALLBACK: "CONSERVATIVE_FALLBACK",
});

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function posterior(prior, attended, total) {
  const alpha = prior.rate * prior.strength + attended;
  const beta = (1 - prior.rate) * prior.strength + (total - attended);
  const sum = alpha + beta;
  if (sum <= 0) return { alpha, beta, mean: prior.rate, variance: 0 };
  return { alpha, beta, mean: alpha / sum, variance: (alpha * beta) / (sum * sum * (sum + 1)) };
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * @param counts   { eligible, yes, no, unvoted }  — from the cutoff snapshot
 * @param history  { slotCount, yes: {total, attended}, no: {...}, unvoted: {...} }
 * @param config   { serviceLevel, priors: { yes, no, unvoted } }
 * @param flags    { specialEvent, examPeriod, holiday, menuMissing }
 */
export function forecastAttendance(counts, history, config, flags = {}) {
  const groups = ["yes", "no", "unvoted"];
  const post = Object.fromEntries(groups.map((g) => [g, posterior(config.priors[g], history[g].attended, history[g].total)]));
  const mean = groups.reduce((s, g) => s + counts[g] * post[g].mean, 0);
  const variance = groups.reduce((s, g) => s + counts[g] * post[g].mean * (1 - post[g].mean) + counts[g] ** 2 * post[g].variance, 0);
  const sd = Math.sqrt(variance);
  const z = normalQuantile(config.serviceLevel);
  const intervalZ = normalQuantile(0.9); // two-sided 80 % interval
  const cap = counts.eligible;
  const recommended = Math.min(cap, Math.max(Math.ceil(mean), Math.ceil(mean + z * sd)));

  const warnings = [];
  if (history.slotCount === 0) warnings.push({ code: "NO_HISTORY", message: "No reconciled meals of this type yet; rates are the documented starting assumptions." });
  else if (history.slotCount < 5) warnings.push({ code: "LIMITED_HISTORY", message: `Only ${history.slotCount} reconciled meal(s) inform the rates; uncertainty is high.` });
  if (counts.eligible > 0 && counts.unvoted / counts.eligible > 0.4) {
    warnings.push({ code: "HIGH_NON_RESPONSE", message: `${Math.round((100 * counts.unvoted) / counts.eligible)}% of eligible students did not vote; the estimate leans on the non-responder rate.` });
  }
  if (flags.specialEvent) warnings.push({ code: "SPECIAL_EVENT", message: "Special event: past meals may not reflect demand." });
  if (flags.holiday) warnings.push({ code: "HOLIDAY", message: "Holiday: attendance patterns may differ from regular days." });
  if (flags.examPeriod) warnings.push({ code: "EXAM_PERIOD", message: "Exam period flagged." });
  if (flags.menuMissing) warnings.push({ code: "MENU_MISSING", message: "No menu is set, so ingredient requirements cannot be calculated." });
  if (counts.eligible === 0) warnings.push({ code: "NO_ELIGIBLE_STUDENTS", message: "No students were eligible at cutoff." });

  return {
    method: history.slotCount >= 3 ? METHODS.HISTORY : METHODS.PRIOR,
    modelVersion: MODEL_VERSION,
    rates: { yes: round(post.yes.mean, 5), no: round(post.no.mean, 5), unvoted: round(post.unvoted.mean, 5) },
    predictedAttendance: round(mean),
    standardDeviation: round(sd),
    interval: { low: round(Math.max(0, mean - intervalZ * sd)), high: round(Math.min(cap, mean + intervalZ * sd)), level: 0.8 },
    serviceLevel: config.serviceLevel,
    z: round(z, 4),
    recommendedServings: recommended,
    safetyBufferServings: Math.max(0, recommended - Math.ceil(mean)),
    posterior: Object.fromEntries(groups.map((g) => [g, { alpha: round(post[g].alpha, 3), beta: round(post[g].beta, 3) }])),
    warnings,
  };
}

/**
 * Used only if the model itself fails. Assumes every student who did not say
 * NO attends — conservative for availability, explicitly labelled.
 */
export function conservativeFallback(counts, reason) {
  const predicted = counts.yes + counts.unvoted;
  return {
    method: METHODS.FALLBACK,
    modelVersion: MODEL_VERSION,
    rates: { yes: 1, no: 0, unvoted: 1 },
    predictedAttendance: predicted,
    standardDeviation: null,
    interval: null,
    serviceLevel: 1,
    z: null,
    recommendedServings: predicted,
    safetyBufferServings: 0,
    posterior: null,
    warnings: [{ code: "MODEL_FAILURE", message: `The forecasting model failed (${reason}); using YES + UNVOTED as a conservative target.` }],
  };
}
