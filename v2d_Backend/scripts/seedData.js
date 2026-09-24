import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const pool = new Pool({
  host: env.DB.host,
  port: env.DB.port,
  database: env.DB.database,
  user: env.DB.user,
  password: env.DB.password,
});

const seed = async () => {
  const client = await pool.connect();
  try {
    logger.info('Starting Multi-Tenant Seed Script...');
    await client.query('BEGIN');

    // 1. Seed Hostel
    const hostelRes = await client.query(`
      INSERT INTO hostels (name, code, location, total_capacity)
      VALUES ('Kaveri Hostel', 'KAV-01', 'North Campus Block A', 500)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id;
    `);
    const hostelId = hostelRes.rows[0].id;

    // 2. Seed Mess
    const existingMess = await client.query(
      `SELECT id FROM messes WHERE hostel_id = $1 AND name = $2;`,
      [hostelId, 'Kaveri Dining Hall']
    );
    let messId;
    if (existingMess.rows.length > 0) {
      messId = existingMess.rows[0].id;
    } else {
      const messRes = await client.query(`
        INSERT INTO messes (hostel_id, name, capacity)
        VALUES ($1, 'Kaveri Dining Hall', 500)
        RETURNING id;
      `, [hostelId]);
      messId = messRes.rows[0].id;
    }

    // 3. Seed Meal Types
    const mealTypes = [
      { name: 'BREAKFAST', open: 12, cutoff: 2 },
      { name: 'LUNCH', open: 12, cutoff: 2 },
      { name: 'SNACKS', open: 12, cutoff: 2 },
      { name: 'DINNER', open: 12, cutoff: 2 },
    ];

    for (const mt of mealTypes) {
      await client.query(`
        INSERT INTO meal_types (name, default_open_offset_hours, default_cutoff_offset_hours)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET 
          default_open_offset_hours = EXCLUDED.default_open_offset_hours,
          default_cutoff_offset_hours = EXCLUDED.default_cutoff_offset_hours;
      `, [mt.name, mt.open, mt.cutoff]);
    }

    // 4. Seed Admin User
    const adminPassHash = await bcrypt.hash('AdminPass@123', 10);
    await client.query(`
      INSERT INTO users (username, email, hashed_password, role, hostel_id, is_active)
      VALUES ('admin', 'admin@v2d.campus.edu', $1, 'ADMIN', $2, TRUE)
      ON CONFLICT (username) DO UPDATE SET hashed_password = EXCLUDED.hashed_password;
    `, [adminPassHash, hostelId]);

    // 5. Seed Supervisor User
    const supervisorPassHash = await bcrypt.hash('SuperPass@123', 10);
    await client.query(`
      INSERT INTO users (username, email, hashed_password, role, hostel_id, is_active)
      VALUES ('supervisor_kaveri', 'supervisor.kaveri@v2d.campus.edu', $1, 'SUPERVISOR', $2, TRUE)
      ON CONFLICT (username) DO UPDATE SET hashed_password = EXCLUDED.hashed_password;
    `, [supervisorPassHash, hostelId]);

    // 6. Seed 10 Students
    const studentPassHash = await bcrypt.hash('StudentPass@123', 10);
    const ordinalNames = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

    for (let i = 1; i <= 10; i++) {
      const username = `student_${i}`;
      const email = `student_${i}@v2d.campus.edu`;
      const rollNumber = `2026IT00${i < 10 ? '0' + i : i}`;
      const name = `Student ${ordinalNames[i - 1]}`;
      const roomNumber = `A-${100 + i}`;

      // Insert User
      const uRes = await client.query(`
        INSERT INTO users (username, email, hashed_password, role, hostel_id, is_active)
        VALUES ($1, $2, $3, 'STUDENT', $4, TRUE)
        ON CONFLICT (username) DO UPDATE SET hashed_password = EXCLUDED.hashed_password
        RETURNING id;
      `, [username, email, studentPassHash, hostelId]);

      const userId = uRes.rows[0].id;

      // Insert Student Profile
      await client.query(`
        INSERT INTO students (user_id, hostel_id, mess_id, name, roll_number, room_number, enrolled)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE)
        ON CONFLICT (roll_number) DO UPDATE SET 
          user_id = EXCLUDED.user_id,
          mess_id = EXCLUDED.mess_id,
          room_number = EXCLUDED.room_number;
      `, [userId, hostelId, messId, name, rollNumber, roomNumber]);
    }

    await client.query('COMMIT');
    logger.info('✅ Seed Completed Successfully:');
    logger.info('   - 1 Hostel: Kaveri Hostel (KAV-01)');
    logger.info('   - 1 Mess: Kaveri Dining Hall');
    logger.info('   - 4 Meal Types: BREAKFAST, LUNCH, SNACKS, DINNER');
    logger.info('   - 1 Admin: admin / AdminPass@123');
    logger.info('   - 1 Supervisor: supervisor_kaveri / SuperPass@123');
    logger.info('   - 10 Students: student_1 to student_10 / StudentPass@123 (Roll: 2026IT0001 to 2026IT0010)');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
