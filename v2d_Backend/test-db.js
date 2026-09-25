import { query } from "./src/config/db.js";

const line = "═".repeat(60);

async function dbCheck() {
  console.log(`\n${line}`);
  console.log("              V2D DATABASE CHECK");
  console.log(`${line}\n`);

  try {
    // ─────────────────────────────────────────────
    // 1. DATABASE CONNECTION
    // ─────────────────────────────────────────────

    const db = await query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        NOW() AS server_time
    `);

    console.log("🗄️  DATABASE");
    console.log(`   Database:      ${db.rows[0].database}`);
    console.log(`   User:          ${db.rows[0].user}`);
    console.log(`   Server time:   ${db.rows[0].server_time}`);
    console.log("   Connection:    ✅");
    console.log();

    // ─────────────────────────────────────────────
    // 2. USERS
    // ─────────────────────────────────────────────

    const users = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE role = 'STUDENT') AS students,
        COUNT(*) FILTER (WHERE role = 'SUPERVISOR') AS supervisors,
        COUNT(*) FILTER (WHERE is_active = true) AS active
      FROM users
    `);

    const u = users.rows[0];

    console.log("👥 USERS");
    console.log(`   Total:         ${u.total}`);
    console.log(`   Students:      ${u.students}`);
    console.log(`   Supervisors:   ${u.supervisors}`);
    console.log(`   Active:        ${u.active}`);
    console.log();

    // ─────────────────────────────────────────────
    // 3. STUDENTS
    // ─────────────────────────────────────────────

    const students = await query(`
      SELECT
        id,
        name,
        roll_number,
        enrolled
      FROM students
      ORDER BY id
    `);

    console.log("🎓 STUDENTS");
    console.log(`   Total records: ${students.rows.length}`);

    for (const student of students.rows) {
      console.log(
        `   ${student.roll_number} | ${student.name} | ` +
          `${student.enrolled ? "ENROLLED ✅" : "NOT ENROLLED ❌"}`,
      );
    }

    console.log();

    // ─────────────────────────────────────────────
    // 4. REQUIRED PoW STUDENTS
    // ─────────────────────────────────────────────

    const powStudents = await query(`
      SELECT
        u.username,
        u.role,
        s.roll_number,
        s.name
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      WHERE u.username LIKE 'student_%'
      ORDER BY u.username
    `);

    console.log("🧪 PoW STUDENT CHECK");

    for (const student of powStudents.rows) {
      const ok =
        student.role === "STUDENT" && student.roll_number && student.name;

      console.log(
        `   ${student.username.padEnd(12)} ` +
          `${ok ? "✅" : "❌"} ` +
          `${student.roll_number ?? "NO STUDENT RECORD"}`,
      );
    }

    console.log();

    // ─────────────────────────────────────────────
    // 5. MEAL TYPES
    // ─────────────────────────────────────────────

    const mealTypes = await query(`
      SELECT *
      FROM meal_types
      ORDER BY id
    `);

    console.log("🍽️  MEAL TYPES");
    console.log(`   Total: ${mealTypes.rows.length}`);

    for (const meal of mealTypes.rows) {
      console.log(
        `   ID ${meal.id} | ${meal.name ?? meal.meal_type ?? JSON.stringify(meal)}`,
      );
    }

    console.log();

    // ─────────────────────────────────────────────
    // 6. MEAL SLOTS
    // ─────────────────────────────────────────────

    const slots = await query(`
      SELECT COUNT(*) AS total
      FROM meal_slots
    `);

    console.log("🕐 MEAL SLOTS");
    console.log(`   Total existing slots: ${slots.rows[0].total}`);
    console.log();
    ``;

    // ─────────────────────────────────────────────
    // FINAL
    // ─────────────────────────────────────────────

    console.log(line);
    console.log("       ✅ DATABASE CHECK COMPLETE");
    console.log("       🔒 READ-ONLY — NO DATA MODIFIED");
    console.log(line);
    console.log();
  } catch (error) {
    console.log(line);
    console.log("❌ DATABASE CHECK FAILED");
    console.log(line);
    console.error("\nError:", error.message);
    console.log();
  } finally {
    process.exit(0);
  }
}

dbCheck();
