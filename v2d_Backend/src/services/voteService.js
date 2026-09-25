import { query, withTransaction } from "../config/db.js";
import { redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";

export const voteService = {
  async castVote({
    studentId,
    mealSlotId,
    voteStatus,
    voteChannel = "WEB_APP",
  }) {
    // 1. Fetch meal slot information
    const slotRes = await query(`SELECT * FROM meal_slots WHERE id = $1`, [
      mealSlotId,
    ]);
    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot ${mealSlotId} not found` };
    }

    const slot = slotRes.rows[0];
    const now = new Date();
    const openTime = new Date(slot.open_time);
    const cutoffTime = new Date(slot.cutoff_time);

    // 2. Validate Cutoff Locking Mechanics
    if (slot.is_locked || now < openTime || now >= cutoffTime) {
      throw {
        statusCode: 403,
        message: "403 Forbidden: Voting window is locked",
      };
    }

    // 3. High-Concurrency Redis Write-Through Buffer
    try {
      const redisKey = `vote:${mealSlotId}:${studentId}`;
      const statusVal = voteStatus ? "1" : "0";
      await redis.set(redisKey, statusVal, "EX", 86400); // 24h TTL
      logger.debug(
        `Redis write-through successful for ${redisKey} => ${statusVal}`,
      );
    } catch (err) {
      logger.warn(`Redis buffer write non-fatal warning: ${err.message}`);
    }

    // 4. Atomic PostgreSQL Upsert
    const upsertSql = `
      INSERT INTO votes (student_id, meal_slot_id, vote_status, vote_channel, created_at, modified_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (student_id, meal_slot_id)
      DO UPDATE SET 
        vote_status = EXCLUDED.vote_status,
        vote_channel = EXCLUDED.vote_channel,
        modified_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const voteRes = await query(upsertSql, [
      studentId,
      mealSlotId,
      voteStatus,
      voteChannel,
    ]);

    return voteRes.rows[0];
  },

  async cutoffAndAggregateSlot(mealSlotId) {
    return await withTransaction(async (client) => {
      // 1. Lock the meal slot
      const lockRes = await client.query(
        `UPDATE meal_slots SET is_locked = TRUE WHERE id = $1 RETURNING *`,
        [mealSlotId],
      );
      if (lockRes.rows.length === 0) {
        throw { statusCode: 404, message: `Meal slot ${mealSlotId} not found` };
      }
      const slot = lockRes.rows[0];

      // 2. Fetch Total Enrolled Students for this Mess
      const enrolledRes = await client.query(
        `SELECT COUNT(*)::INT AS total FROM students WHERE mess_id = $1 AND enrolled = TRUE`,
        [slot.mess_id],
      );
      const totalEnrolled = enrolledRes.rows[0].total || 0;

      // 3. Aggregate Vote Counts
      const countsRes = await client.query(
        `SELECT 
           COUNT(*) FILTER (WHERE vote_status = TRUE)::INT AS yes_votes,
           COUNT(*) FILTER (WHERE vote_status = FALSE)::INT AS no_votes
         FROM votes
         WHERE meal_slot_id = $1`,
        [mealSlotId],
      );

      const yesVotes = countsRes.rows[0].yes_votes || 0;
      const noVotes = countsRes.rows[0].no_votes || 0;
      const noResponseCount = Math.max(0, totalEnrolled - (yesVotes + noVotes));
      const expectedAttendance = yesVotes;

      // 4. Upsert counts into meal_demand_aggregates
      const aggregateSql = `
        INSERT INTO meal_demand_aggregates 
          (meal_slot_id, total_enrolled, yes_votes, no_votes, no_response_count, expected_attendance, aggregated_at)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (meal_slot_id)
        DO UPDATE SET
          total_enrolled = EXCLUDED.total_enrolled,
          yes_votes = EXCLUDED.yes_votes,
          no_votes = EXCLUDED.no_votes,
          no_response_count = EXCLUDED.no_response_count,
          expected_attendance = EXCLUDED.expected_attendance,
          aggregated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;

      const aggRes = await client.query(aggregateSql, [
        mealSlotId,
        totalEnrolled,
        yesVotes,
        noVotes,
        noResponseCount,
        expectedAttendance,
      ]);

      return {
        slot: lockRes.rows[0],
        aggregate: aggRes.rows[0],
      };
    });
  },

  async getAggregateForSlot(mealSlotId) {
    const res = await query(
      `SELECT * FROM meal_demand_aggregates WHERE meal_slot_id = $1`,
      [mealSlotId],
    );
    return res.rows[0] || null;
  },
};
