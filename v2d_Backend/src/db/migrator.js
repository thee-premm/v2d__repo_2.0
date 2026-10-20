import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { backendRoot } from "../config/env.js";

export const MIGRATIONS_DIR = path.join(backendRoot, "migrations");
const LOCK_KEY = 482_031_9; // arbitrary constant for pg_advisory_lock

export async function loadMigrations() {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      return { version: file.slice(0, 3), name: file, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

async function ensureLedger(client) {
  // A pre-migration (legacy initDb.js) schema must not be silently mixed with this one.
  const legacy = await client.query(
    `SELECT to_regclass('public.penalties_and_appeals') IS NOT NULL AS legacy,
            to_regclass('public.schema_migrations') IS NOT NULL AS ledger`,
  );
  if (legacy.rows[0].legacy && !legacy.rows[0].ledger) {
    throw new Error(
      "This database contains the legacy V2D schema (created by the old scripts/initDb.js). " +
        "Point DB_NAME at a new, empty database; the legacy tables are not migrated automatically.",
    );
  }
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export async function migrationStatus(client) {
  await ensureLedger(client);
  const migrations = await loadMigrations();
  const applied = new Map((await client.query("SELECT version, name, checksum, applied_at FROM schema_migrations")).rows.map((r) => [r.version, r]));
  return migrations.map((m) => {
    const row = applied.get(m.version);
    return {
      version: m.version,
      name: m.name,
      applied: Boolean(row),
      appliedAt: row?.applied_at ?? null,
      checksumMismatch: Boolean(row && row.checksum !== m.checksum),
    };
  });
}

/**
 * Apply pending migrations in order, each in its own transaction, under a
 * session-level advisory lock so concurrent deploys cannot race.
 */
export async function migrate(client, { log = () => {} } = {}) {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const status = await migrationStatus(client);
    const drift = status.filter((s) => s.checksumMismatch);
    if (drift.length) {
      throw new Error(`Applied migrations were modified after being applied: ${drift.map((d) => d.name).join(", ")}. Add a new migration instead.`);
    }
    const migrations = await loadMigrations();
    const pending = migrations.filter((m) => !status.find((s) => s.version === m.version)?.applied);
    for (const m of pending) {
      log(`Applying ${m.name}`);
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        err.message = `${m.name}: ${err.message}`;
        throw err;
      }
    }
    return pending.map((m) => m.name);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
