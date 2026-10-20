import { AppError, fromDatabaseError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { requestContext } from "../lib/requestContext.js";

/** Single place that turns any thrown error into the JSON error contract. Never leaks stacks or SQL. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let appError = err instanceof AppError ? err : null;

  if (!appError && err?.type === "entity.parse.failed") appError = new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON");
  if (!appError && err?.type === "entity.too.large") appError = new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  if (!appError && typeof err?.code === "string") appError = fromDatabaseError(err);

  if (!appError) {
    logger.error("Unhandled error", { err, method: req.method, path: req.originalUrl.split("?")[0] });
    appError = new AppError(500, "INTERNAL_ERROR", "Something went wrong on our side. Try again.");
  } else if (appError.status >= 500) {
    logger.error("Server error", { err });
  }

  if (res.headersSent) return;
  res.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
    requestId: requestContext.get()?.requestId ?? req.ctx?.requestId,
  });
}
