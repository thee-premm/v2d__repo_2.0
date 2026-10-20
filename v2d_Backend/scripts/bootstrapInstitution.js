#!/usr/bin/env node
/**
 * Create a new institution with its first campus and an invited
 * administrator, and print the administrator's one-time activation code.
 * There is no public sign-up; this is the operator's entry point.
 *
 *   npm run bootstrap -- --code RIT --name "Riverside Institute" \
 *     --timezone Asia/Kolkata --currency INR \
 *     --admin-username it.admin --admin-name "IT Administrator" [--admin-email it.admin@example.edu]
 */
import { parseArgs } from "node:util";
import { env } from "../src/config/env.js";
import { pool, withTransaction } from "../src/config/db.js";
import { issueAccountCode } from "../src/modules/auth/auth.service.js";
import { recordAudit } from "../src/modules/audit/audit.service.js";

const { values: a } = parseArgs({
  options: {
    code: { type: "string" },
    name: { type: "string" },
    timezone: { type: "string", default: "Asia/Kolkata" },
    currency: { type: "string", default: "INR" },
    "campus-code": { type: "string", default: "MAIN" },
    "campus-name": { type: "string", default: "Main campus" },
    "admin-username": { type: "string" },
    "admin-name": { type: "string" },
    "admin-email": { type: "string" },
  },
});

const missing = ["code", "name", "admin-username", "admin-name"].filter((k) => !a[k]);
if (missing.length) {
  console.error(`Missing --${missing.join(", --")}`);
  process.exit(1);
}
if (env.appSecretIsEphemeral) {
  console.error("Set APP_SECRET first: activation codes are keyed with it and would stop working after a restart.");
  process.exit(1);
}

try {
  const tz = await pool.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [a.timezone]);
  if (!tz.rowCount) throw new Error(`Unknown timezone "${a.timezone}"`);
  const result = await withTransaction(async (client) => {
    const inst = (
      await client.query(`INSERT INTO institutions (code, name, timezone, currency) VALUES ($1, $2, $3, $4) RETURNING id`, [a.code.toUpperCase(), a.name, a.timezone, a.currency.toUpperCase()])
    ).rows[0];
    await client.query(`INSERT INTO campuses (institution_id, code, name) VALUES ($1, $2, $3)`, [inst.id, a["campus-code"].toUpperCase(), a["campus-name"]]);
    const user = (
      await client.query(`INSERT INTO users (institution_id, username, email, full_name, status) VALUES ($1, $2, $3, $4, 'INVITED') RETURNING id`, [
        inst.id,
        a["admin-username"].toLowerCase(),
        a["admin-email"]?.toLowerCase() ?? null,
        a["admin-name"],
      ])
    ).rows[0];
    await client.query(`INSERT INTO role_assignments (user_id, institution_id, role) VALUES ($1, $2, 'INSTITUTION_ADMIN')`, [user.id, inst.id]);
    await recordAudit(client, { institutionId: inst.id, action: "institution.bootstrapped", entityType: "institution", entityId: inst.id, after: { code: a.code, admin: a["admin-username"] } });
    return issueAccountCode(client, { userId: user.id, purpose: "ACTIVATION", ttlHours: 72 });
  });
  console.log(`Institution ${a.code.toUpperCase()} created in "${env.db.database}".`);
  console.log(`Administrator "${a["admin-username"].toLowerCase()}" activation code (shown once, expires ${result.expiresAt.toISOString()}):\n\n  ${result.code}\n`);
  console.log(`They activate at ${env.appOrigin}/activate and then add everyone else from the app.`);
} catch (err) {
  console.error(`Bootstrap failed: ${err.code === "23505" ? "that institution code, username or email already exists" : err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
