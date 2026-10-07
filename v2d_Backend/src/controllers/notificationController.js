import { notificationService } from '../services/notificationService.js';
import { successResponse, errorResponse } from '../utils/responses.js';

export const notificationController = {
  async getLogs(req, res, next) {
    try {
      const { type, status, limit } = req.query;
      // If student, filter by their own user_id
      const userId = req.user.role === 'STUDENT' ? req.user.userId : req.query.userId;
      const logs = await notificationService.getNotificationLogs({
        userId,
        type,
        status,
        limit: limit ? parseInt(limit, 10) : 50,
      });
      return successResponse(res, 200, 'Notification logs retrieved successfully', { logs, count: logs.length });
    } catch (error) {
      next(error);
    }
  },

  async triggerPreVote(req, res, next) {
    try {
      const { mealSlotId } = req.body;
      if (!mealSlotId) {
        return errorResponse(res, 400, 'mealSlotId is required');
      }
      const result = await notificationService.triggerPreVoteReminders(mealSlotId);
      return successResponse(res, 200, 'Pre-vote reminders queued successfully', result);
    } catch (error) {
      next(error);
    }
  },

  async triggerClosingAlert(req, res, next) {
    try {
      const { mealSlotId, minutesRemaining } = req.body;
      if (!mealSlotId) {
        return errorResponse(res, 400, 'mealSlotId is required');
      }
      const result = await notificationService.triggerClosingAlerts(mealSlotId, minutesRemaining || 30);
      return successResponse(res, 200, 'Closing alerts queued successfully', result);
    } catch (error) {
      next(error);
    }
  },

  async processQueue(req, res, next) {
    try {
      const { batchSize } = req.body;
      const result = await notificationService.processQueue(batchSize ? parseInt(batchSize, 10) : 25);
      return successResponse(res, 200, 'Notification queue processed', result);
    } catch (error) {
      next(error);
    }
  },

  async dispatchSingle(req, res, next) {
    try {
      const { notificationId } = req.params;
      const result = await notificationService.dispatchNotification(notificationId);
      return successResponse(res, 200, 'Notification dispatch processed', result);
    } catch (error) {
      next(error);
    }
  }
};
