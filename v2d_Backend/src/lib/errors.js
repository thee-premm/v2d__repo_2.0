/**
 * Application error with a stable machine-readable code. Every error response
 * produced by the API is derived from one of these.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
export const validationFailed = (details) => new AppError(400, "VALIDATION_FAILED", "Some fields are invalid", details);
export const unauthenticated = (message = "Sign in to continue", code = "UNAUTHENTICATED") => new AppError(401, code, message);
export const forbidden = (message = "You do not have permission to perform this action") => new AppError(403, "FORBIDDEN", message);
// Used for scoped resources: we answer "not found" rather than "forbidden" so
// IDs from other messes/institutions cannot be probed for existence.
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message, code = "CONFLICT", details) => new AppError(409, code, message, details);
export const ruleViolation = (message, code = "RULE_VIOLATION", details) => new AppError(422, code, message, details);
export const tooManyRequests = (message = "Too many attempts. Try again later.", details) =>
  new AppError(429, "RATE_LIMITED", message, details);

/** Translate PostgreSQL errors into safe API errors (no SQL or constraint internals leak). */
export function fromDatabaseError(err) {
  switch (err.code) {
    case "23505":
      return conflict("This record already exists", "DUPLICATE", { constraint: err.constraint });
    case "23503":
      return badRequest("A referenced record does not exist");
    case "23514":
      return badRequest("A value violates a data rule", { constraint: err.constraint });
    case "22P02":
    case "22007":
    case "22008":
      return badRequest("A value has an invalid format");
    case "22003":
      return badRequest("A numeric value is out of range");
    case "P0001":
      return conflict("This record is locked and cannot be changed", "IMMUTABLE_RECORD");
    case "40001":
    case "40P01":
      return conflict("The operation conflicted with a concurrent change. Retry.", "CONCURRENT_UPDATE");
    default:
      return null;
  }
}
