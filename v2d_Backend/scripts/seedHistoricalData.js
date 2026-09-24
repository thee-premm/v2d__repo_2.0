
import pkg from 'pg';
const { Pool } = pkg;
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const pool = new Pool({
  host: env.DB.host,
  port: env.DB.port,
  database: env.DB.database,
  user: env.DB.user,
  password: env.DB.password,
});

async function seedHistoricalData() {
  const client = await pool.connect();
  try {
    logger.info('===============================================================');
    logger.info('  Starting 30-Day Synthetic Mess Historical Data Seeding Engine');
    logger.info('===============================================================');

    await client.query('BEGIN');

    // 1. Fetch default mess and students
    const messRes = await client.query(`
      SELECT m.id, COUNT(s.id) as student_count 
      FROM messes m 
      LEFT JOIN students s ON s.mess_id = m.id 
      GROUP BY m.id 
      ORDER BY student_count DESC, m.id ASC 
      LIMIT 1;
    `);
    if (messRes.rows.length === 0) {
      throw new Error('No mess found. Please run "npm run seed" first.');
    }
    const messId = messRes.rows[0].id;

    // Ensure all students belong to this active mess
    await client.query(`UPDATE students SET mess_id = $1 WHERE mess_id IS NULL OR mess_id != $1`, [messId]);

    const studentsRes = await client.query(
      `SELECT s.id, s.user_id, s.roll_number, s.name FROM students s WHERE s.mess_id = $1 AND s.enrolled = TRUE ORDER BY s.id ASC;`,
      [messId]
    );
    const students = studentsRes.rows;
    if (students.length === 0) {
      throw new Error('No students found. Please run "npm run seed" first.');
    }
    const totalEnrolled = students.length;

    // Fetch meal types
    const mealTypesRes = await client.query(`SELECT id, name FROM meal_types ORDER BY id ASC;`);
    const mealTypes = mealTypesRes.rows; // 1: BREAKFAST, 2: LUNCH, 3: SNACKS, 4: DINNER

    const supervisorUserRes = await client.query(`SELECT id FROM users WHERE role = 'SUPERVISOR' LIMIT 1;`);
    const supervisorUserId = supervisorUserRes.rows[0]?.id || null;

    logger.info(`Seeding 30 days of data for Mess #${messId} with ${totalEnrolled} enrolled students...`);

    const now = new Date();
    let totalSlotsCreated = 0;
    let totalVotesCreated = 0;
    let totalAttendanceCreated = 0;
    let totalWasteLogsCreated = 0;

    // Iterate through past 30 days (from day 30 ago up to yesterday)
    for (let dayOffset = 30; dayOffset >= 1; dayOffset--) {
      const slotDateObj = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      const slotDateStr = slotDateObj.toISOString().split('T')[0];
      const dayOfWeek = slotDateObj.getDay(); // 0 = Sunday, 6 = Saturday
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      // Days 20 to 25 in the past were Mid-Term Exam Week
      const isExamPeriod = dayOffset >= 6 && dayOffset <= 11;

      // Seed Breakfast, Lunch, and Dinner for each day
      const targetMealTypes = mealTypes.filter(mt => ['BREAKFAST', 'LUNCH', 'DINNER'].includes(mt.name));

      for (const mt of targetMealTypes) {
        // Base attendance probability model:
        let targetYesRatio = 0.8; // default 80%
        if (isWeekend) {
          if (mt.name === 'BREAKFAST') targetYesRatio = 0.45; // lower weekend breakfast
          else if (mt.name === 'LUNCH') targetYesRatio = 0.65;
          else targetYesRatio = 0.75;
        } else if (isExamPeriod) {
          if (mt.name === 'BREAKFAST') targetYesRatio = 0.55;
          else if (mt.name === 'LUNCH') targetYesRatio = 0.60;
          else targetYesRatio = 0.85; // late night dinner high
        } else {
          // Regular weekday
          if (mt.name === 'BREAKFAST') targetYesRatio = 0.80;
          else if (mt.name === 'LUNCH') targetYesRatio = 0.85;
          else targetYesRatio = 0.90;
        }

        // Generate timestamps
        const openTime = new Date(slotDateObj);
        openTime.setHours(6, 0, 0, 0);
        const cutoffTime = new Date(slotDateObj);
        cutoffTime.setHours(9, 0, 0, 0);
        const mealStartTime = new Date(slotDateObj);
        mealStartTime.setHours(12, 0, 0, 0);
        const mealEndTime = new Date(slotDateObj);
        mealEndTime.setHours(14, 0, 0, 0);

        // 1. Insert Meal Slot
        const slotInsertSql = `
          INSERT INTO meal_slots (mess_id, meal_type_id, slot_date, open_time, cutoff_time, meal_start_time, meal_end_time, is_locked, is_exam_period)
          VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
          ON CONFLICT (mess_id, slot_date, meal_type_id)
          DO UPDATE SET is_locked = TRUE, is_exam_period = EXCLUDED.is_exam_period
          RETURNING id;
        `;

        const slotRes = await client.query(slotInsertSql, [
          messId,
          mt.id,
          slotDateStr,
          openTime.toISOString(),
          cutoffTime.toISOString(),
          mealStartTime.toISOString(),
          mealEndTime.toISOString(),
          isExamPeriod,
        ]);
        const slotId = slotRes.rows[0].id;
        totalSlotsCreated++;

        // 2. Generate Student Votes
        let yesVotes = 0;
        let noVotes = 0;
        let noResponseCount = 0;

        const votedStudents = [];

        for (let i = 0; i < students.length; i++) {
          const student = students[i];
          // Determine vote deterministically with variation
          const rand = ((dayOffset * 17 + mt.id * 31 + i * 13) % 100) / 100;
          
          if (rand < targetYesRatio) {
            // Voted YES
            await client.query(
              `INSERT INTO votes (student_id, meal_slot_id, vote_status, vote_channel, created_at)
               VALUES ($1, $2, TRUE, 'WEB_APP', $3)
               ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET vote_status = TRUE;`,
              [student.id, slotId, openTime.toISOString()]
            );
            yesVotes++;
            votedStudents.push({ student, vote: true });
          } else if (rand < 0.92) {
            // Voted NO
            await client.query(
              `INSERT INTO votes (student_id, meal_slot_id, vote_status, vote_channel, created_at)
               VALUES ($1, $2, FALSE, 'WEB_APP', $3)
               ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET vote_status = FALSE;`,
              [student.id, slotId, openTime.toISOString()]
            );
            noVotes++;
            votedStudents.push({ student, vote: false });
          } else {
            // No Response / Abstain
            noResponseCount++;
            votedStudents.push({ student, vote: null });
          }
          totalVotesCreated++;
        }

        const expectedAttendance = yesVotes;

        // 3. Upsert Aggregates
        await client.query(
          `INSERT INTO meal_demand_aggregates (meal_slot_id, total_enrolled, yes_votes, no_votes, no_response_count, expected_attendance, aggregated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (meal_slot_id) DO UPDATE SET
             total_enrolled = EXCLUDED.total_enrolled,
             yes_votes = EXCLUDED.yes_votes,
             no_votes = EXCLUDED.no_votes,
             no_response_count = EXCLUDED.no_response_count,
             expected_attendance = EXCLUDED.expected_attendance;`,
          [slotId, totalEnrolled, yesVotes, noVotes, noResponseCount, expectedAttendance, cutoffTime.toISOString()]
        );

        // 4. Generate Realistic Physical Attendance Records
        let actualPresent = 0;
        let actualExcusedWalkIn = 0;
        let actualUnvotedWalkIn = 0;
        let actualAbsent = 0;

        for (const item of votedStudents) {
          const { student, vote } = item;
          const scanTime = new Date(mealStartTime.getTime() + (student.id * 70000));

          if (vote === true) {
            // 90% of YES voters show up -> PRESENT
            const showsUp = ((dayOffset * 7 + student.id * 11) % 10) !== 0;
            if (showsUp) {
              await client.query(
                `INSERT INTO attendance_records (student_id, meal_slot_id, verification_status, verification_method, verified_by, verified_at)
                 VALUES ($1, $2, 'PRESENT', 'ROLL_NUMBER', $3, $4)
                 ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET verification_status = 'PRESENT';`,
                [student.id, slotId, supervisorUserId, scanTime.toISOString()]
              );
              actualPresent++;
            } else {
              // 10% No-Show -> ABSENT
              await client.query(
                `INSERT INTO attendance_records (student_id, meal_slot_id, verification_status, verification_method, verified_by, verified_at)
                 VALUES ($1, $2, 'ABSENT', 'MANUAL_SUPERVISOR', $3, $4)
                 ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET verification_status = 'ABSENT';`,
                [student.id, slotId, supervisorUserId, mealEndTime.toISOString()]
              );
              actualAbsent++;
            }
          } else if (vote === false) {
            // 15% of NO voters walk in as override
            const walkIn = ((dayOffset * 5 + student.id * 13) % 7) === 0;
            if (walkIn) {
              await client.query(
                `INSERT INTO attendance_records (student_id, meal_slot_id, verification_status, verification_method, verified_by, verified_at)
                 VALUES ($1, $2, 'EXCUSED_OVERRIDE', 'ROLL_NUMBER', $3, $4)
                 ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET verification_status = 'EXCUSED_OVERRIDE';`,
                [student.id, slotId, supervisorUserId, scanTime.toISOString()]
              );
              actualExcusedWalkIn++;
            }
          } else {
            // 20% of unvoted students walk in
            const unvotedWalkIn = ((dayOffset * 3 + student.id * 17) % 5) === 0;
            if (unvotedWalkIn) {
              await client.query(
                `INSERT INTO attendance_records (student_id, meal_slot_id, verification_status, verification_method, verified_by, verified_at)
                 VALUES ($1, $2, 'UNVOTED_WALK_IN', 'ROLL_NUMBER', $3, $4)
                 ON CONFLICT (student_id, meal_slot_id) DO UPDATE SET verification_status = 'UNVOTED_WALK_IN';`,
                [student.id, slotId, supervisorUserId, scanTime.toISOString()]
              );
              actualUnvotedWalkIn++;
            }
          }
          totalAttendanceCreated++;
        }

        const actualHeadcount = actualPresent + actualExcusedWalkIn + actualUnvotedWalkIn;

        // 5. Generate AI Forecast Log (Historical baseline estimation)
        const predictedHeadcount = Math.max(1, Math.round(expectedAttendance * 0.95 + (Math.random() * 0.4 - 0.2)));
        const r = 0.35; // kg/student
        const s = 0.05; // 5% safety buffer
        const recommendedFoodKg = Number((predictedHeadcount * r * (1 + s)).toFixed(2));

        await client.query(
          `INSERT INTO ai_forecast_logs (meal_slot_id, model_version, window_k, predicted_attendance, recommended_food_kg, safety_buffer_percent, created_at)
           VALUES ($1, 'RMA-WKV-v1.2', 5, $2, $3, 5.0, $4)
           ON CONFLICT (meal_slot_id) DO UPDATE SET predicted_attendance = EXCLUDED.predicted_attendance;`,
          [slotId, predictedHeadcount, recommendedFoodKg, cutoffTime.toISOString()]
        );

        // 6. Generate Kitchen Waste Log
        // Cooked mass based on V2D recommendation
        const cookedMassKg = recommendedFoodKg;
        const consumedMassKg = Number((actualHeadcount * r).toFixed(2));
        const discardedMassKg = Number(Math.max(0.05, cookedMassKg - consumedMassKg).toFixed(2));
        // Baseline unmanaged waste (without V2D, kitchen cooks for 100% enrolled capacity + 20% excess)
        const unmanagedCookedKg = Number((totalEnrolled * r * 1.15).toFixed(2));
        const baselineWasteKg = Number(Math.max(0.8, unmanagedCookedKg - consumedMassKg).toFixed(2));
        const unitCostPerKg = 3.50;

        await client.query(
          `INSERT INTO kitchen_waste_logs (
             meal_slot_id, cooked_mass_kg, consumed_mass_kg, discarded_mass_kg, unit_cost_per_kg, baseline_waste_kg,
             actual_cooked_kg, actual_consumed_kg, leftover_waste_kg, baseline_estimated_waste_kg, logged_by, logged_at, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $2, $3, $4, $6, $7, $8, $8)
           ON CONFLICT (meal_slot_id) DO UPDATE SET
             cooked_mass_kg = EXCLUDED.cooked_mass_kg,
             consumed_mass_kg = EXCLUDED.consumed_mass_kg,
             discarded_mass_kg = EXCLUDED.discarded_mass_kg,
             baseline_waste_kg = EXCLUDED.baseline_waste_kg;`,
          [
            slotId,
            cookedMassKg,
            consumedMassKg,
            discardedMassKg,
            unitCostPerKg,
            baselineWasteKg,
            supervisorUserId,
            mealEndTime.toISOString(),
          ]
        );
        totalWasteLogsCreated++;
      }
    }

    await client.query('COMMIT');

    logger.info('✅ 30-Day Historical Data Seeding Completed Successfully:');
    logger.info(`   - Meal Slots Created: ${totalSlotsCreated} (Breakfast, Lunch, Dinner across 30 days)`);
    logger.info(`   - Exam Period Flagged: Days 6 to 11 in past (Mid-Term Exam Period)`);
    logger.info(`   - Votes Ingested: ${totalVotesCreated}`);
    logger.info(`   - Attendance Logs Recorded: ${totalAttendanceCreated}`);
    logger.info(`   - Kitchen Waste Logs Generated: ${totalWasteLogsCreated}`);
    logger.info('===============================================================');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('❌ Historical Seeding Failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedHistoricalData();
