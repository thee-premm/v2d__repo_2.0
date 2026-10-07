import { query } from "../config/db.js";
import { logger } from "../utils/logger.js";

export const impactService = {
  /**
   * 1. Kitchen Waste Ingestion
   */
  async logKitchenWaste({
    mealSlotId,
    cookedMassKg,
    consumedMassKg,
    discardedMassKg,
    unitCostPerKg = 3.5,
    baselineWasteKg,
    loggedByUserId,
  }) {
    const cooked = parseFloat(cookedMassKg) || 0;
    const consumed = parseFloat(consumedMassKg) || 0;
    const discarded =
      discardedMassKg !== undefined
        ? parseFloat(discardedMassKg)
        : Math.max(0, cooked - consumed);
    const unitCost = parseFloat(unitCostPerKg) || 3.5;
    // If baseline waste not provided, compute unmanaged baseline waste as ~25% of cooked food
    const baselineWaste =
      baselineWasteKg !== undefined
        ? parseFloat(baselineWasteKg)
        : Number((cooked * 0.25).toFixed(2));

    const slotRes = await query(`SELECT * FROM meal_slots WHERE id = $1`, [
      mealSlotId,
    ]);
    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot #${mealSlotId} not found` };
    }

    const insertSql = `
      INSERT INTO kitchen_waste_logs (
        meal_slot_id, 
        cooked_mass_kg, 
        consumed_mass_kg, 
        discarded_mass_kg, 
        unit_cost_per_kg, 
        baseline_waste_kg,
        actual_cooked_kg,
        actual_consumed_kg,
        leftover_waste_kg,
        baseline_estimated_waste_kg,
        logged_by, 
        logged_at, 
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $2, $3, $4, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (meal_slot_id)
      DO UPDATE SET
        cooked_mass_kg = EXCLUDED.cooked_mass_kg,
        consumed_mass_kg = EXCLUDED.consumed_mass_kg,
        discarded_mass_kg = EXCLUDED.discarded_mass_kg,
        unit_cost_per_kg = EXCLUDED.unit_cost_per_kg,
        baseline_waste_kg = EXCLUDED.baseline_waste_kg,
        actual_cooked_kg = EXCLUDED.cooked_mass_kg,
        actual_consumed_kg = EXCLUDED.consumed_mass_kg,
        leftover_waste_kg = EXCLUDED.discarded_mass_kg,
        baseline_estimated_waste_kg = EXCLUDED.baseline_waste_kg,
        logged_by = EXCLUDED.logged_by,
        logged_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const res = await query(insertSql, [
      mealSlotId,
      cooked,
      consumed,
      discarded,
      unitCost,
      baselineWaste,
      loggedByUserId || null,
    ]);

    const avoidedWasteKg = Math.max(0, baselineWaste - discarded);
    const savingsAmount = Number((avoidedWasteKg * unitCost).toFixed(2));

    logger.info(
      `[ImpactService] Kitchen waste logged for slot #${mealSlotId}: Cooked: ${cooked}kg, Discarded: ${discarded}kg, Savings: $${savingsAmount}`,
    );

    return {
      wasteLog: res.rows[0],
      avoidedWasteKg,
      savingsAmount,
    };
  },

  /**
   * 2. KPI Analytics Pipeline & BI Dashboard Aggregation
   */
  async getImpactDashboard({ messId, startDate, endDate, limit = 90 }) {
    let sql = `
      SELECT 
        ms.id AS meal_slot_id,
        ms.slot_date,
        ms.is_exam_period,
        mt.name AS meal_type_name,
        m.name AS mess_name,
        COALESCE(mda.expected_attendance, 0)::INT AS expected_attendance,
        COALESCE(mda.yes_votes, 0)::INT AS yes_votes,
        COALESCE(mda.no_votes, 0)::INT AS no_votes,
        COALESCE(mda.total_enrolled, 0)::INT AS total_enrolled,
        COALESCE(att.actual_attendance, 0)::INT AS actual_attendance,
        COALESCE(att.present_count, 0)::INT AS present_count,
        COALESCE(att.absent_count, 0)::INT AS absent_count,
        COALESCE(att.excused_count, 0)::INT AS excused_override_count,
        COALESCE(att.walk_in_count, 0)::INT AS unvoted_walk_in_count,
        kwl.cooked_mass_kg,
        kwl.consumed_mass_kg,
        kwl.discarded_mass_kg,
        kwl.unit_cost_per_kg,
        kwl.baseline_waste_kg,
        afl.predicted_attendance,
        afl.window_k
      FROM meal_slots ms
      JOIN meal_types mt ON ms.meal_type_id = mt.id
      JOIN messes m ON ms.mess_id = m.id
      LEFT JOIN meal_demand_aggregates mda ON ms.id = mda.meal_slot_id
      LEFT JOIN (
        SELECT 
          meal_slot_id,
          COUNT(*) FILTER (WHERE verification_status IN ('PRESENT', 'EXCUSED_OVERRIDE', 'UNVOTED_WALK_IN'))::INT AS actual_attendance,
          COUNT(*) FILTER (WHERE verification_status = 'PRESENT')::INT AS present_count,
          COUNT(*) FILTER (WHERE verification_status = 'ABSENT')::INT AS absent_count,
          COUNT(*) FILTER (WHERE verification_status = 'EXCUSED_OVERRIDE')::INT AS excused_count,
          COUNT(*) FILTER (WHERE verification_status = 'UNVOTED_WALK_IN')::INT AS walk_in_count
        FROM attendance_records
        GROUP BY meal_slot_id
      ) att ON ms.id = att.meal_slot_id
      LEFT JOIN kitchen_waste_logs kwl ON ms.id = kwl.meal_slot_id
      LEFT JOIN ai_forecast_logs afl ON ms.id = afl.meal_slot_id
      WHERE 1=1
    `;

    const params = [];

    if (messId) {
      params.push(messId);
      sql += ` AND ms.mess_id = $${params.length}`;
    }
    if (startDate) {
      params.push(startDate);
      sql += ` AND ms.slot_date >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      sql += ` AND ms.slot_date <= $${params.length}`;
    }

    sql += ` ORDER BY ms.slot_date DESC, ms.id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query(sql, params);
    const slots = res.rows;

    if (slots.length === 0) {
      return {
        summary: {
          totalMealCycles: 0,
          totalMealsServed: 0,
          meanDemandDeviation: 0,
          noShowFrequencyPercent: 0,
          forecastMapePercent: 0,
          empiricalWasteReductionPercent: 0,
          totalAvoidedWasteKg: 0,
          totalEconomicCostSavings: 0,
        },
        timeSeries: [],
      };
    }

    let totalDemandDeviation = 0;
    let deviationCount = 0;
    let totalYesVotes = 0;
    let totalNoShows = 0;
    let totalAbsolutePercentError = 0;
    let mapeCount = 0;
    let totalBaselineWasteKg = 0;
    let totalActualWasteKg = 0;
    let totalEconomicSavings = 0;
    let totalMealsServed = 0;

    const timeSeries = [];

    for (const slot of slots) {
      const exp = slot.expected_attendance || slot.yes_votes || 0;
      const act = slot.actual_attendance || 0;
      const noShows =
        slot.absent_count || Math.max(0, slot.yes_votes - slot.present_count);
      const pred = slot.predicted_attendance
        ? parseFloat(slot.predicted_attendance)
        : null;

      // Demand Deviation = |A_expected - A_actual|
      const demandDev = Math.abs(exp - act);
      totalDemandDeviation += demandDev;
      deviationCount++;

      // No-Show tracking
      totalYesVotes += slot.yes_votes;
      totalNoShows += noShows;

      // MAPE = |A_actual - A_pred| / A_actual
      let slotApe = null;
      if (pred !== null && act > 0) {
        slotApe = Number(((Math.abs(act - pred) / act) * 100).toFixed(2));
        totalAbsolutePercentError += slotApe;
        mapeCount++;
      }

      // Waste Metrics
      const discarded = slot.discarded_mass_kg
        ? parseFloat(slot.discarded_mass_kg)
        : 0;
      const baseline = slot.baseline_waste_kg
        ? parseFloat(slot.baseline_waste_kg)
        : slot.cooked_mass_kg
          ? parseFloat(slot.cooked_mass_kg) * 0.25
          : 0;
      const unitCost = slot.unit_cost_per_kg
        ? parseFloat(slot.unit_cost_per_kg)
        : 3.5;

      totalActualWasteKg += discarded;
      totalBaselineWasteKg += baseline;

      const avoidedWasteKg = Math.max(0, baseline - discarded);
      const slotSavings = avoidedWasteKg * unitCost;
      totalEconomicSavings += slotSavings;
      totalMealsServed += act;

      timeSeries.push({
        mealSlotId: slot.meal_slot_id,
        date: slot.slot_date,
        mealType: slot.meal_type_name,
        isExamPeriod: slot.is_exam_period,
        expectedAttendance: exp,
        actualAttendance: act,
        predictedAttendance: pred,
        demandDeviation: demandDev,
        noShows,
        slotMAPE: slotApe,
        cookedKg: slot.cooked_mass_kg ? parseFloat(slot.cooked_mass_kg) : 0,
        discardedKg: discarded,
        baselineWasteKg: baseline,
        avoidedWasteKg: Number(avoidedWasteKg.toFixed(2)),
        economicSavings: Number(slotSavings.toFixed(2)),
      });
    }

    // High-Level Aggregated KPI Computations
    const meanDemandDeviation =
      deviationCount > 0
        ? Number((totalDemandDeviation / deviationCount).toFixed(2))
        : 0;
    const noShowFrequencyPercent =
      totalYesVotes > 0
        ? Number(((totalNoShows / totalYesVotes) * 100).toFixed(2))
        : 0;
    const forecastMapePercent =
      mapeCount > 0
        ? Number((totalAbsolutePercentError / mapeCount).toFixed(2))
        : 0;

    // Empirical Waste Reduction % = (Baseline - Actual) / Baseline * 100
    const empiricalWasteReductionPercent =
      totalBaselineWasteKg > 0
        ? Number(
            (
              ((totalBaselineWasteKg - totalActualWasteKg) /
                totalBaselineWasteKg) *
              100
            ).toFixed(2),
          )
        : 0;

    const totalAvoidedWasteKg = Number(
      Math.max(0, totalBaselineWasteKg - totalActualWasteKg).toFixed(2),
    );
    const roundedEconomicSavings = Number(totalEconomicSavings.toFixed(2));

    return {
      summary: {
        totalMealCycles: slots.length,
        totalMealsServed,
        kpiMetrics: {
          meanDemandDeviation: {
            value: meanDemandDeviation,
            unit: "students/meal",
            formula: "|A_expected - A_actual|",
          },
          noShowFrequency: {
            value: noShowFrequencyPercent,
            unit: "%",
            formula: "(Total NoShows / YES Votes) * 100",
          },
          forecastErrorMape: {
            value: forecastMapePercent,
            unit: "%",
            formula:
              "MAPE = (1/n) * sum(|A_actual - A_predicted| / A_actual) * 100",
          },
          empiricalWasteReduction: {
            value: empiricalWasteReductionPercent,
            unit: "%",
            formula: "((W_baseline - W_actual) / W_baseline) * 100",
          },
          totalAvoidedWaste: {
            value: totalAvoidedWasteKg,
            unit: "kg",
            formula: "sum(W_baseline - W_actual)",
          },
          economicCostSavings: {
            value: roundedEconomicSavings,
            unit: "USD ($)",
            formula: "Avoided Waste (kg) * Unit Meal Cost ($/kg)",
          },
        },
      },
      timeSeries,
    };
  },
};
