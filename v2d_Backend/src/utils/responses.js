/**
 * Standardized Response Envelope Generator
 */

export const successResponse = (res, statusCode = 200, message = 'Operation successful', data = null, meta = {}) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  });
};

export const errorResponse = (res, statusCode = 500, message = 'An unexpected error occurred', errors = null) => {
  return res.status(statusCode).json({
    success: false,
    message,
    errors: errors ? (Array.isArray(errors) ? errors : [errors]) : undefined,
    meta: {
      timestamp: new Date().toISOString()
    }
  });
};
