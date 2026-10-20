import { env } from "../config/env.js";
import { pool, query, withTransaction } from "../config/db.js";
import { clock } from "../lib/clock.js";
import { logger } from "../lib/logger.js";
import { requestContext } from "../lib/requestContext.js";
import { slotSelect, getInstitution } from "../modules/org/context.js";
import { eligibleStudentsCte } from "../modules/meals/eligibility.js";
import { transitionToClosed, transitionToService } from "../modules/meals/meals.service.js";
import { processCutoff } from "../modules/forecasting/forecasting.service.js";
import { notifySupervisors } from "../modules/notifications/notify.js";

/**
 * Time-driven lifecycle work. Every step is idempotent (status checks under
 * row locks, deduplicated notifications), so a tick can be retried, run late,
 * or overlap a manual action without double effects. A PostgreSQL advisory
 * lock ensures only one API instance runs a tick at a time.
 */
const LOCK_KEY = 482_032_0;
const BATCH = 50;
let timer = null;
let running = null;
const status = { enabled: false, intervalSeconds: env.schedulerIntervalSeconds, lastTickAt: null, lastResult: null, lastError: null };

export function schedulerStatus() {
  return { ...status };
}

async function dueSlots(sql, params) {
  return (await query(`${slotSelect} WHERE ${sql} ORDER BY ms.id LIMIT ${BATCH}`, params)).rows;
}

async function safely(result, label, slotId, fn) {
  try {
    await fn();
    result[label] += 1;
  } catch (err) {
    result.errors.push({ job: label, slotId: Number(slotId), message: err.message });
    logger.error(`Scheduler ${label} failed`, { slotId, err });
  }
}

const settingsCache = new Map();
async function settingsFor(institutionId) {
  if (!settingsCache.has(institutionId)) settingsCache.set(institutionId, (await getInstitution(institutionId)).settings);
  return settingsCache.get(institutionId);
}

async function tickJobs() {
  const now = clock.now();
  const result = { locked: 0, serviceStarted: 0, serviceClosed: 0, votingOpenNotices: 0, closingReminders: 0, alerts: 0, errors: [] };
  settingsCache.clear();

  // 1. Cutoff: lock + snapshot + forecast.
  for (const s of await dueSlots(`ms.status = 'OPEN' AND ms.voting_closes_at <= $1`, [now])) {
    await safely(result, "locked", s.id, () => processCutoff(s.id));
  }

  // 2. Service opens at its scheduled start for approved meals.
  for (const s of await dueSlots(`ms.status = 'APPROVED' AND ms.service_starts_at <= $1`, [now])) {
    await safely(result, "serviceStarted", s.id, () =>
      withTransaction(async (client) => {
        const row = (await query(`SELECT status FROM meal_slots WHERE id = $1 FOR UPDATE`, [s.id], client)).rows[0];
        if (row.status === "APPROVED") await transitionToService(client, s);
      }),
    );
  }

  // 3. Service closes at its scheduled end.
  for (const s of await dueSlots(`ms.status = 'IN_SERVICE' AND ms.service_ends_at <= $1`, [now])) {
    await safely(result, "serviceClosed", s.id, () =>
      withTransaction(async (client) => {
        const row = (await query(`SELECT status FROM meal_slots WHERE id = $1 FOR UPDATE`, [s.id], client)).rows[0];
        if (row.status === "IN_SERVICE") await transitionToClosed(client, s);
      }),
    );
  }

  // 4. "Voting is open" notice, once per student, for slots that opened in the last 24 h.
  for (const s of await dueSlots(`ms.status = 'OPEN' AND ms.voting_opens_at <= $1 AND ms.voting_opens_at > $1::timestamptz - interval '24 hours' AND ms.voting_closes_at > $1`, [now])) {
    await safely(result, "votingOpenNotices", s.id, () =>
      query(
        `INSERT INTO notifications (user_id, kind, title, body, link, data, dedupe_key)
         SELECT e.student_user_id, 'VOTING_OPEN', $3, $4, '/student/meals', jsonb_build_object('slotId', $5::bigint), 'vote-open:' || $5 || ':' || e.student_user_id
           FROM (${eligibleStudentsCte("$1", "$2::date")}) e
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [s.mess_id, s.service_date, `Vote for ${s.meal_type_name}, ${s.service_date}`, "Let the kitchen know whether you will eat. You can change your answer until the cutoff.", s.id],
      ),
    );
  }

  // 5. Closing reminder to students who have not voted.
  for (const s of await dueSlots(`ms.status = 'OPEN' AND ms.voting_opens_at <= $1 AND ms.voting_closes_at > $1`, [now])) {
    const settings = await settingsFor(Number(s.institution_id));
    const remindAt = new Date(s.voting_closes_at.getTime() - settings.notifications.closingReminderMinutes * 60_000);
    if (now < remindAt) continue;
    await safely(result, "closingReminders", s.id, () =>
      query(
        `INSERT INTO notifications (user_id, kind, title, body, link, data, dedupe_key)
         SELECT e.student_user_id, 'VOTING_CLOSING', $3, $4, '/student/meals', jsonb_build_object('slotId', $5::bigint), 'vote-closing:' || $5 || ':' || e.student_user_id
           FROM (${eligibleStudentsCte("$1", "$2::date")}) e
          WHERE NOT EXISTS (SELECT 1 FROM votes v WHERE v.meal_slot_id = $5 AND v.student_user_id = e.student_user_id)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [s.mess_id, s.service_date, `Voting for ${s.meal_type_name} closes soon`, "You have not voted yet. If you don't vote, the kitchen has to guess.", s.id],
      ),
    );
  }

  // 6. Supervisor alerts: unapproved meals close to service; drafts whose cutoff is near.
  for (const s of await dueSlots(`ms.status IN ('LOCKED', 'FORECAST_READY') AND ms.service_starts_at <= $1::timestamptz + interval '90 minutes'`, [now])) {
    await safely(result, "alerts", s.id, () =>
      withTransaction((client) =>
        notifySupervisors(client, s.mess_id, {
          kind: "APPROVAL_NEEDED",
          title: `Approve a target: ${s.meal_type_name} starts soon`,
          body: "Service cannot open until a preparation target is approved.",
          link: `/supervisor/meals/${s.id}`,
          dedupeKey: `approval-needed:${s.id}`,
        }),
      ),
    );
  }
  for (const s of await dueSlots(`ms.status = 'DRAFT' AND ms.voting_closes_at <= $1::timestamptz + interval '6 hours' AND ms.voting_closes_at > $1`, [now])) {
    await safely(result, "alerts", s.id, () =>
      withTransaction((client) =>
        notifySupervisors(client, s.mess_id, {
          kind: "DRAFT_NOT_PUBLISHED",
          title: `${s.meal_type_name}, ${s.service_date} is still a draft`,
          body: "Students cannot vote until it is published, and its cutoff is within 6 hours.",
          link: `/supervisor/meals/${s.id}`,
          dedupeKey: `draft-unpublished:${s.id}`,
        }),
      ),
    );
  }
  return result;
}

/** Run one tick now (used by the interval timer and by tests). */
export async function runSchedulerTick() {
  if (running) return running;
  running = requestContext.run({ requestId: `scheduler-${Date.now()}` }, async () => {
    const client = await pool.connect();
    try {
      const got = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0].ok;
      if (!got) return { skipped: "ANOTHER_INSTANCE_RUNNING" };
      try {
        const result = await tickJobs();
        status.lastTickAt = clock.now();
        status.lastResult = result;
        status.lastError = null;
        const did = Object.entries(result).filter(([k, v]) => k !== "errors" && v > 0);
        if (did.length || result.errors.length) logger.info("Scheduler tick", result);
        return result;
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (err) {
      status.lastError = err.message;
      logger.error("Scheduler tick failed", err);
      return { error: err.message };
    } finally {
      client.release();
      running = null;
    }
  });
  return running;
}

export function startScheduler() {
  if (timer) return;
  status.enabled = true;
  timer = setInterval(runSchedulerTick, env.schedulerIntervalSeconds * 1000);
  timer.unref();
  runSchedulerTick();
  logger.info(`Scheduler started (every ${env.schedulerIntervalSeconds}s)`);
}

export async function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  status.enabled = false;
  if (running) await running;
}
