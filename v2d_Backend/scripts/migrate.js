#!/usr/bin/env node
// Usage: npm run db:migrate            apply pending migrations
//        npm run db:status             list migrations and whether they are applied
import pg from "pg";
import { env } from "../src/config/env.js";
import { connectionConfig } from "../src/config/db.js";
import { migrate, migrationStatus } from "../src/db/migrator.js";

const client = new pg.Client(connectionConfig());
try {
  await client.connect();
  if (process.argv.includes("--status")) {
    const rows = await migrationStatus(client);
    for (const r of rows) {
      console.log(`${r.applied ? "applied " : "pending "} ${r.name}${r.checksumMismatch ? "  (MODIFIED AFTER APPLY)" : ""}`);
    }
  } else {
    const applied = await migrate(client, { log: (m) => console.log(m) });
    console.log(applied.length ? `Applied ${applied.length} migration(s) to "${env.db.database}".` : `"${env.db.database}" is up to date.`);
  }
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
