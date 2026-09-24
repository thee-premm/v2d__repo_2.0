import pkg from 'pg';
const { Client, Pool } = pkg;
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const ddlStatements = `
-- 1. Metadata & Tenancy
CREATE TABLE IF NOT EXISTS hostels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(20) NOT NULL UNIQUE,
    location VARCHAR(255) NOT NULL,
    total_capacity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messes (
    id SERIAL PRIMARY KEY,
    hostel_id INT NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    capacity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meal_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE, -- 'BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'
    default_open_offset_hours INT NOT NULL,
    default_cutoff_offset_hours INT NOT NULL
);

-- 2. Auth, Profiles & RBAC
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    hashed_password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('STUDENT', 'SUPERVISOR', 'ADMIN')),
    hostel_id INT REFERENCES hostels(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    hostel_id INT NOT NULL REFERENCES hostels(id) ON DELETE RESTRICT,
    mess_id INT NOT NULL REFERENCES messes(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    roll_number VARCHAR(50) NOT NULL UNIQUE,
    room_number VARCHAR(20),
    enrolled BOOLEAN DEFAULT TRUE,
    consecutive_no_shows INT DEFAULT 0,
    total_penalties INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Menus & Operational Meal Slots
CREATE TABLE IF NOT EXISTS daily_menus (
    id SERIAL PRIMARY KEY,
    mess_id INT NOT NULL REFERENCES messes(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    meal_type_id INT NOT NULL REFERENCES meal_types(id) ON DELETE CASCADE,
    items_json JSONB NOT NULL DEFAULT '[]',
    calories INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_mess_meal_menu UNIQUE (mess_id, date, meal_type_id)
);

CREATE TABLE IF NOT EXISTS meal_slots (
    id SERIAL PRIMARY KEY,
    mess_id INT NOT NULL REFERENCES messes(id) ON DELETE CASCADE,
    meal_type_id INT NOT NULL REFERENCES meal_types(id) ON DELETE RESTRICT,
    slot_date DATE NOT NULL,
    open_time TIMESTAMPTZ NOT NULL,
    cutoff_time TIMESTAMPTZ NOT NULL,
    meal_start_time TIMESTAMPTZ NOT NULL,
    meal_end_time TIMESTAMPTZ NOT NULL,
    is_locked BOOLEAN DEFAULT FALSE,
    is_exam_period BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_mess_slot UNIQUE (mess_id, slot_date, meal_type_id)
);

-- 4. High-Throughput Voting & Demand Signals
CREATE TABLE IF NOT EXISTS votes (
    id BIGSERIAL PRIMARY KEY,
    student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    meal_slot_id INT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
    vote_status BOOLEAN NOT NULL, -- TRUE: YES, FALSE: NO
    vote_channel VARCHAR(20) DEFAULT 'WEB_APP',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_student_meal_vote UNIQUE (student_id, meal_slot_id)
);

CREATE TABLE IF NOT EXISTS meal_demand_aggregates (
    id SERIAL PRIMARY KEY,
    meal_slot_id INT NOT NULL UNIQUE REFERENCES meal_slots(id) ON DELETE CASCADE,
    total_enrolled INT NOT NULL,
    yes_votes INT NOT NULL DEFAULT 0,
    no_votes INT NOT NULL DEFAULT 0,
    no_response_count INT NOT NULL DEFAULT 0,
    expected_attendance INT NOT NULL DEFAULT 0,
    aggregated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. Verification Gate, Physical Attendance & Exceptions
CREATE TABLE IF NOT EXISTS attendance_records (
    id BIGSERIAL PRIMARY KEY,
    student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    meal_slot_id INT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
    verification_status VARCHAR(30) NOT NULL CHECK (
        verification_status IN ('PRESENT', 'ABSENT', 'EXCUSED_OVERRIDE', 'UNVOTED_WALK_IN')
    ),
    verification_method VARCHAR(20) DEFAULT 'ROLL_NUMBER' CHECK (
        verification_method IN ('QR_CODE', 'ROLL_NUMBER', 'MANUAL_SUPERVISOR')
    ),
    supervisor_notes TEXT,
    verified_by INT REFERENCES users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_student_meal_attendance UNIQUE (student_id, meal_slot_id)
);

CREATE TABLE IF NOT EXISTS penalties_and_appeals (
    id SERIAL PRIMARY KEY,
    student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    meal_slot_id INT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
    violation_type VARCHAR(50) NOT NULL, -- 'NO_SHOW', 'UNAUTHORIZED_WALK_IN'
    warning_tier INT NOT NULL DEFAULT 1, -- 1: Soft Warning, 2: Official Warning, 3: Escalated
    status VARCHAR(30) DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'APPEALED', 'WAIVED', 'UPHELD')),
    appeal_reason TEXT,
    appeal_resolved_by INT REFERENCES users(id) ON DELETE SET NULL,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 6. Notification Dispatch Logs (Module 3)
CREATE TABLE IF NOT EXISTS notification_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('PRE_VOTE_REMINDER', 'CLOSING_ALERT', 'POST_MEAL_CONFIRMATION')),
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('PUSH', 'SMS')),
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'DELIVERED', 'FAILED')),
    retry_count INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. AI Forecasting & Kitchen Analytics (Modules 5 & 6)
CREATE TABLE IF NOT EXISTS ai_forecast_logs (
    id SERIAL PRIMARY KEY,
    meal_slot_id INT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
    model_version VARCHAR(50) NOT NULL,
    window_k INT NOT NULL,
    predicted_attendance NUMERIC(8,2) NOT NULL,
    recommended_food_kg NUMERIC(8,2) NOT NULL,
    safety_buffer_percent NUMERIC(4,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kitchen_waste_logs (
    id SERIAL PRIMARY KEY,
    meal_slot_id INT NOT NULL UNIQUE REFERENCES meal_slots(id) ON DELETE CASCADE,
    cooked_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0,
    consumed_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0,
    discarded_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0,
    unit_cost_per_kg NUMERIC(8,2) NOT NULL DEFAULT 3.50,
    baseline_waste_kg NUMERIC(8,2) DEFAULT 0,
    actual_cooked_kg NUMERIC(8,2) DEFAULT 0,
    actual_consumed_kg NUMERIC(8,2) DEFAULT 0,
    leftover_waste_kg NUMERIC(8,2) DEFAULT 0,
    baseline_estimated_waste_kg NUMERIC(8,2) DEFAULT 0,
    logged_by INT REFERENCES users(id) ON DELETE SET NULL,
    logged_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_and_system_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    event_type VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Migrations & Alterations for idempotency on existing schemas
ALTER TABLE meal_slots ADD COLUMN IF NOT EXISTS is_exam_period BOOLEAN DEFAULT FALSE;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS cooked_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS consumed_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS discarded_mass_kg NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS unit_cost_per_kg NUMERIC(8,2) NOT NULL DEFAULT 3.50;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS baseline_waste_kg NUMERIC(8,2) DEFAULT 0;
ALTER TABLE kitchen_waste_logs ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_votes_slot ON votes(meal_slot_id);
CREATE INDEX IF NOT EXISTS idx_attendance_slot ON attendance_records(meal_slot_id);
CREATE INDEX IF NOT EXISTS idx_students_roll ON students(roll_number);
CREATE INDEX IF NOT EXISTS idx_students_mess ON students(mess_id);
CREATE INDEX IF NOT EXISTS idx_meal_slots_date ON meal_slots(slot_date, is_locked);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notification_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_waste_slot ON kitchen_waste_logs(meal_slot_id);
CREATE INDEX IF NOT EXISTS idx_forecast_slot ON ai_forecast_logs(meal_slot_id);
`;

const initializeDatabase = async () => {
  logger.info('Initializing PostgreSQL Database & Schema...');

  // Step 1: Ensure Target Database Exists
  const rootClient = new Client({
    host: env.DB.host,
    port: env.DB.port,
    user: env.DB.user,
    password: env.DB.password,
    database: 'postgres', // connect to default postgres db first
  });

  try {
    await rootClient.connect();
    const dbCheckRes = await rootClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [env.DB.database]
    );

    if (dbCheckRes.rows.length === 0) {
      logger.info(`Database "${env.DB.database}" does not exist. Creating database...`);
      await rootClient.query(`CREATE DATABASE "${env.DB.database}"`);
      logger.info(`Database "${env.DB.database}" created successfully.`);
    }
  } catch (err) {
    logger.warn(`Could not verify/create database via root client: ${err.message}. Proceeding to connect to target db...`);
  } finally {
    await rootClient.end().catch(() => {});
  }

  // Step 2: Connect to Target Database & Run DDL
  const pool = new Pool({
    host: env.DB.host,
    port: env.DB.port,
    database: env.DB.database,
    user: env.DB.user,
    password: env.DB.password,
  });

  try {
    const client = await pool.connect();
    logger.info(`Executing DDL Schema statements on database "${env.DB.database}"...`);
    await client.query(ddlStatements);
    client.release();
    logger.info('✅ Database Schema Initialized Successfully (All 14 3NF Tables & Indexes Created).');
  } catch (error) {
    logger.error('❌ Failed to initialize database schema:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

initializeDatabase();
