import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { pool } from "./config/db.js";
import { AppError } from "./lib/errors.js";
import { send } from "./lib/http.js";
import { requestContextMiddleware } from "./middleware/requestContext.js";
import { sessionMiddleware } from "./middleware/session.js";
import { csrfProtection } from "./middleware/csrf.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { migrationStatus } from "./db/migrator.js";
import { schedulerStatus } from "./jobs/scheduler.js";
import { apiRouter } from "./routes.js";

async function readiness() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    const migrations = await migrationStatus(client);
    const pending = migrations.filter((m) => !m.applied).map((m) => m.name);
    return { database: "ok", pendingMigrations: pending };
  } finally {
    client.release();
  }
}

export function createApp() {
  const app = express();
  app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");

  app.use(requestContextMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  if (env.corsOrigins.length) app.use("/api", cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  // Liveness: process is up. Readiness: database reachable and schema current.
  const liveness = (req, res) => send(res, { status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  app.get("/health", liveness);
  app.get("/api/v1/health", liveness);
  app.get("/api/v1/health/ready", async (req, res) => {
    try {
      const r = await readiness();
      const ready = r.pendingMigrations.length === 0;
      res.status(ready ? 200 : 503).json({ success: ready, data: { ...r, scheduler: schedulerStatus() } });
    } catch {
      res.status(503).json({ success: false, data: { database: "unreachable" } });
    }
  });

  const api = express.Router();
  api.use(sessionMiddleware);
  api.use(csrfProtection);
  api.use(apiRouter);
  api.use((req, res, next) => next(new AppError(404, "ROUTE_NOT_FOUND", `No API route for ${req.method} ${req.path}`)));
  app.use("/api/v1", api);

  // Production: serve the built frontend from the same origin (no CORS, simple cookies).
  if (env.frontendDist && fs.existsSync(path.join(env.frontendDist, "index.html"))) {
    app.use("/assets", express.static(path.join(env.frontendDist, "assets"), { immutable: true, maxAge: "1y", index: false }));
    app.use(express.static(env.frontendDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(env.frontendDist, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}
