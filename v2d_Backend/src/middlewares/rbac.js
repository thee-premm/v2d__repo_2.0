import { errorResponse } from "../utils/responses.js";

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 401, "Unauthorized access");
    }

    if (!roles.includes(req.user.role)) {
      return errorResponse(
        res,
        403,
        `Access forbidden: Role '${req.user.role}' is not authorized for this resource`,
      );
    }

    next();
  };
};
