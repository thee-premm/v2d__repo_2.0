import { Router } from "express";
import { authController } from "../controllers/authController.js";
import { authenticate } from "../middlewares/auth.js";
import { auditLogger } from "../middlewares/audit.js";

const router = Router();

router.post("/register", auditLogger("USER_REGISTER"), authController.register);
router.post("/login", auditLogger("USER_LOGIN"), authController.login);
router.get("/me", authenticate, authController.me);
router.post(
  "/logout",
  authenticate,
  auditLogger("USER_LOGOUT"),
  authController.logout,
);

export default router;
