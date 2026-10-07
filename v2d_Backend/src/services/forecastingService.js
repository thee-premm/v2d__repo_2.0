import { query } from '../config/db.js';
import { logger } from '../utils/logger.js';

export const forecastingService = {
  /**
   * 1. Data Retrieval Engine
   * Retrieves chronological historical attendance data for a mess & meal type
   */
  async getHistoricalAttendanceData({ messId, mealTypeId, isExamPeriod, limit = 60, beforeDate = null }) {
    let sql = `
      SELECT 
        ms.id AS meal_slot_id,
        ms.slot_date,
        ms.is_exam_period,
        EXTRACT(DOW FROM ms.slot_date)::INT AS day_of_week,
        mt.name AS meal_type_name,
        COALESCE(att.actual_attendance, 0)::INT AS actual_attendance,
        COALESCE(mda.expected_attendance, 0)::INT AS expected_attendance,
        COALESCE(mda.total_enrolled, 0)::INT AS total_enrolled
      FROM meal_slots ms
      JOIN meal_types mt ON ms.meal_type_id = mt.id
      LEFT JOIN (
        SELECT meal_slot_id, COUNT(*)::INT AS actual_attendance
        FROM attendance_records
        WHERE verification_status IN ('PRESENT', 'EXCUSED_OVERRIDE', 'UNVOTED_WALK_IN')
        GROUP BY meal_slot_id
      ) att ON ms.id = att.meal_slot_id
      LEFT JOIN meal_demand_aggregates mda ON ms.id = mda.meal_slot_id
      WHERE ms.mess_id = $1 
        AND ms.meal_type_id = $2
    `;

    const params = [messId, mealTypeId];

    if (isExamPeriod !== undefined && isExamPeriod !== null) {
      params.push(isExamPeriod);
      sql += ` AND ms.is_exam_period = $${params.length}`;
    }

    if (beforeDate) {
      params.push(beforeDate);
      sql += ` AND ms.slot_date < $${params.length}`;
    }

    sql += ` ORDER BY ms.slot_date ASC, ms.id ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query(sql, params);
    return res.rows;
  },

  /**
   * 2. Recursive Moving Average Formulation
   * Computes rolling prediction for given window k over series
   */
  computeMovingAverage(series, k) {
    if (!series || series.length === 0) return 0;
    const effectiveK = Math.min(k, series.length);
    const windowSlice = series.slice(-effectiveK);
    const sum = windowSlice.reduce((acc, val) => acc + val, 0);
    return Number((sum / effectiveK).toFixed(2));
  },

  /**
   * 3. Walk-Forward Validation Engine
   * Tests dynamic windows k in [3, 5, 7, 10] using rolling-origin MAE
   */
  evaluateWalkForwardValidation(series, candidateWindows = [3, 5, 7, 10]) {
    const n = series.length;
    const evaluations = [];

    // Fallback if series is extremely short (cold start)
    if (n < 3) {
      const fallbackVal = n > 0 ? Number((series.reduce((a, b) => a + b, 0) / n).toFixed(2)) : 0;
      return {
        optimalWindowK: 3,
        minMAE: 0,
        evaluations: candidateWindows.map((k) => ({
          k,
          mae: 0,
          sampleCount: 0,
          predictedNext: fallbackVal,
          status: 'INSUFFICIENT_DATA_COLD_START',
        })),
        isColdStart: true,
      };
    }

    let optimalK = candidateWindows[0];
    let minMAE = Infinity;

    for (const k of candidateWindows) {
      // Walk-forward validation requires at least k + 1 observations
      if (n <= k) {
        const partialPred = this.computeMovingAverage(series, k);
        evaluations.push({
          k,
          mae: null,
          sampleCount: 0,
          predictedNext: partialPred,
          status: 'SKIPPED_WINDOW_EXCEEDS_SERIES_LENGTH',
        });
        continue;
      }

      let totalAbsoluteError = 0;
      let samplesEvaluated = 0;

      // Rolling-origin walk-forward validation:
      // For each time step t from k to n - 1:
      //   Forecast A_hat_t using historical window [t-k ... t-1]
      //   Evaluate error |A_t - A_hat_t|
      for (let t = k; t < n; t++) {
        const historyWindow = series.slice(t - k, t);
        const prediction = historyWindow.reduce((acc, v) => acc + v, 0) / k;
        const actual = series[t];
        totalAbsoluteError += Math.abs(actual - prediction);
        samplesEvaluated++;
      }

      const mae = samplesEvaluated > 0 ? Number((totalAbsoluteError / samplesEvaluated).toFixed(2)) : 0;
      const predictedNext = this.computeMovingAverage(series, k);

      evaluations.push({
        k,
        mae,
        sampleCount: samplesEvaluated,
        predictedNext,
        status: 'EVALUATED',
      });

      if (mae < minMAE) {
        minMAE = mae;
        optimalK = k;
      }
    }

    // Default to best evaluated window if all were skipped
    if (minMAE === Infinity && evaluations.length > 0) {
      optimalK = candidateWindows[0];
      minMAE = 0;
    }

    return {
      optimalWindowK: optimalK,
      minMAE,
      evaluations,
      isColdStart: false,
    };
  },

  /**
   * 4. Complete Forecast & Kitchen Decision Layer Engine
   */
  async generateForecastForSlot({ mealSlotId, perCapitaRequirementKg = 0.35, safetyMarginFactor = 0.05 }) {
    const r = parseFloat(perCapitaRequirementKg) || 0.35;
    const s = parseFloat(safetyMarginFactor) || 0.05;

    // A. Fetch target meal slot
    const slotRes = await query(
      `SELECT ms.*, mt.name AS meal_type_name, m.name AS mess_name, m.capacity AS mess_capacity 
       FROM meal_slots ms
       JOIN meal_types mt ON ms.meal_type_id = mt.id
       JOIN messes m ON ms.mess_id = m.id
       WHERE ms.id = $1`,
      [mealSlotId]
    );

    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot #${mealSlotId} not found` };
    }
    const targetSlot = slotRes.rows[0];

    // B. Fetch total enrolled students
    const enrolledRes = await query(
      `SELECT COUNT(*)::INT AS total FROM students WHERE mess_id = $1 AND enrolled = TRUE`,
      [targetSlot.mess_id]
    );
    const totalEnrolled = enrolledRes.rows[0]?.total || 10;

    // C. Fetch historical series
    const historicalData = await this.getHistoricalAttendanceData({
      messId: targetSlot.mess_id,
      mealTypeId: targetSlot.meal_type_id,
      isExamPeriod: targetSlot.is_exam_period,
      beforeDate: targetSlot.slot_date,
      limit: 60,
    });

    const series = historicalData.map((d) => d.actual_attendance).filter((val) => val > 0);

    // D. Perform Walk-Forward Validation
    const validationResult = this.evaluateWalkForwardValidation(series, [3, 5, 7, 10]);
    const optimalK = validationResult.optimalWindowK;

    // E. Calculate Predicted Attendance (A_hat)
    let predictedAttendance;
    if (series.length >= 3) {
      predictedAttendance = this.computeMovingAverage(series, optimalK);
    } else {
      // Cold-start fallback: estimate 75% of enrolled students
      predictedAttendance = Number((totalEnrolled * 0.75).toFixed(2));
      logger.info(`[ForecastingEngine] Cold start triggered for slot #${mealSlotId}. Using enrolled baseline fallback: ${predictedAttendance}`);
    }

    // F. Kitchen Decision Layer Equations:
    // Raw food quantity: Q_base = A_hat * r
    // Total recommended cooking quantity: Q = A_hat * r * (1 + s)
    // Safety buffer mass: Q_buffer = Q - Q_base
    const rawFoodKg = Number((predictedAttendance * r).toFixed(2));
    const recommendedFoodKg = Number((predictedAttendance * r * (1 + s)).toFixed(2));
    const bufferFoodKg = Number((recommendedFoodKg - rawFoodKg).toFixed(2));

    // G. Persist Forecast Log
    await query(
      `INSERT INTO ai_forecast_logs 
        (meal_slot_id, model_version, window_k, predicted_attendance, recommended_food_kg, safety_buffer_percent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (meal_slot_id)
       DO UPDATE SET
         model_version = EXCLUDED.model_version,
         window_k = EXCLUDED.window_k,
         predicted_attendance = EXCLUDED.predicted_attendance,
         recommended_food_kg = EXCLUDED.recommended_food_kg,
         safety_buffer_percent = EXCLUDED.safety_buffer_percent,
         created_at = CURRENT_TIMESTAMP;`,
      [
        mealSlotId,
        'RMA-WKV-v1.2',
        optimalK,
        predictedAttendance,
        recommendedFoodKg,
        s * 100,
      ]
    );

    return {
      mealSlot: {
        id: targetSlot.id,
        date: targetSlot.slot_date,
        mealType: targetSlot.meal_type_name,
        messName: targetSlot.mess_name,
        isExamPeriod: targetSlot.is_exam_period,
        totalEnrolled,
      },
      forecasting: {
        modelVersion: 'Recursive Moving Average (RMA-WKV-v1.2)',
        optimalWindowK: optimalK,
        minMAE: validationResult.minMAE,
        historicalObservationsCount: series.length,
        predictedAttendanceHeadcount: predictedAttendance,
        walkForwardEvaluationMatrix: validationResult.evaluations,
      },
      kitchenDecisionRecommendations: {
        perCapitaRequirementKg: r,
        safetyMarginPercent: s * 100,
        baseFoodDemandKg: rawFoodKg,
        safetyBufferFoodKg: bufferFoodKg,
        totalRecommendedCookingKg: recommendedFoodKg,
        formula: 'Q = A_hat * r * (1 + s)',
      }
    };
  }
};
