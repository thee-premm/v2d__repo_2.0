import { z } from "zod";

/**
 * Institution policy settings, stored in institutions.settings (JSONB) and
 * always read through `resolveSettings` so missing keys fall back to the
 * documented defaults below.
 */
const rateBelief = z.object({
  rate: z.number().min(0).max(1),
  // Weight of the prior, in student-observations. Real history quickly dominates.
  strength: z.number().min(0).max(500),
});

export const settingsSchema = z.object({
  walkIn: z
    .object({
      // Policy when a student who voted NO arrives at the counter.
      noVoter: z.enum(["ALLOW", "REQUIRE_AUTHORIZATION"]),
      // Policy when a student who did not vote arrives.
      unvoted: z.enum(["ALLOW", "REQUIRE_AUTHORIZATION"]),
    })
    .strict(),
  warnings: z
    .object({
      enabled: z.boolean(),
      // Trailing window used to decide the warning tier.
      windowDays: z.number().int().min(1).max(365),
      // How long after issue a student may appeal.
      appealWindowDays: z.number().int().min(1).max(60),
    })
    .strict(),
  service: z
    .object({
      // How early before the scheduled start a supervisor may open the counter.
      earlyStartMinutes: z.number().int().min(0).max(180),
    })
    .strict(),
  forecast: z
    .object({
      // Probability that the recommended servings cover actual attendance.
      serviceLevel: z.number().min(0.5).max(0.995),
      historyWindowDays: z.number().int().min(7).max(365),
      maxHistorySlots: z.number().int().min(3).max(200),
      priors: z.object({ yes: rateBelief, no: rateBelief, unvoted: rateBelief }).strict(),
    })
    .strict(),
  analytics: z
    .object({
      // Cost of one kg of prepared food, used only when ingredient costs cannot derive it. null = unknown.
      foodCostPerKg: z.number().min(0).max(100000).nullable(),
      // kg CO2e per kg of food waste. Default from FAO (2013) "Food Wastage Footprint":
      // 3.3 Gt CO2e for 1.3 Gt of food wasted ≈ 2.5 kg CO2e/kg.
      co2ePerKgFoodWaste: z.number().min(0).max(50),
      co2eFactorSource: z.string().max(300),
    })
    .strict(),
  notifications: z
    .object({
      closingReminderMinutes: z.number().int().min(5).max(1440),
    })
    .strict(),
});

export const DEFAULT_SETTINGS = Object.freeze({
  walkIn: { noVoter: "REQUIRE_AUTHORIZATION", unvoted: "ALLOW" },
  warnings: { enabled: true, windowDays: 30, appealWindowDays: 7 },
  service: { earlyStartMinutes: 30 },
  forecast: {
    serviceLevel: 0.9,
    historyWindowDays: 56,
    maxHistorySlots: 30,
    // Documented starting assumptions used until reconciled history exists.
    priors: {
      yes: { rate: 0.9, strength: 20 },
      no: { rate: 0.03, strength: 20 },
      unvoted: { rate: 0.4, strength: 20 },
    },
  },
  analytics: {
    foodCostPerKg: null,
    co2ePerKgFoodWaste: 2.5,
    co2eFactorSource: "FAO (2013) Food Wastage Footprint: ~3.3 Gt CO2e per 1.3 Gt food wasted",
  },
  notifications: { closingReminderMinutes: 60 },
});

function deepMerge(base, override) {
  if (override === undefined || override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Stored settings merged over defaults; invalid stored values fall back to defaults. */
export function resolveSettings(stored) {
  const merged = deepMerge(DEFAULT_SETTINGS, stored ?? {});
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export const settingsPatchSchema = settingsSchema.deepPartial();
export { deepMerge };
