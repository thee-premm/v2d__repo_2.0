import { authService } from "../services/authService.js";
import { successResponse } from "../utils/responses.js";

export const authController = {
  async register(req, res, next) {
    try {
      const { username, email, password, role, hostelId, studentDetails } =
        req.body;
      const result = await authService.register({
        username,
        email,
        password,
        role,
        hostelId,
        studentDetails,
      });
      return successResponse(res, 201, "User registered successfully", result);
    } catch (error) {
      next(error);
    }
  },

  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      const result = await authService.login({ username, password });
      return successResponse(res, 200, "Login successful", result);
    } catch (error) {
      next(error);
    }
  },

  async me(req, res, next) {
    try {
      const userId = req.user.userId;
      const result = await authService.getMe(userId);
      return successResponse(
        res,
        200,
        "User context fetched successfully",
        result,
      );
    } catch (error) {
      next(error);
    }
  },

  async logout(req, res) {
    return successResponse(res, 200, "Logged out successfully");
  },
};
