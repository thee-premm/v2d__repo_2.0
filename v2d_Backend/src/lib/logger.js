import { env } from "../config/env.js";
import { requestContext } from "./requestContext.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

// Keys whose values must never reach logs, regardless of nesting.
const SENSITIVE = /pass(word)?|secret|token|cookie|authorization|^code$|activation|csrf|hash/i;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[depth]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: env.isProduction ? undefined : value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function write(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const ctx = requestContext.get();
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...(meta === undefined ? {} : redact(meta instanceof Error ? { err: meta } : meta)),
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (env.isProduction) {
    stream.write(`${JSON.stringify(entry)}\n`);
  } else {
    const { time, level: lvl, msg: m, ...rest } = entry;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
    stream.write(`${time.slice(11, 23)} ${lvl.toUpperCase().padEnd(5)} ${m}${extra}\n`);
  }
}

export const logger = {
  debug: (msg, meta) => write("debug", msg, meta),
  info: (msg, meta) => write("info", msg, meta),
  warn: (msg, meta) => write("warn", msg, meta),
  error: (msg, meta) => write("error", msg, meta),
};
