-- Vote2Dine core schema.
-- Conventions:
--   * Every tenant-owned row carries institution_id; composite foreign keys
--     (id, institution_id) make cross-institution references impossible.
--   * All instants are TIMESTAMPTZ (stored UTC). Business dates (service_date)
--     are DATE in the institution's timezone.
--   * Quantities are NUMERIC in base units (kg / l / unit); money is NUMERIC.
--   * Historical records (vote snapshots, aggregates, forecasts, audit) are
--     append-only and protected by triggers.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
CREATE TABLE institutions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency    CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER institutions_updated BEFORE UPDATE ON institutions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campuses (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL REFERENCES institutions(id),
  code            TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code),
  UNIQUE (id, institution_id)
);

CREATE TABLE hostels (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL REFERENCES institutions(id),
  campus_id       BIGINT NOT NULL,
  code            TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  capacity        INT CHECK (capacity IS NULL OR capacity >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code),
  UNIQUE (id, institution_id),
  FOREIGN KEY (campus_id, institution_id) REFERENCES campuses(id, institution_id)
);

CREATE TABLE messes (
  id                BIGSERIAL PRIMARY KEY,
  institution_id    BIGINT NOT NULL REFERENCES institutions(id),
  campus_id         BIGINT NOT NULL,
  hostel_id         BIGINT,
  code              TEXT NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  seating_capacity  INT CHECK (seating_capacity IS NULL OR seating_capacity >= 0),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, code),
  UNIQUE (id, institution_id),
  FOREIGN KEY (campus_id, institution_id) REFERENCES campuses(id, institution_id),
  FOREIGN KEY (hostel_id, institution_id) REFERENCES hostels(id, institution_id)
);
CREATE TRIGGER messes_updated BEFORE UPDATE ON messes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meal_types (
  id                      BIGSERIAL PRIMARY KEY,
  institution_id          BIGINT NOT NULL REFERENCES institutions(id),
  code                    TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z_]{1,23}$'),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  default_service_start   TIME NOT NULL,
  default_service_end     TIME NOT NULL,
  default_cutoff_minutes  INT NOT NULL DEFAULT 120 CHECK (default_cutoff_minutes BETWEEN 0 AND 4320),
  default_open_hours      INT NOT NULL DEFAULT 36 CHECK (default_open_hours BETWEEN 1 AND 336),
  sort_order              INT NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (institution_id, code),
  UNIQUE (id, institution_id),
  CHECK (default_service_end > default_service_start)
);

-- ---------------------------------------------------------------------------
-- Identity, roles, sessions
-- ---------------------------------------------------------------------------
CREATE TYPE user_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');
CREATE TYPE app_role AS ENUM ('STUDENT', 'SUPERVISOR', 'KITCHEN_STAFF', 'INSTITUTION_ADMIN');

CREATE TABLE users (
  id                    BIGSERIAL PRIMARY KEY,
  institution_id        BIGINT NOT NULL REFERENCES institutions(id),
  username              TEXT NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  email                 TEXT CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  full_name             TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 160),
  phone                 TEXT,
  password_hash         TEXT,
  status                user_status NOT NULL DEFAULT 'INVITED',
  failed_login_count    INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  created_by            BIGINT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id),
  CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_uq ON users (username);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE email IS NOT NULL;
CREATE INDEX users_institution_idx ON users (institution_id, status);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_assignments (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  institution_id  BIGINT NOT NULL,
  role            app_role NOT NULL,
  mess_id         BIGINT,
  granted_by      BIGINT REFERENCES users(id),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  revoked_by      BIGINT REFERENCES users(id),
  FOREIGN KEY (user_id, institution_id) REFERENCES users(id, institution_id),
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id),
  CHECK (
    (role IN ('SUPERVISOR', 'KITCHEN_STAFF') AND mess_id IS NOT NULL)
    OR (role IN ('INSTITUTION_ADMIN', 'STUDENT') AND mess_id IS NULL)
  )
);
CREATE UNIQUE INDEX role_assignments_active_uq
  ON role_assignments (user_id, role, COALESCE(mess_id, 0)) WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_mess_idx ON role_assignments (mess_id, role) WHERE revoked_at IS NULL;

CREATE TABLE student_profiles (
  user_id         BIGINT PRIMARY KEY,
  institution_id  BIGINT NOT NULL,
  roll_number     TEXT NOT NULL CHECK (roll_number = upper(roll_number) AND roll_number ~ '^[A-Z0-9][A-Z0-9/_-]{1,31}$'),
  hostel_id       BIGINT,
  room_number     TEXT CHECK (room_number IS NULL OR length(room_number) <= 20),
  program         TEXT CHECK (program IS NULL OR length(program) <= 80),
  year_of_study   SMALLINT CHECK (year_of_study IS NULL OR year_of_study BETWEEN 1 AND 10),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, institution_id) REFERENCES users(id, institution_id),
  FOREIGN KEY (hostel_id, institution_id) REFERENCES hostels(id, institution_id),
  UNIQUE (institution_id, roll_number),
  UNIQUE (user_id, institution_id)
);
CREATE TRIGGER student_profiles_updated BEFORE UPDATE ON student_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A student's mess membership defines meal eligibility. One open membership at a time.
CREATE TABLE mess_memberships (
  id               BIGSERIAL PRIMARY KEY,
  institution_id   BIGINT NOT NULL,
  student_user_id  BIGINT NOT NULL,
  mess_id          BIGINT NOT NULL,
  valid_from       DATE NOT NULL,
  valid_to         DATE,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (student_user_id, institution_id) REFERENCES student_profiles(user_id, institution_id),
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX mess_memberships_one_open ON mess_memberships (student_user_id) WHERE valid_to IS NULL;
CREATE INDEX mess_memberships_mess_idx ON mess_memberships (mess_id, valid_from, valid_to);

CREATE TABLE sessions (
  id                   BIGSERIAL PRIMARY KEY,
  token_hash           BYTEA NOT NULL UNIQUE,
  user_id              BIGINT NOT NULL REFERENCES users(id),
  active_role          app_role NOT NULL,
  csrf_token           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at      TIMESTAMPTZ NOT NULL,
  absolute_expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoke_reason        TEXT,
  ip                   TEXT,
  user_agent           TEXT
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TYPE account_token_purpose AS ENUM ('ACTIVATION', 'PASSWORD_RESET');
CREATE TABLE account_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  purpose     account_token_purpose NOT NULL,
  token_hash  BYTEA NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens (user_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Catalogue: ingredients and dishes (recipes)
-- ---------------------------------------------------------------------------
CREATE TYPE unit_dimension AS ENUM ('MASS', 'VOLUME', 'COUNT');

CREATE TABLE ingredients (
  id                  BIGSERIAL PRIMARY KEY,
  institution_id      BIGINT NOT NULL REFERENCES institutions(id),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  dimension           unit_dimension NOT NULL,
  cost_per_base_unit  NUMERIC(12,4) CHECK (cost_per_base_unit IS NULL OR cost_per_base_unit >= 0),
  category            TEXT CHECK (category IS NULL OR length(category) <= 60),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id)
);
CREATE UNIQUE INDEX ingredients_name_uq ON ingredients (institution_id, lower(name));
CREATE TRIGGER ingredients_updated BEFORE UPDATE ON ingredients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dishes (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL REFERENCES institutions(id),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  category        TEXT CHECK (category IS NULL OR length(category) <= 60),
  is_vegetarian   BOOLEAN,
  portion_grams   NUMERIC(8,2) CHECK (portion_grams IS NULL OR portion_grams > 0),
  description     TEXT CHECK (description IS NULL OR length(description) <= 500),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, institution_id)
);
CREATE UNIQUE INDEX dishes_name_uq ON dishes (institution_id, lower(name));
CREATE TRIGGER dishes_updated BEFORE UPDATE ON dishes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- quantity_per_serving is in the ingredient's base unit (kg / l / unit), as
-- purchased/raw. yield_factor is the usable fraction after trimming/cleaning,
-- so raw requirement = quantity_per_serving / yield_factor.
CREATE TABLE dish_ingredients (
  dish_id               BIGINT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  ingredient_id         BIGINT NOT NULL REFERENCES ingredients(id),
  quantity_per_serving  NUMERIC(12,5) NOT NULL CHECK (quantity_per_serving > 0),
  yield_factor          NUMERIC(5,4) NOT NULL DEFAULT 1 CHECK (yield_factor > 0 AND yield_factor <= 1),
  PRIMARY KEY (dish_id, ingredient_id)
);

-- ---------------------------------------------------------------------------
-- Meal slots and lifecycle
-- ---------------------------------------------------------------------------
CREATE TYPE meal_slot_status AS ENUM (
  'DRAFT', 'OPEN', 'LOCKED', 'FORECAST_READY', 'APPROVED',
  'IN_SERVICE', 'SERVICE_CLOSED', 'RECONCILED', 'CANCELLED'
);

CREATE TABLE meal_slots (
  id                  BIGSERIAL PRIMARY KEY,
  institution_id      BIGINT NOT NULL,
  mess_id             BIGINT NOT NULL,
  meal_type_id        BIGINT NOT NULL,
  service_date        DATE NOT NULL,
  voting_opens_at     TIMESTAMPTZ NOT NULL,
  voting_closes_at    TIMESTAMPTZ NOT NULL,
  service_starts_at   TIMESTAMPTZ NOT NULL,
  service_ends_at     TIMESTAMPTZ NOT NULL,
  status              meal_slot_status NOT NULL DEFAULT 'DRAFT',
  notes               TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  is_special_event    BOOLEAN NOT NULL DEFAULT FALSE,
  is_exam_period      BOOLEAN NOT NULL DEFAULT FALSE,
  is_holiday          BOOLEAN NOT NULL DEFAULT FALSE,
  created_by          BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at        TIMESTAMPTZ,
  locked_at           TIMESTAMPTZ,
  service_started_at  TIMESTAMPTZ,
  service_closed_at   TIMESTAMPTZ,
  reconciled_at       TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id),
  FOREIGN KEY (meal_type_id, institution_id) REFERENCES meal_types(id, institution_id),
  CHECK (voting_opens_at < voting_closes_at),
  CHECK (voting_closes_at <= service_starts_at),
  CHECK (service_starts_at < service_ends_at),
  CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX meal_slots_one_active_per_meal
  ON meal_slots (mess_id, service_date, meal_type_id) WHERE status <> 'CANCELLED';
CREATE INDEX meal_slots_mess_date_idx ON meal_slots (mess_id, service_date);
CREATE INDEX meal_slots_status_idx ON meal_slots (status, voting_closes_at);
CREATE TRIGGER meal_slots_updated BEFORE UPDATE ON meal_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meal_slot_menu_items (
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
  dish_id          BIGINT NOT NULL REFERENCES dishes(id),
  uptake_fraction  NUMERIC(4,3) NOT NULL DEFAULT 1 CHECK (uptake_fraction > 0 AND uptake_fraction <= 1),
  sort_order       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (meal_slot_id, dish_id)
);

-- ---------------------------------------------------------------------------
-- Voting
-- ---------------------------------------------------------------------------
CREATE TYPE vote_intent AS ENUM ('YES', 'NO');
CREATE TYPE cutoff_intent AS ENUM ('YES', 'NO', 'UNVOTED');

-- Current intention. Absence of a row means UNVOTED (never treated as NO).
CREATE TABLE votes (
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  intent           vote_intent NOT NULL,
  first_cast_at    TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  change_count     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (meal_slot_id, student_user_id)
);
CREATE INDEX votes_student_idx ON votes (student_user_id);

CREATE TABLE vote_events (
  id               BIGSERIAL PRIMARY KEY,
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  intent           vote_intent NOT NULL,
  previous_intent  vote_intent,
  recorded_at      TIMESTAMPTZ NOT NULL,
  request_id       TEXT
);
CREATE INDEX vote_events_slot_student_idx ON vote_events (meal_slot_id, student_user_id);
CREATE TRIGGER vote_events_append_only BEFORE UPDATE OR DELETE ON vote_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Stable, immutable record of every eligible student's intention at cutoff.
CREATE TABLE vote_snapshots (
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  intent           cutoff_intent NOT NULL,
  PRIMARY KEY (meal_slot_id, student_user_id)
);
CREATE TRIGGER vote_snapshots_append_only BEFORE UPDATE OR DELETE ON vote_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE cutoff_aggregates (
  meal_slot_id    BIGINT PRIMARY KEY REFERENCES meal_slots(id),
  eligible_count  INT NOT NULL CHECK (eligible_count >= 0),
  yes_count       INT NOT NULL CHECK (yes_count >= 0),
  no_count        INT NOT NULL CHECK (no_count >= 0),
  unvoted_count   INT NOT NULL CHECK (unvoted_count >= 0),
  locked_at       TIMESTAMPTZ NOT NULL,
  locked_by       BIGINT REFERENCES users(id),
  CHECK (yes_count + no_count + unvoted_count = eligible_count)
);
CREATE TRIGGER cutoff_aggregates_append_only BEFORE UPDATE OR DELETE ON cutoff_aggregates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Forecasting and preparation planning
-- ---------------------------------------------------------------------------
CREATE TABLE forecasts (
  id                      BIGSERIAL PRIMARY KEY,
  meal_slot_id            BIGINT NOT NULL REFERENCES meal_slots(id),
  version                 INT NOT NULL CHECK (version >= 1),
  method                  TEXT NOT NULL,
  model_version           TEXT NOT NULL,
  eligible_count          INT NOT NULL,
  yes_count               INT NOT NULL,
  no_count                INT NOT NULL,
  unvoted_count           INT NOT NULL,
  rate_yes                NUMERIC(6,5) NOT NULL CHECK (rate_yes BETWEEN 0 AND 1),
  rate_no                 NUMERIC(6,5) NOT NULL CHECK (rate_no BETWEEN 0 AND 1),
  rate_unvoted            NUMERIC(6,5) NOT NULL CHECK (rate_unvoted BETWEEN 0 AND 1),
  predicted_attendance    NUMERIC(10,2) NOT NULL CHECK (predicted_attendance >= 0),
  interval_low            NUMERIC(10,2),
  interval_high           NUMERIC(10,2),
  interval_level          NUMERIC(4,3),
  service_level           NUMERIC(4,3) NOT NULL,
  recommended_servings    INT NOT NULL CHECK (recommended_servings >= 0),
  safety_buffer_servings  INT NOT NULL CHECK (safety_buffer_servings >= 0),
  history_slot_count      INT NOT NULL,
  inputs                  JSONB NOT NULL,
  warnings                JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at            TIMESTAMPTZ NOT NULL,
  generated_by            BIGINT REFERENCES users(id),
  UNIQUE (meal_slot_id, version)
);
CREATE TRIGGER forecasts_append_only BEFORE UPDATE OR DELETE ON forecasts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE preparation_plans (
  meal_slot_id          BIGINT PRIMARY KEY REFERENCES meal_slots(id),
  forecast_id           BIGINT REFERENCES forecasts(id),
  recommended_servings  INT,
  approved_servings     INT NOT NULL CHECK (approved_servings >= 0),
  is_override           BOOLEAN NOT NULL,
  override_reason       TEXT,
  approved_by           BIGINT NOT NULL REFERENCES users(id),
  approved_at           TIMESTAMPTZ NOT NULL,
  CHECK (NOT is_override OR length(trim(coalesce(override_reason, ''))) >= 5)
);

-- Ingredient requirements frozen at approval so plans are reproducible.
CREATE TABLE plan_ingredient_requirements (
  meal_slot_id                 BIGINT NOT NULL REFERENCES preparation_plans(meal_slot_id),
  ingredient_id                BIGINT NOT NULL REFERENCES ingredients(id),
  required_qty                 NUMERIC(14,4) NOT NULL CHECK (required_qty >= 0),
  on_hand_qty                  NUMERIC(14,4),
  safety_stock_qty             NUMERIC(14,4),
  recommended_procurement_qty  NUMERIC(14,4),
  unit_cost                    NUMERIC(12,4),
  PRIMARY KEY (meal_slot_id, ingredient_id)
);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
CREATE TYPE inventory_txn_kind AS ENUM ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'SPOILAGE');

CREATE TABLE inventory_transactions (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL,
  mess_id         BIGINT NOT NULL,
  ingredient_id   BIGINT NOT NULL,
  kind            inventory_txn_kind NOT NULL,
  quantity        NUMERIC(14,4) NOT NULL,
  unit_cost       NUMERIC(12,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  meal_slot_id    BIGINT REFERENCES meal_slots(id),
  note            TEXT CHECK (note IS NULL OR length(note) <= 500),
  recorded_by     BIGINT NOT NULL REFERENCES users(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id),
  FOREIGN KEY (ingredient_id, institution_id) REFERENCES ingredients(id, institution_id),
  CHECK (
    (kind = 'RECEIPT' AND quantity > 0)
    OR (kind IN ('ISSUE', 'SPOILAGE') AND quantity < 0)
    OR (kind = 'ADJUSTMENT' AND quantity <> 0)
  )
);
CREATE INDEX inventory_mess_ingredient_idx ON inventory_transactions (mess_id, ingredient_id);
CREATE INDEX inventory_slot_idx ON inventory_transactions (meal_slot_id) WHERE meal_slot_id IS NOT NULL;
CREATE TRIGGER inventory_append_only BEFORE UPDATE OR DELETE ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE mess_ingredient_settings (
  mess_id           BIGINT NOT NULL REFERENCES messes(id),
  ingredient_id     BIGINT NOT NULL REFERENCES ingredients(id),
  safety_stock_qty  NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (safety_stock_qty >= 0),
  pack_size_qty     NUMERIC(14,4) CHECK (pack_size_qty IS NULL OR pack_size_qty > 0),
  min_order_qty     NUMERIC(14,4) CHECK (min_order_qty IS NULL OR min_order_qty > 0),
  PRIMARY KEY (mess_id, ingredient_id)
);

-- ---------------------------------------------------------------------------
-- Kitchen: preparation tasks, incidents, food & waste ledger
-- ---------------------------------------------------------------------------
CREATE TYPE prep_status AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');
CREATE TYPE measurement_kind AS ENUM ('MEASURED', 'ESTIMATED');

CREATE TABLE prep_tasks (
  id                    BIGSERIAL PRIMARY KEY,
  meal_slot_id          BIGINT NOT NULL REFERENCES meal_slots(id),
  dish_id               BIGINT NOT NULL REFERENCES dishes(id),
  planned_servings      INT NOT NULL CHECK (planned_servings >= 0),
  status                prep_status NOT NULL DEFAULT 'PENDING',
  prepared_kg           NUMERIC(10,3) CHECK (prepared_kg IS NULL OR (prepared_kg >= 0 AND prepared_kg <= 10000)),
  prepared_measurement  measurement_kind,
  deviation_note        TEXT CHECK (deviation_note IS NULL OR length(deviation_note) <= 1000),
  started_at            TIMESTAMPTZ,
  started_by            BIGINT REFERENCES users(id),
  completed_at          TIMESTAMPTZ,
  completed_by          BIGINT REFERENCES users(id),
  UNIQUE (meal_slot_id, dish_id),
  CHECK (status <> 'DONE' OR (prepared_kg IS NOT NULL AND prepared_measurement IS NOT NULL))
);

CREATE TYPE incident_kind AS ENUM ('SHORTAGE', 'SUBSTITUTION', 'DEVIATION', 'EQUIPMENT', 'QUALITY', 'OTHER');
CREATE TYPE incident_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE kitchen_incidents (
  id               BIGSERIAL PRIMARY KEY,
  institution_id   BIGINT NOT NULL,
  mess_id          BIGINT NOT NULL,
  meal_slot_id     BIGINT REFERENCES meal_slots(id),
  kind             incident_kind NOT NULL,
  ingredient_id    BIGINT REFERENCES ingredients(id),
  description      TEXT NOT NULL CHECK (length(description) BETWEEN 5 AND 1000),
  status           incident_status NOT NULL DEFAULT 'OPEN',
  reported_by      BIGINT NOT NULL REFERENCES users(id),
  reported_at      TIMESTAMPTZ NOT NULL,
  acknowledged_by  BIGINT REFERENCES users(id),
  acknowledged_at  TIMESTAMPTZ,
  resolved_by      BIGINT REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id)
);
CREATE INDEX kitchen_incidents_mess_idx ON kitchen_incidents (mess_id, status, reported_at DESC);

-- Food left over or wasted after service. Prepared quantities come from prep_tasks.
--   REUSABLE_SURPLUS   cooked, unserved, safe to repurpose
--   DISCARDED_SURPLUS  cooked, unserved, thrown away
--   PLATE_WASTE        served but left on plates
--   KITCHEN_WASTE      preparation losses (trimmings, spoilage during prep)
-- A missing category means "not recorded" — never zero.
CREATE TYPE food_log_category AS ENUM ('REUSABLE_SURPLUS', 'DISCARDED_SURPLUS', 'PLATE_WASTE', 'KITCHEN_WASTE');

CREATE TABLE food_logs (
  id            BIGSERIAL PRIMARY KEY,
  meal_slot_id  BIGINT NOT NULL REFERENCES meal_slots(id),
  dish_id       BIGINT REFERENCES dishes(id),
  category      food_log_category NOT NULL,
  quantity_kg   NUMERIC(10,3) NOT NULL CHECK (quantity_kg >= 0 AND quantity_kg <= 10000),
  measurement   measurement_kind NOT NULL,
  note          TEXT CHECK (note IS NULL OR length(note) <= 500),
  recorded_by   BIGINT NOT NULL REFERENCES users(id),
  recorded_at   TIMESTAMPTZ NOT NULL,
  voided_at     TIMESTAMPTZ,
  voided_by     BIGINT REFERENCES users(id),
  void_reason   TEXT,
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
CREATE INDEX food_logs_slot_idx ON food_logs (meal_slot_id) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- Attendance, reconciliation, warnings, appeals
-- ---------------------------------------------------------------------------
CREATE TYPE attendance_method AS ENUM ('ROLL_NUMBER', 'QR', 'MANUAL');
CREATE TYPE walk_in_basis AS ENUM ('NOT_WALK_IN', 'POLICY_PERMITTED', 'AUTHORIZED_EXCEPTION');

CREATE TABLE attendance_events (
  id               BIGSERIAL PRIMARY KEY,
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  intent           cutoff_intent NOT NULL,
  in_snapshot      BOOLEAN NOT NULL,
  walk_in          walk_in_basis NOT NULL,
  method           attendance_method NOT NULL,
  note             TEXT CHECK (note IS NULL OR length(note) <= 500),
  verified_by      BIGINT NOT NULL REFERENCES users(id),
  verified_at      TIMESTAMPTZ NOT NULL,
  voided_at        TIMESTAMPTZ,
  voided_by        BIGINT REFERENCES users(id),
  void_reason      TEXT,
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK (voided_at IS NULL OR void_reason IS NOT NULL),
  CHECK (walk_in <> 'AUTHORIZED_EXCEPTION' OR note IS NOT NULL)
);
-- At most one valid attendance per student per meal.
CREATE UNIQUE INDEX attendance_one_valid_per_slot ON attendance_events (meal_slot_id, student_user_id) WHERE voided_at IS NULL;
CREATE INDEX attendance_slot_idx ON attendance_events (meal_slot_id, verified_at DESC);

CREATE TYPE attendance_classification AS ENUM (
  'YES_ATTENDED', 'YES_NO_SHOW', 'NO_ABSENT', 'NO_WALK_IN',
  'UNVOTED_ATTENDED', 'UNVOTED_ABSENT', 'EXCUSED'
);

CREATE TABLE reconciliations (
  meal_slot_id       BIGINT PRIMARY KEY REFERENCES meal_slots(id),
  reconciled_at      TIMESTAMPTZ NOT NULL,
  reconciled_by      BIGINT NOT NULL REFERENCES users(id),
  actual_attendance  INT NOT NULL CHECK (actual_attendance >= 0),
  summary            JSONB NOT NULL
);

CREATE TABLE attendance_outcomes (
  meal_slot_id       BIGINT NOT NULL REFERENCES reconciliations(meal_slot_id),
  student_user_id    BIGINT NOT NULL REFERENCES student_profiles(user_id),
  intent             cutoff_intent NOT NULL,
  attended           BOOLEAN NOT NULL,
  classification     attendance_classification NOT NULL,
  excuse_reason      TEXT,
  corrected_at       TIMESTAMPTZ,
  corrected_by       BIGINT REFERENCES users(id),
  correction_reason  TEXT,
  PRIMARY KEY (meal_slot_id, student_user_id),
  CHECK (classification <> 'EXCUSED' OR excuse_reason IS NOT NULL)
);
CREATE INDEX attendance_outcomes_student_idx ON attendance_outcomes (student_user_id);

CREATE TYPE warning_status AS ENUM ('ACTIVE', 'APPEALED', 'UPHELD', 'WAIVED', 'VOIDED');

CREATE TABLE warnings (
  id               BIGSERIAL PRIMARY KEY,
  institution_id   BIGINT NOT NULL REFERENCES institutions(id),
  mess_id          BIGINT NOT NULL REFERENCES messes(id),
  meal_slot_id     BIGINT NOT NULL REFERENCES meal_slots(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  kind             TEXT NOT NULL DEFAULT 'NO_SHOW' CHECK (kind IN ('NO_SHOW')),
  tier             SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 3),
  reason           TEXT NOT NULL,
  status           warning_status NOT NULL DEFAULT 'ACTIVE',
  issued_at        TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Retried reconciliation can never issue a second warning for the same meal.
  UNIQUE (meal_slot_id, student_user_id, kind)
);
CREATE INDEX warnings_student_idx ON warnings (student_user_id, issued_at DESC);
CREATE INDEX warnings_mess_idx ON warnings (mess_id, status);
CREATE TRIGGER warnings_updated BEFORE UPDATE ON warnings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE appeal_status AS ENUM ('PENDING', 'UPHELD', 'WAIVED');

CREATE TABLE appeals (
  id               BIGSERIAL PRIMARY KEY,
  warning_id       BIGINT NOT NULL UNIQUE REFERENCES warnings(id),
  student_user_id  BIGINT NOT NULL REFERENCES student_profiles(user_id),
  reason           TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 2000),
  status           appeal_status NOT NULL DEFAULT 'PENDING',
  submitted_at     TIMESTAMPTZ NOT NULL,
  resolved_by      BIGINT REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  CHECK ((status = 'PENDING') = (resolved_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- Notifications (in-app inbox)
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  link        TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Analytics support
-- ---------------------------------------------------------------------------
-- A documented reference level of waste for a mess, entered by an
-- institution admin, against which observed change is reported.
CREATE TABLE waste_baselines (
  id                       BIGSERIAL PRIMARY KEY,
  institution_id           BIGINT NOT NULL,
  mess_id                  BIGINT NOT NULL,
  label                    TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 120),
  period_start             DATE NOT NULL,
  period_end               DATE NOT NULL,
  discarded_g_per_serving  NUMERIC(10,2) NOT NULL CHECK (discarded_g_per_serving >= 0),
  basis                    measurement_kind NOT NULL,
  source_note              TEXT NOT NULL CHECK (length(source_note) BETWEEN 5 AND 1000),
  created_by               BIGINT NOT NULL REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (mess_id, institution_id) REFERENCES messes(id, institution_id),
  CHECK (period_end >= period_start)
);
CREATE INDEX waste_baselines_mess_idx ON waste_baselines (mess_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT REFERENCES institutions(id),
  mess_id         BIGINT,
  actor_user_id   BIGINT REFERENCES users(id),
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  reason          TEXT,
  before_state    JSONB,
  after_state     JSONB,
  request_id      TEXT,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_institution_idx ON audit_events (institution_id, created_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
