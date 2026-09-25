import { logger } from '../utils/logger.js';
import { errorResponse } from '../utils/responses.js';

export const errorHandler = (err, req, res, next) => {
  logger.error(`[Global Error Handler] ${err.message}`, err);

  // PostgreSQL Error Code Handling
  if (err.code) {
    switch (err.code) {
      case '23505': // Unique violation
        return errorResponse(res, 409, 'Conflict: Resource or record already exists', err.detail);
      case '23503': // Foreign key violation
        return errorResponse(res, 400, 'Bad Request: Referenced entity does not exist', err.detail);
      case '23514': // Check constraint violation
        return errorResponse(res, 400, 'Bad Request: Data constraint violation', err.detail);
      case '22P02': // Invalid text representation
        return errorResponse(res, 400, 'Bad Request: Invalid data input type');
      default:
        break;
    }
  }

  // HTTP Custom Error Exception Status
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  return errorResponse(res, statusCode, message, err.errors || null);
};
