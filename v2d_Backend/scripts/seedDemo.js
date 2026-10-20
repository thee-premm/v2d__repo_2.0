#!/usr/bin/env node
/**
 * DEMO DATA — for local development and UI review only.
 *
 * Creates "Riverside Institute (demo)", flagged institutions.is_demo = true so
 * every screen labels it as sample data. Past meals are SIMULATED with a fixed
 * random seed; forecasts for those meals are produced by the real forecasting
 * model using only the simulated history before each meal. None of this is
 * real attendance or waste data.
 *
 * Refuses to run in production, and refuses to run twice (delete the demo
 * institution's database or use a fresh DB_NAME to reseed).
 *
 * Usage:  npm run db:seed:demo            (password defaults to "vote2dine-demo")
 *         DEMO_PASSWORD=... npm run db:seed:demo
 */
import pg from "pg";
import { env } from "../src/config/env.js";
import { connectionConfig } from "../src/config/db.js";
import { migrate } from "../src/db/migrator.js";
import { hashPassword } from "../src/lib/security.js";
import { forecastAttendance } from "../src/modules/forecasting/model.js";
import { DEFAULT_SETTINGS } from "../src/domain/settings.js";
import { classify } from "../src/modules/reconciliation/reconciliation.service.js";

if (env.isProduction) {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const PASSWORD = process.env.DEMO_PASSWORD || "vote2dine-demo";
const HISTORY_DAYS = 28;
const TZ_OFFSET = "+05:30"; // Asia/Kolkata has no daylight saving

// Deterministic PRNG (mulberry32) so the demo is reproducible.
let seed = 20261020;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p) => rand() < p;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const noise = (sd) => {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
};
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

const client = new pg.Client(connectionConfig());

async function q(text, params) {
  return client.query(text, params);
}
async function one(text, params) {
  return (await q(text, params)).rows[0];
}

const localDateOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const at = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00${TZ_OFFSET}`);
const minutes = (d, m) => new Date(d.getTime() + m * 60_000);

// --------------------------------------------------------------------------
// Static catalogue
// --------------------------------------------------------------------------
const INGREDIENTS = [
  ["Rice", "MASS", 52, "Grains"],
  ["Wheat flour", "MASS", 38, "Grains"],
  ["Poha (flattened rice)", "MASS", 64, "Grains"],
  ["Toor dal", "MASS", 135, "Pulses"],
  ["Moong dal", "MASS", 118, "Pulses"],
  ["Potato", "MASS", 28, "Vegetables"],
  ["Onion", "MASS", 34, "Vegetables"],
  ["Tomato", "MASS", 30, "Vegetables"],
  ["Mixed vegetables", "MASS", 48, "Vegetables"],
  ["Paneer", "MASS", 380, "Dairy"],
  ["Curd", "MASS", 72, "Dairy"],
  ["Milk", "VOLUME", 56, "Dairy"],
  ["Cooking oil", "VOLUME", 148, "Oils"],
  ["Sugar", "MASS", 44, "Staples"],
  ["Eggs", "COUNT", 6.5, "Protein"],
  ["Tea leaves", "MASS", 460, "Beverages"],
];

// name, category, veg, portion g, [ingredient, qty per serving in base unit, yield]
const DISHES = [
  ["Steamed rice", "RICE", true, 220, [["Rice", 0.11, 1]]],
  ["Jeera rice", "RICE", true, 220, [["Rice", 0.11, 1], ["Cooking oil", 0.005, 1]]],
  ["Chapati", "BREAD", true, 120, [["Wheat flour", 0.075, 1], ["Cooking oil", 0.003, 1]]],
  ["Dal tadka", "MAIN", true, 180, [["Toor dal", 0.045, 0.95], ["Onion", 0.015, 0.9], ["Tomato", 0.015, 0.92], ["Cooking oil", 0.006, 1]]],
  ["Moong dal", "MAIN", true, 180, [["Moong dal", 0.045, 0.95], ["Tomato", 0.012, 0.92], ["Cooking oil", 0.005, 1]]],
  ["Aloo sabzi", "SIDE", true, 140, [["Potato", 0.11, 0.85], ["Onion", 0.02, 0.9], ["Cooking oil", 0.007, 1]]],
  ["Mixed veg curry", "SIDE", true, 150, [["Mixed vegetables", 0.11, 0.88], ["Onion", 0.02, 0.9], ["Tomato", 0.02, 0.92], ["Cooking oil", 0.008, 1]]],
  ["Paneer butter masala", "MAIN", true, 160, [["Paneer", 0.06, 1], ["Tomato", 0.04, 0.92], ["Onion", 0.02, 0.9], ["Milk", 0.02, 1], ["Cooking oil", 0.01, 1]]],
  ["Poha", "MAIN", true, 200, [["Poha (flattened rice)", 0.07, 1], ["Onion", 0.02, 0.9], ["Potato", 0.03, 0.85], ["Cooking oil", 0.006, 1]]],
  ["Boiled eggs", "PROTEIN", false, 100, [["Eggs", 2, 1]]],
  ["Masala chai", "BEVERAGE", true, 150, [["Milk", 0.1, 1], ["Tea leaves", 0.003, 1], ["Sugar", 0.012, 1]]],
  ["Curd", "SIDE", true, 100, [["Curd", 0.1, 1]]],
  ["Rice kheer", "DESSERT", true, 120, [["Rice", 0.02, 1], ["Milk", 0.12, 1], ["Sugar", 0.02, 1]]],
];

const MENUS = {
  BREAKFAST: [
    [["Poha", 1], ["Masala chai", 0.9]],
    [["Boiled eggs", 0.6], ["Chapati", 0.8], ["Masala chai", 0.9]],
    [["Aloo sabzi", 1], ["Chapati", 1], ["Masala chai", 0.9]],
  ],
  LUNCH: [
    [["Steamed rice", 1], ["Dal tadka", 1], ["Aloo sabzi", 0.9], ["Curd", 0.7]],
    [["Jeera rice", 1], ["Moong dal", 1], ["Mixed veg curry", 0.9], ["Chapati", 0.8]],
    [["Steamed rice", 1], ["Dal tadka", 1], ["Mixed veg curry", 0.9], ["Curd", 0.7]],
  ],
  DINNER: [
    [["Chapati", 1], ["Paneer butter masala", 1], ["Steamed rice", 0.7], ["Rice kheer", 0.8]],
    [["Chapati", 1], ["Dal tadka", 1], ["Aloo sabzi", 0.9], ["Steamed rice", 0.7]],
    [["Chapati", 1], ["Moong dal", 1], ["Mixed veg curry", 0.9], ["Steamed rice", 0.7]],
  ],
};

const MEAL_TYPES = [
  // code, name, start, end, cutoff minutes before start, open hours before, base propensity
  ["BREAKFAST", "Breakfast", "07:30", "09:30", 600, 36, 0.58],
  ["LUNCH", "Lunch", "12:30", "14:30", 180, 36, 0.78],
  ["DINNER", "Dinner", "19:30", "21:30", 180, 36, 0.84],
];

const FIRST = ["Aarav", "Diya", "Ishaan", "Meera", "Kabir", "Ananya", "Rohan", "Saanvi", "Arjun", "Kavya", "Vikram", "Priya", "Aditya", "Nisha", "Rahul", "Tara", "Karthik", "Lakshmi", "Sameer", "Fatima", "Joseph", "Zoya", "Harpreet", "Neel", "Riya", "Imran", "Sneha", "Dev", "Pooja", "Arnav"];
const LAST = ["Sharma", "Iyer", "Reddy", "Nair", "Khan", "Patel", "Das", "Menon", "Singh", "Gupta", "Rao", "Thomas", "Bose", "Kulkarni", "Joshi", "Pillai", "Ahmed", "Mehta", "Chatterjee", "Verma"];

async function main() {
  await client.connect();
  await migrate(client);
  const exists = await one(`SELECT id FROM institutions WHERE code = 'DEMO'`);
  if (exists) {
    console.error(`Demo institution already exists in "${env.db.database}". Use a fresh database to reseed.`);
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  const today = localDateOf(now);
  const hash = await hashPassword(PASSWORD);
  const settings = { ...structuredClone(DEFAULT_SETTINGS), analytics: { ...DEFAULT_SETTINGS.analytics, foodCostPerKg: 95 } };

  await q("BEGIN");
  const inst = await one(
    `INSERT INTO institutions (code, name, timezone, currency, settings, is_demo) VALUES ('DEMO', 'Riverside Institute (demo)', 'Asia/Kolkata', 'INR', $1, true) RETURNING id`,
    [JSON.stringify(settings)],
  );
  const I = inst.id;
  const campus = await one(`INSERT INTO campuses (institution_id, code, name) VALUES ($1, 'MAIN', 'Main campus') RETURNING id`, [I]);
  const kav = await one(`INSERT INTO hostels (institution_id, campus_id, code, name, capacity) VALUES ($1, $2, 'KAV', 'Kaveri Hall', 450) RETURNING id`, [I, campus.id]);
  const god = await one(`INSERT INTO hostels (institution_id, campus_id, code, name, capacity) VALUES ($1, $2, 'GOD', 'Godavari Hall', 320) RETURNING id`, [I, campus.id]);
  const messKav = await one(`INSERT INTO messes (institution_id, campus_id, hostel_id, code, name, seating_capacity) VALUES ($1, $2, $3, 'KAV-M', 'Kaveri Mess', 220) RETURNING id`, [I, campus.id, kav.id]);
  const messGod = await one(`INSERT INTO messes (institution_id, campus_id, hostel_id, code, name, seating_capacity) VALUES ($1, $2, $3, 'GOD-M', 'Godavari Mess', 160) RETURNING id`, [I, campus.id, god.id]);
  const messes = [
    { id: messKav.id, hostel: kav.id, size: 140, prefix: "21CS", label: "Kaveri" },
    { id: messGod.id, hostel: god.id, size: 90, prefix: "22EE", label: "Godavari" },
  ];

  const mealTypeIds = {};
  for (const [i, [code, name, start, end, cutoff, open]] of MEAL_TYPES.entries()) {
    const r = await one(
      `INSERT INTO meal_types (institution_id, code, name, default_service_start, default_service_end, default_cutoff_minutes, default_open_hours, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [I, code, name, start, end, cutoff, open, i],
    );
    mealTypeIds[code] = r.id;
  }

  // Staff
  const mkUser = async (username, fullName, email, roles) => {
    const u = await one(
      `INSERT INTO users (institution_id, username, email, full_name, password_hash, status, password_changed_at) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', now()) RETURNING id`,
      [I, username, email, fullName, hash],
    );
    for (const [role, messId] of roles) await q(`INSERT INTO role_assignments (user_id, institution_id, role, mess_id) VALUES ($1, $2, $3, $4)`, [u.id, I, role, messId ?? null]);
    return u.id;
  };
  const admin = await mkUser("demo.admin", "Dr. Kavitha Rao", "admin@riverside.demo", [["INSTITUTION_ADMIN"]]);
  const supKav = await mkUser("demo.supervisor", "Suresh Menon", "suresh@riverside.demo", [["SUPERVISOR", messKav.id]]);
  const supGod = await mkUser("demo.supervisor2", "Anita Kulkarni", "anita@riverside.demo", [["SUPERVISOR", messGod.id]]);
  const kitchen = await mkUser("demo.kitchen", "Ramesh Pillai", null, [["KITCHEN_STAFF", messKav.id]]);
  await mkUser("demo.kitchen2", "Lata Joshi", null, [["KITCHEN_STAFF", messGod.id]]);
  const supervisorFor = { [messKav.id]: supKav, [messGod.id]: supGod };

  // Students
  const startDate = addDays(today, -HISTORY_DAYS - 2);
  for (const m of messes) {
    m.students = [];
    for (let i = 1; i <= m.size; i++) {
      const roll = `${m.prefix}${String(i).padStart(4, "0")}`;
      const isDemoStudent = m.id === messKav.id && i === 1;
      const username = isDemoStudent ? "demo.student" : roll.toLowerCase();
      const name = isDemoStudent ? "Meera Iyer" : `${pick(FIRST)} ${pick(LAST)}`;
      // ~8 % of the roster never activated their account: still eligible, never votes.
      const invited = !isDemoStudent && chance(0.08);
      const u = await one(
        `INSERT INTO users (institution_id, username, full_name, password_hash, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [I, username, name, invited ? null : hash, invited ? "INVITED" : "ACTIVE"],
      );
      await q(`INSERT INTO role_assignments (user_id, institution_id, role) VALUES ($1, $2, 'STUDENT')`, [u.id, I]);
      await q(`INSERT INTO student_profiles (user_id, institution_id, roll_number, hostel_id, room_number, year_of_study) VALUES ($1, $2, $3, $4, $5, $6)`, [
        u.id,
        I,
        roll,
        m.hostel,
        `${m.label[0]}-${100 + Math.floor(i / 2)}`,
        1 + (i % 4),
      ]);
      await q(`INSERT INTO mess_memberships (institution_id, student_user_id, mess_id, valid_from) VALUES ($1, $2, $3, $4)`, [I, u.id, m.id, startDate]);
      m.students.push({
        id: Number(u.id),
        demo: isDemoStudent,
        invited,
        votes: invited ? 0 : isDemoStudent ? 0.95 : 0.55 + rand() * 0.4, // how reliably they vote
        appetite: { BREAKFAST: 0.3 + rand() * 0.6, LUNCH: 0.55 + rand() * 0.4, DINNER: 0.6 + rand() * 0.38 },
      });
    }
  }

  // Catalogue
  const ing = {};
  for (const [name, dim, cost, cat] of INGREDIENTS) {
    ing[name] = (await one(`INSERT INTO ingredients (institution_id, name, dimension, cost_per_base_unit, category) VALUES ($1, $2, $3, $4, $5) RETURNING id, dimension`, [I, name, dim, cost, cat]));
    ing[name].cost = cost;
  }
  const dish = {};
  for (const [name, cat, veg, portion, recipe] of DISHES) {
    const d = await one(`INSERT INTO dishes (institution_id, name, category, is_vegetarian, portion_grams) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [I, name, cat, veg, portion]);
    dish[name] = { id: Number(d.id), portion, recipe };
    for (const [iname, qty, yieldF] of recipe) {
      await q(`INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity_per_serving, yield_factor) VALUES ($1, $2, $3, $4)`, [d.id, ing[iname].id, qty, yieldF]);
    }
  }
  // A dish without a recipe, to show how missing recipe data is reported.
  await q(`INSERT INTO dishes (institution_id, name, category, is_vegetarian, portion_grams) VALUES ($1, 'Seasonal fruit', 'DESSERT', true, 120)`, [I]);

  // Opening stock and stock settings
  for (const m of messes) {
    for (const [name, dim] of INGREDIENTS) {
      const scale = m.size / 100;
      const qty = dim === "COUNT" ? Math.round(600 * scale) : round((name === "Rice" || name === "Wheat flour" ? 220 : name === "Milk" ? 120 : 40) * scale, 1);
      await q(
        `INSERT INTO inventory_transactions (institution_id, mess_id, ingredient_id, kind, quantity, unit_cost, note, recorded_by, recorded_at) VALUES ($1, $2, $3, 'RECEIPT', $4, $5, 'Opening stock (demo)', $6, $7)`,
        [I, m.id, ing[name].id, qty, ing[name].cost, supervisorFor[m.id], at(startDate, "10:00")],
      );
      await q(`INSERT INTO mess_ingredient_settings (mess_id, ingredient_id, safety_stock_qty, pack_size_qty) VALUES ($1, $2, $3, $4)`, [
        m.id,
        ing[name].id,
        dim === "COUNT" ? 60 : round(qty * 0.15, 1),
        dim === "COUNT" ? 30 : name === "Rice" || name === "Wheat flour" ? 25 : dim === "VOLUME" ? 5 : 5,
      ]);
    }
  }

  // ------------------------------------------------------------------------
  // Simulated history
  // ------------------------------------------------------------------------
  const history = {}; // `${mess}:${mealType}` → summed outcomes, for the real forecasting model
  const warningsIssued = new Map(); // student → [{ date }]
  let mealsSimulated = 0;

  const stats = { slots: 0, votes: 0 };
  const weeklyIssues = new Map(); // `${mess}:${ingredient}:${week}` → kg issued, replenished by a weekly delivery
  for (let dayOffset = -HISTORY_DAYS; dayOffset <= 0; dayOffset++) {
    const date = addDays(today, dayOffset);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
    for (const m of messes) {
      for (const [code, , start, end, cutoffMin, openHours, base] of MEAL_TYPES) {
        const serviceStart = at(date, start);
        const serviceEnd = at(date, end);
        // Today's meals that have not finished yet are created later as live meals.
        if (serviceEnd > now) continue;
        const closes = minutes(serviceStart, -cutoffMin);
        const opens = minutes(serviceStart, -openHours * 60);
        const weekendFactor = dow === 0 && code === "BREAKFAST" ? 0.65 : dow === 0 || dow === 6 ? 0.88 : 1;
        const examFactor = dayOffset >= -12 && dayOffset <= -8 ? 1.06 : 1;
        const menuIdx = (dayOffset + 30 + (code === "LUNCH" ? 1 : 0)) % 3;
        const menu = MENUS[code][menuIdx];

        // Votes and attendance per student
        const rows = [];
        for (const s of m.students) {
          const appetite = Math.min(0.98, s.appetite[code] * weekendFactor * examFactor * (base / 0.75));
          const wantsToEat = chance(appetite);
          let intent = "UNVOTED";
          if (!s.invited && chance(s.votes)) intent = wantsToEat ? (chance(0.96) ? "YES" : "NO") : chance(0.93) ? "NO" : "YES";
          let attended;
          if (intent === "YES") attended = wantsToEat ? chance(0.93) : chance(0.12);
          else if (intent === "NO") attended = chance(0.035);
          else attended = wantsToEat ? chance(0.72) : chance(0.05);
          rows.push({ s, intent, attended });
        }
        const counts = {
          eligible: rows.length,
          yes: rows.filter((r) => r.intent === "YES").length,
          no: rows.filter((r) => r.intent === "NO").length,
          unvoted: rows.filter((r) => r.intent === "UNVOTED").length,
        };
        const key = `${m.id}:${code}`;
        const h = history[key] ?? { slotCount: 0, yes: { total: 0, attended: 0 }, no: { total: 0, attended: 0 }, unvoted: { total: 0, attended: 0 } };
        const forecast = forecastAttendance(counts, h, settings.forecast, { examPeriod: examFactor > 1 });
        const override = chance(0.1);
        const approved = override ? forecast.recommendedServings + Math.round(4 + rand() * 10) : forecast.recommendedServings;

        const slot = await one(
          `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at, status,
                                   is_exam_period, created_by, created_at, published_at, locked_at, service_started_at, service_closed_at, reconciled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RECONCILED', $9, $10, $11, $11, $6, $7, $8, $12) RETURNING id`,
          [I, m.id, mealTypeIds[code], date, opens, closes, serviceStart, serviceEnd, examFactor > 1, supervisorFor[m.id], minutes(opens, -60), minutes(serviceEnd, 40)],
        );
        const slotId = Number(slot.id);
        stats.slots += 1;
        for (const [i, [dname, uptake]] of menu.entries()) {
          await q(`INSERT INTO meal_slot_menu_items (meal_slot_id, dish_id, uptake_fraction, sort_order) VALUES ($1, $2, $3, $4)`, [slotId, dish[dname].id, uptake, i]);
        }

        // Votes, events, snapshot, aggregate
        const voted = rows.filter((r) => r.intent !== "UNVOTED");
        if (voted.length) {
          const castAt = voted.map(() => minutes(opens, 30 + rand() * (closes - opens) / 60_000 * 0.9));
          await q(
            `INSERT INTO votes (meal_slot_id, student_user_id, intent, first_cast_at, updated_at, change_count)
             SELECT $1, u.sid, u.intent::vote_intent, u.t, u.t, 0 FROM unnest($2::bigint[], $3::text[], $4::timestamptz[]) AS u(sid, intent, t)`,
            [slotId, voted.map((r) => r.s.id), voted.map((r) => r.intent), castAt],
          );
          await q(
            `INSERT INTO vote_events (meal_slot_id, student_user_id, intent, recorded_at)
             SELECT $1, u.sid, u.intent::vote_intent, u.t FROM unnest($2::bigint[], $3::text[], $4::timestamptz[]) AS u(sid, intent, t)`,
            [slotId, voted.map((r) => r.s.id), voted.map((r) => r.intent), castAt],
          );
          stats.votes += voted.length;
        }
        await q(
          `INSERT INTO vote_snapshots (meal_slot_id, student_user_id, intent) SELECT $1, u.sid, u.intent::cutoff_intent FROM unnest($2::bigint[], $3::text[]) AS u(sid, intent)`,
          [slotId, rows.map((r) => r.s.id), rows.map((r) => r.intent)],
        );
        await q(`INSERT INTO cutoff_aggregates (meal_slot_id, eligible_count, yes_count, no_count, unvoted_count, locked_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
          slotId,
          counts.eligible,
          counts.yes,
          counts.no,
          counts.unvoted,
          closes,
        ]);
        const f = await one(
          `INSERT INTO forecasts (meal_slot_id, version, method, model_version, eligible_count, yes_count, no_count, unvoted_count, rate_yes, rate_no, rate_unvoted,
                                  predicted_attendance, interval_low, interval_high, interval_level, service_level, recommended_servings, safety_buffer_servings,
                                  history_slot_count, inputs, warnings, generated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
          [
            slotId,
            forecast.method,
            forecast.modelVersion,
            counts.eligible,
            counts.yes,
            counts.no,
            counts.unvoted,
            forecast.rates.yes,
            forecast.rates.no,
            forecast.rates.unvoted,
            forecast.predictedAttendance,
            forecast.interval.low,
            forecast.interval.high,
            forecast.interval.level,
            forecast.serviceLevel,
            forecast.recommendedServings,
            forecast.safetyBufferServings,
            h.slotCount,
            JSON.stringify({ counts, history: { ...h }, priors: settings.forecast.priors, posterior: forecast.posterior, demo: true, explanation: `Expected attendance = ${counts.yes} YES × ${forecast.rates.yes} + ${counts.no} NO × ${forecast.rates.no} + ${counts.unvoted} unvoted × ${forecast.rates.unvoted}.` }),
            JSON.stringify(forecast.warnings),
            closes,
          ],
        );
        await q(
          `INSERT INTO preparation_plans (meal_slot_id, forecast_id, recommended_servings, approved_servings, is_override, override_reason, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [slotId, f.id, forecast.recommendedServings, approved, override, override ? pick(["Visiting sports team", "Department event nearby", "Kitchen judgement: popular menu"]) : null, supervisorFor[m.id], minutes(closes, 20)],
        );

        // Plan requirements (frozen) and preparation records
        const req = new Map();
        let preparedTotal = 0;
        for (const [dname, uptake] of menu) {
          const d = dish[dname];
          const servings = Math.ceil(approved * uptake);
          for (const [iname, qty, yieldF] of d.recipe) req.set(iname, (req.get(iname) ?? 0) + (servings * qty) / yieldF);
          const preparedKg = round((servings * d.portion * (1 + noise(0.04))) / 1000, 2);
          preparedTotal += preparedKg;
          await q(
            `INSERT INTO prep_tasks (meal_slot_id, dish_id, planned_servings, status, prepared_kg, prepared_measurement, started_at, started_by, completed_at, completed_by)
             VALUES ($1, $2, $3, 'DONE', $4, $5, $6, $7, $8, $7)`,
            [slotId, d.id, servings, preparedKg, chance(0.85) ? "MEASURED" : "ESTIMATED", minutes(serviceStart, -150), kitchen, minutes(serviceStart, -20)],
          );
        }
        for (const [iname, qty] of req) {
          await q(
            `INSERT INTO plan_ingredient_requirements (meal_slot_id, ingredient_id, required_qty, on_hand_qty, safety_stock_qty, recommended_procurement_qty, unit_cost) VALUES ($1, $2, $3, NULL, NULL, NULL, $4)`,
            [slotId, ing[iname].id, round(qty, 4), ing[iname].cost],
          );
          if (chance(0.5) && m.id === messKav.id) {
            const issued = round(qty * (1 + noise(0.06) + 0.03), 4);
            const wk = `${m.id}:${iname}:${Math.floor((dayOffset + HISTORY_DAYS) / 7)}`;
            weeklyIssues.set(wk, (weeklyIssues.get(wk) ?? 0) + Math.max(0.0001, issued));
            await q(
              `INSERT INTO inventory_transactions (institution_id, mess_id, ingredient_id, kind, quantity, meal_slot_id, note, recorded_by, recorded_at) VALUES ($1, $2, $3, 'ISSUE', $4, $5, 'Issued for preparation (demo)', $6, $7)`,
              [I, m.id, ing[iname].id, -Math.max(0.0001, issued), slotId, kitchen, minutes(serviceStart, -160)],
            );
          }
        }

        // Counter verification, reconciliation, warnings
        const attendees = rows.filter((r) => r.attended);
        const supId = supervisorFor[m.id];
        for (const r of attendees) {
          const walkIn = r.intent === "YES" ? "NOT_WALK_IN" : r.intent === "NO" ? "AUTHORIZED_EXCEPTION" : "POLICY_PERMITTED";
          await q(
            `INSERT INTO attendance_events (meal_slot_id, student_user_id, intent, in_snapshot, walk_in, method, note, verified_by, verified_at) VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)`,
            [slotId, r.s.id, r.intent, walkIn, chance(0.4) ? "QR" : "ROLL_NUMBER", walkIn === "AUTHORIZED_EXCEPTION" ? "Plans changed; admitted by supervisor (demo)" : null, supId, minutes(serviceStart, rand() * 110)],
          );
        }
        const excused = new Set(rows.filter((r) => r.intent === "YES" && !r.attended && chance(0.12)).map((r) => r.s.id));
        const summary = { counts: {}, eligibleAtCutoff: rows.length, notInSnapshot: 0, actualAttendance: attendees.length, excused: excused.size, warningsIssued: 0 };
        for (const r of rows) {
          r.classification = classify(r.intent, r.attended, excused.has(r.s.id));
          summary.counts[r.classification] = (summary.counts[r.classification] ?? 0) + 1;
        }
        await q(`INSERT INTO reconciliations (meal_slot_id, reconciled_at, reconciled_by, actual_attendance, summary) VALUES ($1, $2, $3, $4, $5)`, [
          slotId,
          minutes(serviceEnd, 40),
          supId,
          attendees.length,
          JSON.stringify(summary),
        ]);
        await q(
          `INSERT INTO attendance_outcomes (meal_slot_id, student_user_id, intent, attended, classification, excuse_reason)
           SELECT $1, u.sid, u.intent::cutoff_intent, u.att, u.cls::attendance_classification, u.reason FROM unnest($2::bigint[], $3::text[], $4::boolean[], $5::text[], $6::text[]) AS u(sid, intent, att, cls, reason)`,
          [slotId, rows.map((r) => r.s.id), rows.map((r) => r.intent), rows.map((r) => r.attended), rows.map((r) => r.classification), rows.map((r) => (excused.has(r.s.id) ? "Medical leave (demo)" : null))],
        );
        for (const r of rows.filter((x) => x.classification === "YES_NO_SHOW")) {
          const prior = (warningsIssued.get(r.s.id) ?? []).filter((d) => d > addDays(date, -30)).length;
          const tier = Math.min(3, prior + 1);
          const w = await one(
            `INSERT INTO warnings (institution_id, mess_id, meal_slot_id, student_user_id, kind, tier, reason, status, issued_at) VALUES ($1, $2, $3, $4, 'NO_SHOW', $5, $6, $7, $8) RETURNING id`,
            [I, m.id, slotId, r.s.id, tier, `Voted YES for ${code.toLowerCase()} on ${date} but attendance was not verified.`, "ACTIVE", minutes(serviceEnd, 40)],
          );
          warningsIssued.set(r.s.id, [...(warningsIssued.get(r.s.id) ?? []), date]);
          summary.warningsIssued += 1;
          if (chance(0.04) || (r.s.demo && dayOffset > -6)) {
            const resolved = dayOffset < -4 && chance(0.7);
            const decision = chance(0.6) ? "WAIVED" : "UPHELD";
            await q(
              `INSERT INTO appeals (warning_id, student_user_id, reason, status, submitted_at, resolved_by, resolved_at, resolution_note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                w.id,
                r.s.id,
                pick(["I came to the counter but my roll number was not found.", "I had an unplanned lab session that ran late.", "I was unwell and forgot to change my vote."]),
                resolved ? decision : "PENDING",
                minutes(serviceEnd, 600),
                resolved ? supId : null,
                resolved ? minutes(serviceEnd, 2000) : null,
                resolved ? (decision === "WAIVED" ? "Explanation accepted." : "No supporting record found for this meal.") : null,
              ],
            );
            await q(`UPDATE warnings SET status = $2 WHERE id = $1`, [w.id, resolved ? decision : "APPEALED"]);
          }
        }
        await q(`UPDATE reconciliations SET summary = $2 WHERE meal_slot_id = $1`, [slotId, JSON.stringify(summary)]);

        // Food & waste ledger — about 15 % of meals have no waste recorded, to show completeness handling.
        const missingWaste = chance(0.15);
        if (!missingWaste) {
          const surplusServings = Math.max(0, approved - attendees.length);
          const avgPortion = preparedTotal / Math.max(1, approved);
          const leftover = surplusServings * avgPortion * (0.85 + rand() * 0.3);
          const reusableShare = 0.35 + rand() * 0.3;
          const plate = attendees.length * (0.028 + rand() * 0.02 + (code === "BREAKFAST" ? 0.01 : 0));
          const estimated = chance(0.2) ? "ESTIMATED" : "MEASURED";
          const logAt = minutes(serviceEnd, 25);
          await q(`INSERT INTO food_logs (meal_slot_id, category, quantity_kg, measurement, recorded_by, recorded_at) VALUES ($1, 'REUSABLE_SURPLUS', $2, $3, $4, $5)`, [slotId, round(leftover * reusableShare, 2), estimated, kitchen, logAt]);
          await q(`INSERT INTO food_logs (meal_slot_id, category, quantity_kg, measurement, recorded_by, recorded_at) VALUES ($1, 'DISCARDED_SURPLUS', $2, $3, $4, $5)`, [slotId, round(leftover * (1 - reusableShare), 2), estimated, kitchen, logAt]);
          await q(`INSERT INTO food_logs (meal_slot_id, category, quantity_kg, measurement, recorded_by, recorded_at) VALUES ($1, 'PLATE_WASTE', $2, $3, $4, $5)`, [slotId, round(plate, 2), estimated, kitchen, logAt]);
          if (chance(0.5)) {
            await q(`INSERT INTO food_logs (meal_slot_id, category, quantity_kg, measurement, recorded_by, recorded_at) VALUES ($1, 'KITCHEN_WASTE', $2, 'MEASURED', $3, $4)`, [slotId, round(preparedTotal * (0.02 + rand() * 0.03), 2), kitchen, minutes(serviceStart, -30)]);
          }
        }

        // Feed this meal's outcomes into the history the next forecast will use.
        for (const g of ["YES", "NO", "UNVOTED"]) {
          const k = g.toLowerCase();
          h[k].total += rows.filter((r) => r.intent === g).length;
          h[k].attended += rows.filter((r) => r.intent === g && r.attended).length;
        }
        h.slotCount += 1;
        history[key] = h;
        mealsSimulated += 1;
      }
    }
  }

  // Weekly deliveries: each week's issues are replenished (plus a little), so
  // recorded stock behaves like a real store instead of drifting negative.
  for (const [key, qty] of weeklyIssues) {
    const [messId, iname, week] = key.split(":");
    await q(
      `INSERT INTO inventory_transactions (institution_id, mess_id, ingredient_id, kind, quantity, unit_cost, note, recorded_by, recorded_at) VALUES ($1, $2, $3, 'RECEIPT', $4, $5, 'Weekly delivery (demo)', $6, $7)`,
      [I, messId, ing[iname].id, round(qty * (1.05 + rand() * 0.1), 3), ing[iname].cost, supervisorFor[messId], at(addDays(today, -HISTORY_DAYS + Number(week) * 7), "09:00")],
    );
  }

  // ------------------------------------------------------------------------
  // Live meals: today's remaining meals and the next two days.
  // The running server's scheduler moves them through the lifecycle.
  // ------------------------------------------------------------------------
  const liveCreated = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const date = addDays(today, dayOffset);
    for (const m of messes) {
      for (const [code, , start, end, cutoffMin, openHours] of MEAL_TYPES) {
        const serviceStart = at(date, start);
        const serviceEnd = at(date, end);
        if (serviceEnd <= now) continue;
        const closes = minutes(serviceStart, -cutoffMin);
        const opens = minutes(serviceStart, -openHours * 60);
        const draft = dayOffset === 2 && code === "DINNER";
        const menu = MENUS[code][(dayOffset + 31 + (code === "LUNCH" ? 1 : 0)) % 3];
        const slot = await one(
          `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at, status, created_by, published_at, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [I, m.id, mealTypeIds[code], date, opens, closes, serviceStart, serviceEnd, draft ? "DRAFT" : "OPEN", supervisorFor[m.id], draft ? null : opens, dayOffset === 1 && code === "DINNER" ? "Festival dinner — special menu" : null],
        );
        for (const [i, [dname, uptake]] of menu.entries()) {
          await q(`INSERT INTO meal_slot_menu_items (meal_slot_id, dish_id, uptake_fraction, sort_order) VALUES ($1, $2, $3, $4)`, [slot.id, dish[dname].id, uptake, i]);
        }
        if (!draft && opens <= now) {
          // Some students have already voted; the demo student's votes are left for you to cast.
          const share = Math.min(1, Math.max(0, (now - opens) / (closes - opens))) * 0.85;
          const voters = m.students.filter((s) => !s.demo && !s.invited && chance(share * s.votes));
          for (const s of voters) {
            const intent = chance(s.appetite[code]) ? "YES" : "NO";
            const t = new Date(Math.min(now.getTime() - 60_000, closes.getTime() - 60_000, opens.getTime() + rand() * (now - opens)));
            await q(`INSERT INTO votes (meal_slot_id, student_user_id, intent, first_cast_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, [slot.id, s.id, intent, t]);
            await q(`INSERT INTO vote_events (meal_slot_id, student_user_id, intent, recorded_at) VALUES ($1, $2, $3, $4)`, [slot.id, s.id, intent, t]);
          }
        }
        liveCreated.push(`${date} ${code} ${m.label}${draft ? " (draft)" : ""}`);
      }
    }
  }

  // Baseline for one mess only, so both states are visible.
  await q(
    `INSERT INTO waste_baselines (institution_id, mess_id, label, period_start, period_end, discarded_g_per_serving, basis, source_note, created_by)
     VALUES ($1, $2, 'Pre-deployment weighing', $3, $4, 118, 'MEASURED', 'Demo value: two-week bin weighing before Vote2Dine (simulated).', $5)`,
    [I, messKav.id, addDays(today, -75), addDays(today, -61), admin],
  );
  await q(
    `INSERT INTO kitchen_incidents (institution_id, mess_id, kind, ingredient_id, description, status, reported_by, reported_at)
     VALUES ($1, $2, 'SHORTAGE', $3, 'Paneer delivery short by 4 kg; substituted part with mixed vegetables (demo).', 'OPEN', $4, $5)`,
    [I, messKav.id, ing.Paneer.id, kitchen, minutes(now, -180)],
  );
  await q("COMMIT");

  console.log(`
Demo data created in database "${env.db.database}" — SIMULATED SAMPLE DATA, not real records.
  Institution : Riverside Institute (demo), timezone Asia/Kolkata
  History     : ${mealsSimulated} reconciled meals over ${HISTORY_DAYS} days, ${stats.votes} votes
  Live meals  : ${liveCreated.length} (today → +2 days); start the API so the scheduler advances them

Sign in at the web app with password "${PASSWORD}":
  demo.admin         Institution admin
  demo.supervisor    Supervisor, Kaveri Mess        (demo.supervisor2 → Godavari Mess)
  demo.kitchen       Kitchen staff, Kaveri Mess
  demo.student       Student, Kaveri Mess (roll 21CS0001)
`);
}

main()
  .catch(async (err) => {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Demo seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
