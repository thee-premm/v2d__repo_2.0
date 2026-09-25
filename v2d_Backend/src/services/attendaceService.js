import { query } from "../config/db.js";
import { notificationService } from "./notificationService.js";

export const attendanceService = {
  async verifyAttendance({
    rollNumber,
    studentId,
    mealSlotId,
    verificationMethod = "ROLL_NUMBER",
    supervisorNotes = "",
    verifiedByUserId,
  }) {
    // 1. Resolve student ID
    let student = null;
    if (rollNumber) {
      const studentRes = await query(
        `SELECT * FROM students WHERE roll_number = $1`,
        [rollNumber],
      );
      if (studentRes.rows.length === 0) {
        throw {
          statusCode: 404,
          message: `Student with roll number ${rollNumber} not found`,
        };
      }
      student = studentRes.rows[0];
    } else if (studentId) {
      const studentRes = await query(`SELECT * FROM students WHERE id = $1`, [
        studentId,
      ]);
      if (studentRes.rows.length === 0) {
        throw {
          statusCode: 404,
          message: `Student with ID ${studentId} not found`,
        };
      }
      student = studentRes.rows[0];
    } else {
      throw {
        statusCode: 400,
        message: "Either rollNumber or studentId must be provided",
      };
    }

    // 2. Fetch meal slot
    const slotRes = await query(`SELECT * FROM meal_slots WHERE id = $1`, [
      mealSlotId,
    ]);
    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot ${mealSlotId} not found` };
    }

    // 3. Counter Verification Gate 3-Way Logic Evaluation
    const voteRes = await query(
      `SELECT * FROM votes WHERE student_id = $1 AND meal_slot_id = $2`,
      [student.id, mealSlotId],
    );

    let verificationStatus;
    if (voteRes.rows.length > 0) {
      const voteStatus = voteRes.rows[0].vote_status;
      if (voteStatus === true) {
        verificationStatus = "PRESENT";
      } else {
        verificationStatus = "EXCUSED_OVERRIDE"; // Authorized Walk-In (Voted NO + Attended)
      }
    } else {
      verificationStatus = "UNVOTED_WALK_IN"; // Mess Policy Walk-In (No Response + Attended)
    }

    // 4. Record attendance atomically in database
    const insertSql = `
      INSERT INTO attendance_records 
        (student_id, meal_slot_id, verification_status, verification_method, supervisor_notes, verified_by, verified_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (student_id, meal_slot_id)
      DO UPDATE SET
        verification_status = EXCLUDED.verification_status,
        verification_method = EXCLUDED.verification_method,
        supervisor_notes = EXCLUDED.supervisor_notes,
        verified_by = EXCLUDED.verified_by,
        verified_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const attRes = await query(insertSql, [
      student.id,
      mealSlotId,
      verificationStatus,
      verificationMethod,
      supervisorNotes || null,
      verifiedByUserId || null,
    ]);

    // 5. Trigger Post-Meal Confirmation Push Notification (Module 3)
    notificationService
      .triggerPostMealConfirmation(student.id, mealSlotId, verificationStatus)
      .catch(() => {});

    return {
      student: {
        id: student.id,
        name: student.name,
        roll_number: student.roll_number,
        room_number: student.room_number,
      },
      attendance: attRes.rows[0],
      classification: verificationStatus,
    };
  },

  async getAttendanceRecordsForSlot(mealSlotId) {
    const sql = `
      SELECT 
        ar.*,
        s.name AS student_name,
        s.roll_number,
        s.room_number,
        u.username AS verified_by_username
      FROM attendance_records ar
      JOIN students s ON ar.student_id = s.id
      LEFT JOIN users u ON ar.verified_by = u.id
      WHERE ar.meal_slot_id = $1
      ORDER BY ar.verified_at DESC;
    `;
    const res = await query(sql, [mealSlotId]);
    return res.rows;
  },
};
