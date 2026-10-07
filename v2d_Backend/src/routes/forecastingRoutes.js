import { Router } from 'express';
import { forecastingController } from '../controllers/forecastingController.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize } from '../middlewares/rbac.js';

const router = Router();

// GET /api/v1/forecasting/predict?mealSlotId=X&r=0.35&s=0.05 (SUPERVISOR or ADMIN)
router.get('/predict', authenticate, authorize('SUPERVISOR', 'ADMIN'), forecastingController.predictDemand);

// GET /api/v1/forecasting/history?messId=X&mealTypeId=Y
router.get('/history', authenticate, authorize('SUPERVISOR', 'ADMIN'), forecastingController.getHistory);

export default router;
