import pg from "pg";
import { env } from "./env.js";
import { logger } from "../lib/logger.js";

const { Pool, types } = pg;

// NUMERIC → JS number. Quantities (kg), rates and money here stay well within
// double precision; aggregation happens in SQL before conversion.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// BIGINT (ids, COUNT(*)) → number. Values stay far below 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE stays a 'YYYY-MM-DD' string: converting to Date would shift it by the server timezone.
types.setTypeParser(1082, (v) => v);

export function connectionConfig(database = env.db.database) {
  if (env.db.connectionString) {
    const url = new URL(env.db.connectionString);
    if (database !== env.db.database) url.pathname = `/${database}`;
    return { connectionString: url.toString(), ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined };
  }
  return {
    host: env.db.host,
    port: env.db.port,
    database,
    user: env.db.user,
    password: env.db.password,
    ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
  };
}

export const pool = new Pool({
  ...connectionConfig(),
  max: env.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "v2d-backend",
});

pool.on("error", (err) => logger.error("Idle PostgreSQL client error", err));

/** Run a parameterized query on the pool (or on `client` inside a transaction). */
export async function query(text, params = [], client = pool) {
  const started = performance.now();
  try {
    return await client.query(text, params);
  } finally {
    const ms = performance.now() - started;
    if (ms > 500) logger.warn("Slow query", { ms: Math.round(ms), sql: text.replace(/\s+/g, " ").slice(0, 160) });
  }
}

/**
 * Run `fn(client)` inside BEGIN/COMMIT. Rolls back on any error and rethrows.
 */
export async function withTransaction(fn, { isolation } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run independent queries concurrently on the pool, or one after another on a
 * transaction client (a single connection cannot run queries in parallel).
 */
export async function parallel(client, thunks) {
  if (!client || client === pool) return Promise.all(thunks.map((t) => t()));
  const out = [];
  for (const t of thunks) out.push(await t());
  return out;
}

export async function closePool() {
  await pool.end();
}
