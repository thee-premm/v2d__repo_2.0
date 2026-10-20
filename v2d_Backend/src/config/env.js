import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Values already present in process.env win over the .env file, so tests and
// deployments can override individual settings without editing .env.
dotenv.config({ path: path.join(backendRoot, ".env"), quiet: true });

const boolean = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),

  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]+$/, "DB_NAME may only contain letters, digits and _").default("v2d_db"),
  DB_USER: z.string().default("postgres"),
  DB_PASSWORD: z.string().optional(),
  DB_SSL: boolean.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  APP_SECRET: z.string().optional(),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.string().default("false"),
  COOKIE_SECURE: boolean.optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(12),

  SCHEDULER_ENABLED: boolean.optional(),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),

  MAIL_TRANSPORT: z.enum(["log", "disabled"]).optional(),
  FRONTEND_DIST: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  // Never echo the offending values: they may be secrets.
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}
const raw = parsed.data;
const isProduction = raw.NODE_ENV === "production";
const isTest = raw.NODE_ENV === "test";

const PLACEHOLDER_SECRETS = new Set(["change-me", "changeme", "secret", "replace-with-a-long-random-string"]);

function resolveAppSecret() {
  if (raw.APP_SECRET && raw.APP_SECRET.length >= 32 && !PLACEHOLDER_SECRETS.has(raw.APP_SECRET)) {
    return { value: raw.APP_SECRET, ephemeral: false };
  }
  if (isProduction) return { value: null, ephemeral: false };
  // Development/test only: an ephemeral random secret. Activation and reset
  // codes issued before a restart stop working; sessions are unaffected.
  return { value: crypto.randomBytes(48).toString("base64url"), ephemeral: true };
}
const appSecret = resolveAppSecret();

const productionProblems = [];
if (isProduction) {
  if (!appSecret.value) productionProblems.push("APP_SECRET must be set to a random value of at least 32 characters");
  if (!raw.DATABASE_URL && !raw.DB_PASSWORD) productionProblems.push("DATABASE_URL or DB_PASSWORD must be set");
  if (raw.COOKIE_SECURE === false) productionProblems.push("COOKIE_SECURE cannot be false in production");
  if (!raw.APP_ORIGIN.startsWith("https://")) productionProblems.push("APP_ORIGIN must be an https:// URL in production");
}
if (productionProblems.length) {
  console.error(`Refusing to start in production:\n${productionProblems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

function parseTrustProxy(value) {
  if (value === "false" || value === "") return false;
  if (value === "true") return true;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

const defaultDist = path.resolve(backendRoot, "../v2d_Frontend/dist");

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isTest,
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL ?? (isTest ? "warn" : isProduction ? "info" : "debug"),
  db: Object.freeze({
    connectionString: raw.DATABASE_URL,
    host: raw.DB_HOST,
    port: raw.DB_PORT,
    database: raw.DB_NAME,
    user: raw.DB_USER,
    password: raw.DB_PASSWORD,
    ssl: raw.DB_SSL ?? false,
    poolMax: raw.DB_POOL_MAX,
  }),
  appSecret: appSecret.value,
  appSecretIsEphemeral: appSecret.ephemeral,
  appOrigin: raw.APP_ORIGIN.replace(/\/$/, ""),
  corsOrigins: raw.CORS_ORIGINS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  trustProxy: parseTrustProxy(raw.TRUST_PROXY),
  cookieSecure: raw.COOKIE_SECURE ?? isProduction,
  sessionIdleMinutes: raw.SESSION_IDLE_MINUTES,
  sessionAbsoluteHours: raw.SESSION_ABSOLUTE_HOURS,
  schedulerEnabled: raw.SCHEDULER_ENABLED ?? !isTest,
  schedulerIntervalSeconds: raw.SCHEDULER_INTERVAL_SECONDS,
  mailTransport: raw.MAIL_TRANSPORT ?? (isProduction ? "disabled" : "log"),
  frontendDist: raw.FRONTEND_DIST ? path.resolve(backendRoot, raw.FRONTEND_DIST) : fs.existsSync(defaultDist) ? defaultDist : null,
});
