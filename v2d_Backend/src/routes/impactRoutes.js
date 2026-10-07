import { Router } from 'express';
import { impactController } from '../controllers/impactController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';
import { auditLogger } from '../middlewares/audit.js';

const router = Router();

// POST /api/v1/impact/waste-log (Supervisor or Admin)
router.post('/waste-log', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('LOG_KITCHEN_WASTE'), impactController.logWaste);

// GET /api/v1/impact/dashboard (Supervisor or Admin)
router.get('/dashboard', authenticate, authorize('SUPERVISOR', 'ADMIN'), impactController.getDashboard);

export default router;
