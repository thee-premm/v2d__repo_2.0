import { Router } from 'express';
import { notificationController } from '../controllers/notificationController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';
import { auditLogger } from '../middlewares/audit.js';

const router = Router();

// Retrieve logs (Student sees own logs, Supervisor/Admin sees all/filtered)
router.get('/logs', authenticate, notificationController.getLogs);

// Triggers & Workers (Supervisor/Admin only)
router.post('/trigger-pre-vote', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('TRIGGER_PRE_VOTE_NOTIFICATIONS'), notificationController.triggerPreVote);
router.post('/trigger-closing-alert', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('TRIGGER_CLOSING_ALERT_NOTIFICATIONS'), notificationController.triggerClosingAlert);
router.post('/process-queue', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('PROCESS_NOTIFICATION_QUEUE'), notificationController.processQueue);
router.post('/dispatch/:notificationId', authenticate, authorize('SUPERVISOR', 'ADMIN'), notificationController.dispatchSingle);

export default router;
