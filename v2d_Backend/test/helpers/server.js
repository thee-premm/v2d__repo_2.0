import { createApp } from "../../src/app.js";
import { closePool } from "../../src/config/db.js";
import { TestClient } from "./client.js";
import { prepareDatabase, resetDatabase } from "./db.js";
import { resetAllLimiters } from "../../src/middleware/rateLimit.js";
import { clock } from "../../src/lib/clock.js";

/**
 * Boots the real Express app on an ephemeral port against a clean test
 * database. Returns helpers to create clients and tear everything down.
 */
export async function startTestServer() {
  await prepareDatabase();
  await resetDatabase();
  resetAllLimiters();
  clock.reset();
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    client: () => new TestClient(baseUrl),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await closePool();
    },
  };
}
