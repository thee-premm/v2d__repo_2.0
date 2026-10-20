import { env } from "./src/config/env.js";
import { pool, closePool } from "./src/config/db.js";
import { logger } from "./src/lib/logger.js";
import { createApp } from "./src/app.js";
import { startScheduler, stopScheduler } from "./src/jobs/scheduler.js";

if (env.appSecretIsEphemeral) {
  logger.warn("APP_SECRET is not set: using an ephemeral secret. Activation and reset codes stop working after a restart. Set APP_SECRET in .env.");
}

try {
  await pool.query("SELECT 1");
} catch (err) {
  logger.error(`Cannot reach PostgreSQL database "${env.db.database}". Run "npm run db:setup" and check DB_* settings.`, { code: err.code });
  process.exit(1);
}

const app = createApp();
const server = app.listen(env.port, () => {
  logger.info(`Vote2Dine API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  if (env.frontendDist) logger.info(`Serving frontend from ${env.frontendDist}`);
  if (env.schedulerEnabled) startScheduler();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  await stopScheduler();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error("Unhandled promise rejection", err));
