import { Router } from "express";
import { voteController } from "../controllers/voteController.js";
import { authenticate } from "../middlewares/auth.js";
import { authorize } from "../middlewares/rbac.js";
import { auditLogger } from "../middlewares/audit.js";

const router = Router();

router.post(
  "/cast",
  authenticate,
  authorize("STUDENT"),
  auditLogger("CAST_VOTE"),
  voteController.castVote,
);

export default router;
