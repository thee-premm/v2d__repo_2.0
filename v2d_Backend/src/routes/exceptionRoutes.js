import { Router } from 'express';
import { exceptionController } from '../controllers/exceptionController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';
import { auditLogger } from '../middlewares/audit.js';

const router = Router();

router.post('/reconcile-no-shows/:slotId', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('RECONCILE_NO_SHOWS'), exceptionController.reconcileNoShows);
router.post('/appeals/submit', authenticate, authorize('STUDENT'), auditLogger('SUBMIT_APPEAL'), exceptionController.submitAppeal);
router.post('/appeals/:id/resolve', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('RESOLVE_APPEAL'), exceptionController.resolveAppeal);
router.get('/penalties/me', authenticate, authorize('STUDENT'), exceptionController.getMyPenalties);

export default router;
