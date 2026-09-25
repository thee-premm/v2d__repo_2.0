import { Router } from 'express';
import { mealController } from '../controllers/mealController.js';
import { voteController } from '../controllers/voteController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';
import { auditLogger } from '../middlewares/audit.js';

const router = Router();

// Meal slot operations
router.post('/slots', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('CREATE_MEAL_SLOT'), mealController.createSlot);
router.get('/today', authenticate, mealController.getTodaySlots);
router.get('/slots/:id', authenticate, mealController.getSlotById);

// Daily Menu operations
router.get('/menus', authenticate, mealController.getMenus);

// Cutoff & Aggregate endpoint on meals
router.post('/:slotId/cutoff-aggregate', authenticate, authorize('SUPERVISOR', 'ADMIN'), auditLogger('CUTOFF_AGGREGATE_SLOT'), voteController.lockAndAggregate);
router.get('/:slotId/aggregates', authenticate, voteController.getAggregate);

export default router;
