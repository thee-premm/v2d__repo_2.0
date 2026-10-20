import { z } from "zod";
import { validationFailed } from "./errors.js";

/** Standard success envelope: { success: true, data, meta }. */
export function send(res, data, { status = 200, meta } = {}) {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

/** Parse `input` with a zod schema; throws a 400 with per-field messages on failure. */
export function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", message: i.message })),
    );
  }
  return result.data;
}

// Shared field schemas.
export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Invalid date");
export const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
export const reason = z.string().trim().min(5, "Give a reason of at least 5 characters").max(1000);
export const optionalText = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
