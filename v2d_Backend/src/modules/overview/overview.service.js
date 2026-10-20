import { query } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { can } from "../../domain/permissions.js";
import { assertAdmin, getInstitution, loadMess } from "../org/context.js";
import { listSlots } from "../meals/meals.service.js";

async function localDate(tz, offsetDays = 0) {
  return (await query(`SELECT (($1::timestamptz AT TIME ZONE $2)::date + $3::int)::text AS d`, [clock.now(), tz, offsetDays])).rows[0].d;
}

/** Supervisor's operational day: today's meals and everything waiting on them. */
export async function messOverview(principal, messId, { date }) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const inst = await getInstitution(principal.institutionId);
  const day = date ?? (await localDate(inst.timezone));
  const horizon = await localDate(inst.timezone, 2);
  const now = clock.now();
  const [today, upcoming, pending] = await Promise.all([
    listSlots(principal, mess.id, { from: day, to: day }),
    listSlots(principal, mess.id, { from: await localDate(inst.timezone, 1), to: horizon }),
    query(
      `SELECT
         (SELECT count(*) FROM appeals a JOIN warnings w ON w.id = a.warning_id WHERE w.mess_id = $1 AND a.status = 'PENDING')::int AS pending_appeals,
         (SELECT count(*) FROM kitchen_incidents k WHERE k.mess_id = $1 AND k.status <> 'RESOLVED')::int AS open_incidents,
         (SELECT json_agg(json_build_object('id', ms.id, 'serviceDate', ms.service_date, 'mealType', mt.name) ORDER BY ms.service_date)
            FROM meal_slots ms JOIN meal_types mt ON mt.id = ms.meal_type_id WHERE ms.mess_id = $1 AND ms.status = 'SERVICE_CLOSED') AS awaiting_reconciliation,
         (SELECT json_agg(json_build_object('id', ms.id, 'serviceDate', ms.service_date, 'mealType', mt.name, 'serviceStartsAt', ms.service_starts_at) ORDER BY ms.service_starts_at)
            FROM meal_slots ms JOIN meal_types mt ON mt.id = ms.meal_type_id WHERE ms.mess_id = $1 AND ms.status IN ('LOCKED', 'FORECAST_READY')) AS awaiting_approval,
         (SELECT json_agg(json_build_object('id', ms.id, 'serviceDate', ms.service_date, 'mealType', mt.name, 'votingClosesAt', ms.voting_closes_at) ORDER BY ms.voting_closes_at)
            FROM meal_slots ms JOIN meal_types mt ON mt.id = ms.meal_type_id
           WHERE ms.mess_id = $1 AND ms.status = 'DRAFT' AND ms.voting_closes_at < $2::timestamptz + interval '48 hours') AS unpublished_soon`,
      [mess.id, now],
    ),
  ]);
  const p = pending.rows[0];
  return {
    mess: { id: Number(mess.id), name: mess.name, code: mess.code },
    date: day,
    timezone: inst.timezone,
    serverTime: now,
    today,
    upcoming,
    attention: {
      pendingAppeals: p.pending_appeals,
      openIncidents: p.open_incidents,
      awaitingReconciliation: p.awaiting_reconciliation ?? [],
      awaitingApproval: p.awaiting_approval ?? [],
      unpublishedSoon: p.unpublished_soon ?? [],
    },
  };
}

/** Institution admin's view across every mess. */
export async function institutionOverview(principal) {
  assertAdmin(principal);
  const inst = await getInstitution(principal.institutionId);
  const today = await localDate(inst.timezone);
  const weekAgo = await localDate(inst.timezone, -7);
  const [messes, users, exceptions, quality] = await Promise.all([
    query(
      `SELECT m.id, m.code, m.name, m.is_active,
              (SELECT count(*) FROM mess_memberships mm WHERE mm.mess_id = m.id AND mm.valid_to IS NULL)::int AS members,
              (SELECT json_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM meal_slots WHERE mess_id = m.id AND service_date = $2 GROUP BY status) s) AS today_by_status,
              (SELECT round(100.0 * sum(ca.yes_count + ca.no_count) / nullif(sum(ca.eligible_count), 0), 1)
                 FROM cutoff_aggregates ca JOIN meal_slots ms ON ms.id = ca.meal_slot_id WHERE ms.mess_id = m.id AND ms.service_date BETWEEN $3 AND $2) AS participation_7d,
              (SELECT count(*) FROM role_assignments ra WHERE ra.mess_id = m.id AND ra.role = 'SUPERVISOR' AND ra.revoked_at IS NULL)::int AS supervisors
         FROM messes m WHERE m.institution_id = $1 ORDER BY m.name`,
      [principal.institutionId, today, weekAgo],
    ),
    query(
      `SELECT ra.role, u.status, count(DISTINCT u.id)::int AS n
         FROM users u JOIN role_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
        WHERE u.institution_id = $1 GROUP BY ra.role, u.status`,
      [principal.institutionId],
    ),
    query(
      `SELECT
         (SELECT count(*) FROM kitchen_incidents WHERE institution_id = $1 AND status <> 'RESOLVED')::int AS open_incidents,
         (SELECT count(*) FROM appeals a JOIN warnings w ON w.id = a.warning_id WHERE w.institution_id = $1 AND a.status = 'PENDING')::int AS pending_appeals,
         (SELECT count(*) FROM meal_slots WHERE institution_id = $1 AND status = 'SERVICE_CLOSED' AND service_date < $2)::int AS stale_unreconciled,
         (SELECT count(*) FROM meal_slots WHERE institution_id = $1 AND status IN ('LOCKED', 'FORECAST_READY') AND service_starts_at < $3::timestamptz)::int AS started_without_approval,
         (SELECT count(*) FROM audit_events WHERE institution_id = $1 AND action IN ('plan.approved_override', 'plan.revised', 'outcome.corrected', 'attendance.walk_in_authorized', 'attendance.late_entry') AND created_at > $3::timestamptz - interval '7 days')::int AS sensitive_changes_7d`,
      [principal.institutionId, today, clock.now()],
    ),
    query(
      `SELECT m.id AS mess_id, count(ms.id)::int AS closed_meals,
              count(ms.id) FILTER (WHERE EXISTS (SELECT 1 FROM food_logs f WHERE f.meal_slot_id = ms.id AND f.voided_at IS NULL AND f.category = 'DISCARDED_SURPLUS')
                                    AND EXISTS (SELECT 1 FROM food_logs f WHERE f.meal_slot_id = ms.id AND f.voided_at IS NULL AND f.category = 'PLATE_WASTE'))::int AS waste_recorded,
              count(ms.id) FILTER (WHERE ms.status = 'RECONCILED')::int AS reconciled
         FROM messes m LEFT JOIN meal_slots ms ON ms.mess_id = m.id AND ms.status IN ('SERVICE_CLOSED', 'RECONCILED') AND ms.service_date BETWEEN $2 AND $3
        WHERE m.institution_id = $1 GROUP BY m.id`,
      [principal.institutionId, await localDate(inst.timezone, -30), today],
    ),
  ]);
  const qMap = new Map(quality.rows.map((q) => [Number(q.mess_id), q]));
  const roleCounts = {};
  for (const u of users.rows) {
    roleCounts[u.role] ??= { total: 0 };
    roleCounts[u.role][u.status] = u.n;
    roleCounts[u.role].total += u.n;
  }
  return {
    institution: { name: inst.name, timezone: inst.timezone },
    date: today,
    messes: messes.rows.map((m) => {
      const q = qMap.get(Number(m.id));
      return {
        id: Number(m.id),
        code: m.code,
        name: m.name,
        isActive: m.is_active,
        members: m.members,
        supervisors: m.supervisors,
        todayByStatus: m.today_by_status ?? {},
        participation7d: m.participation_7d,
        dataQuality30d: q
          ? { closedMeals: q.closed_meals, wasteRecorded: q.waste_recorded, reconciled: q.reconciled, wasteCompleteness: q.closed_meals ? Math.round((1000 * q.waste_recorded) / q.closed_meals) / 10 : null }
          : null,
      };
    }),
    accounts: roleCounts,
    exceptions: exceptions.rows[0],
  };
}

export async function listAudit(principal, { action, entityType, messId, actorId, from, to, limit, offset }) {
  assertAdmin(principal);
  const params = [principal.institutionId];
  const where = ["a.institution_id = $1"];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (action) add("a.action LIKE ?", `${action}%`);
  if (entityType) add("a.entity_type = ?", entityType);
  if (messId) add("a.mess_id = ?", messId);
  if (actorId) add("a.actor_user_id = ?", actorId);
  if (from) add("a.created_at >= ?::date", from);
  if (to) add("a.created_at < ?::date + 1", to);
  const total = (await query(`SELECT count(*)::int AS n FROM audit_events a WHERE ${where.join(" AND ")}`, params)).rows[0].n;
  params.push(limit, offset);
  const r = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.mess_id, m.name AS mess_name, a.reason, a.before_state, a.after_state, a.request_id, a.ip, a.created_at,
            u.full_name AS actor_name, u.username AS actor_username
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN messes m ON m.id = a.mess_id
      WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total,
    items: r.rows.map((a) => ({
      id: Number(a.id),
      action: a.action,
      entityType: a.entity_type,
      entityId: a.entity_id,
      mess: a.mess_id ? { id: Number(a.mess_id), name: a.mess_name } : null,
      actor: a.actor_name ? { name: a.actor_name, username: a.actor_username } : { name: "System", username: null },
      reason: a.reason,
      before: a.before_state,
      after: a.after_state,
      requestId: a.request_id,
      ip: a.ip,
      createdAt: a.created_at,
    })),
  };
}
