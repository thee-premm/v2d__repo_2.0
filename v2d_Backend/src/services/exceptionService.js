import { query, withTransaction } from '../config/db.js';

export const exceptionService = {
  async reconcileNoShows(mealSlotId) {
    return await withTransaction(async (client) => {
      // 1. Fetch meal slot
      const slotRes = await client.query(`SELECT * FROM meal_slots WHERE id = $1`, [mealSlotId]);
      if (slotRes.rows.length === 0) {
        throw { statusCode: 404, message: `Meal slot ${mealSlotId} not found` };
      }
      const slot = slotRes.rows[0];

      // 2. Identify students who voted YES but have NO attendance record
      const noShowQuery = `
        SELECT s.id AS student_id, s.name, s.roll_number, s.consecutive_no_shows
        FROM votes v
        JOIN students s ON v.student_id = s.id
        WHERE v.meal_slot_id = $1 
          AND v.vote_status = TRUE
          AND s.mess_id = $2
          AND s.id NOT IN (
            SELECT student_id 
            FROM attendance_records 
            WHERE meal_slot_id = $1
          );
      `;

      const noShowsRes = await client.query(noShowQuery, [mealSlotId, slot.mess_id]);
      const absentStudents = noShowsRes.rows;

      const results = [];

      for (const student of absentStudents) {
        // A. Insert ABSENT attendance record
        await client.query(
          `INSERT INTO attendance_records (student_id, meal_slot_id, verification_status, verification_method, supervisor_notes, verified_at)
           VALUES ($1, $2, 'ABSENT', 'MANUAL_SUPERVISOR', 'Automated No-Show Reconciler Execution', CURRENT_TIMESTAMP)
           ON CONFLICT (student_id, meal_slot_id) DO NOTHING;`,
          [student.student_id, mealSlotId]
        );

        // B. Update student penalty counter
        const updatedStudentRes = await client.query(
          `UPDATE students
           SET consecutive_no_shows = consecutive_no_shows + 1,
               total_penalties = total_penalties + 1
           WHERE id = $1
           RETURNING consecutive_no_shows, total_penalties;`,
          [student.student_id]
        );

        const currentNoShows = updatedStudentRes.rows[0].consecutive_no_shows;
        let warningTier = 1;
        if (currentNoShows >= 3) warningTier = 3;
        else if (currentNoShows === 2) warningTier = 2;

        // C. Issue Warning / Penalty in penalties_and_appeals
        const penaltyRes = await client.query(
          `INSERT INTO penalties_and_appeals (student_id, meal_slot_id, violation_type, warning_tier, status, created_at)
           VALUES ($1, $2, 'NO_SHOW', $3, 'ISSUED', CURRENT_TIMESTAMP)
           RETURNING *;`,
          [student.student_id, mealSlotId, warningTier]
        );

        results.push({
          student_id: student.student_id,
          name: student.name,
          roll_number: student.roll_number,
          verification_status: 'ABSENT',
          warning_tier: warningTier,
          penalty: penaltyRes.rows[0],
        });
      }

      return {
        meal_slot_id: mealSlotId,
        reconciled_count: results.length,
        absent_records: results,
      };
    });
  },

  async submitAppeal({ studentId, mealSlotId, violationType = 'NO_SHOW', appealReason }) {
    if (!appealReason || appealReason.trim().length === 0) {
      throw { statusCode: 400, message: 'Appeal reason is required' };
    }

    // Check if penalty exists
    const checkRes = await query(
      `SELECT * FROM penalties_and_appeals WHERE student_id = $1 AND meal_slot_id = $2`,
      [studentId, mealSlotId]
    );

    if (checkRes.rows.length === 0) {
      // Create new penalty record with APPEALED status
      const res = await query(
        `INSERT INTO penalties_and_appeals (student_id, meal_slot_id, violation_type, warning_tier, status, appeal_reason, created_at)
         VALUES ($1, $2, $3, 1, 'APPEALED', $4, CURRENT_TIMESTAMP)
         RETURNING *`,
        [studentId, mealSlotId, violationType, appealReason]
      );
      return res.rows[0];
    } else {
      const penalty = checkRes.rows[0];
      const res = await query(
        `UPDATE penalties_and_appeals
         SET status = 'APPEALED', appeal_reason = $1
         WHERE id = $2
         RETURNING *`,
        [appealReason, penalty.id]
      );
      return res.rows[0];
    }
  },

  async resolveAppeal({ penaltyId, status, resolutionNotes, supervisorUserId }) {
    if (!['WAIVED', 'UPHELD'].includes(status)) {
      throw { statusCode: 400, message: 'Status must be either WAIVED or UPHELD' };
    }

    return await withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE penalties_and_appeals
         SET status = $1, resolution_notes = $2, appeal_resolved_by = $3
         WHERE id = $4
         RETURNING *`,
        [status, resolutionNotes || null, supervisorUserId, penaltyId]
      );

      if (res.rows.length === 0) {
        throw { statusCode: 404, message: `Penalty/Appeal record ${penaltyId} not found` };
      }

      const penalty = res.rows[0];

      if (status === 'WAIVED') {
        // Reset or decrement consecutive no show counter for student
        await client.query(
          `UPDATE students
           SET consecutive_no_shows = GREATEST(0, consecutive_no_shows - 1)
           WHERE id = $1`,
          [penalty.student_id]
        );
      }

      return penalty;
    });
  },

  async getStudentPenalties(studentId) {
    const res = await query(
      `SELECT pa.*, ms.slot_date, mt.name AS meal_type_name
       FROM penalties_and_appeals pa
       JOIN meal_slots ms ON pa.meal_slot_id = ms.id
       JOIN meal_types mt ON ms.meal_type_id = mt.id
       WHERE pa.student_id = $1
       ORDER BY pa.created_at DESC`,
      [studentId]
    );
    return res.rows;
  }
};
