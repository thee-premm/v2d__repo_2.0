import pg from "pg";
import { env } from "../../src/config/env.js";
import { connectionConfig, pool } from "../../src/config/db.js";
import { migrate } from "../../src/db/migrator.js";
import { ensureDatabase } from "../../scripts/createDb.js";

let prepared = false;

/** Create + migrate the test database once per process. */
export async function prepareDatabase() {
  if (prepared) return;
  if (!env.db.database.endsWith("_test")) throw new Error("Not a test database");
  await ensureDatabase(env.db.database);
  const client = new pg.Client(connectionConfig());
  await client.connect();
  try {
    await migrate(client);
  } finally {
    await client.end();
  }
  prepared = true;
}

/** Empty every application table. Only ever runs against a *_test database. */
export async function resetDatabase() {
  if (!env.db.database.endsWith("_test")) throw new Error("Refusing to truncate a non-test database");
  const tables = (
    await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)
  ).rows.map((r) => `"${r.tablename}"`);
  if (tables.length) await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
}
