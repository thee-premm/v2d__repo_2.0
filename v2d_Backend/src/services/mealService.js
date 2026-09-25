import { query } from "../config/db.js";

export const mealService = {
  async createMealSlot({
    messId,
    mealTypeId,
    slotDate,
    openTime,
    cutoffTime,
    mealStartTime,
    mealEndTime,
  }) {
    const open = new Date(openTime);
    const cutoff = new Date(cutoffTime);
    const start = new Date(mealStartTime);
    const end = new Date(mealEndTime);

    // Dynamic Time Window Validation Rules
    if (!(open < cutoff && cutoff < start && start < end)) {
      throw {
        statusCode: 400,
        message:
          "Invalid timing constraints: Must satisfy open_time < cutoff_time < meal_start_time < meal_end_time",
      };
    }

    const res = await query(
      `INSERT INTO meal_slots (mess_id, meal_type_id, slot_date, open_time, cutoff_time, meal_start_time, meal_end_time, is_locked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
       ON CONFLICT (mess_id, slot_date, meal_type_id)
       DO UPDATE SET
         open_time = EXCLUDED.open_time,
         cutoff_time = EXCLUDED.cutoff_time,
         meal_start_time = EXCLUDED.meal_start_time,
         meal_end_time = EXCLUDED.meal_end_time,
         is_locked = FALSE
       RETURNING *`,
      [
        messId,
        mealTypeId,
        slotDate,
        open.toISOString(),
        cutoff.toISOString(),
        start.toISOString(),
        end.toISOString(),
      ],
    );

    return res.rows[0];
  },

  async getTodayMealSlots(messId, studentId = null) {
    const today = new Date().toISOString().split("T")[0];

    const sql = `
      SELECT 
        ms.id AS slot_id,
        ms.mess_id,
        mt.name AS meal_type,
        ms.slot_date,
        ms.open_time,
        ms.cutoff_time,
        ms.meal_start_time,
        ms.meal_end_time,
        ms.is_locked,
        EXTRACT(EPOCH FROM (ms.cutoff_time - CURRENT_TIMESTAMP))::INT AS seconds_to_cutoff,
        v.vote_status AS current_student_vote
      FROM meal_slots ms
      JOIN meal_types mt ON ms.meal_type_id = mt.id
      LEFT JOIN votes v ON (v.meal_slot_id = ms.id AND v.student_id = $2)
      WHERE ms.mess_id = $1 AND ms.slot_date = $3
      ORDER BY ms.meal_start_time ASC;
    `;

    const res = await query(sql, [messId, studentId, today]);

    return res.rows.map((row) => ({
      ...row,
      seconds_to_cutoff: Math.max(0, row.seconds_to_cutoff || 0),
      is_open_for_voting:
        !row.is_locked &&
        new Date() >= new Date(row.open_time) &&
        new Date() < new Date(row.cutoff_time),
    }));
  },

  async getMealSlotById(slotId) {
    const res = await query(
      `SELECT ms.*, mt.name AS meal_type_name
       FROM meal_slots ms
       JOIN meal_types mt ON ms.meal_type_id = mt.id
       WHERE ms.id = $1`,
      [slotId],
    );

    if (res.rows.length === 0) {
      throw {
        statusCode: 404,
        message: `Meal slot with ID ${slotId} not found`,
      };
    }

    return res.rows[0];
  },

  async getMenuForMessAndDate(messId, date) {
    const res = await query(
      `SELECT dm.*, mt.name AS meal_type_name
       FROM daily_menus dm
       JOIN meal_types mt ON dm.meal_type_id = mt.id
       WHERE dm.mess_id = $1 AND dm.date = $2`,
      [messId, date],
    );
    return res.rows;
  },
};
