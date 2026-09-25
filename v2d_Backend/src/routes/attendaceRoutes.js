import { Router } from 'express';
import { attendanceController } from '../controllers/attendanceController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';
import { auditLogger } from '../middlewares/audit.js';

const router = Router();

router.post('/verify', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('VERIFY_ATTENDANCE'), attendanceController.verifyAttendance);
router.get('/slot/:slotId', authenticate, authorize('SUPERVISOR', 'ADMIN'), attendanceController.getAttendanceBySlot);

export default router;
