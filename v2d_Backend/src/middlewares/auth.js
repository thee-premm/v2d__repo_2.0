import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { errorResponse } from '../utils/responses.js';

export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse(res, 401, 'Authentication token missing or invalid format');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.JWT.secret);
    req.user = decoded; // { userId, username, role, hostelId, studentId, messId }
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return errorResponse(res, 401, 'Authentication token expired');
    }
    return errorResponse(res, 401, 'Invalid authentication token');
  }
};
