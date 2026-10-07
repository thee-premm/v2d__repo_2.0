import { forecastingService } from '../services/forecastingService.js';
import { successResponse, errorResponse } from '../utils/responses.js';

export const forecastingController = {
  async predictDemand(req, res, next) {
    try {
      const { mealSlotId, r, s } = req.query;
      if (!mealSlotId) {
        return errorResponse(res, 400, 'Query parameter mealSlotId is required');
      }

      const forecast = await forecastingService.generateForecastForSlot({
        mealSlotId: parseInt(mealSlotId, 10),
        perCapitaRequirementKg: r ? parseFloat(r) : 0.35,
        safetyMarginFactor: s ? parseFloat(s) : 0.05,
      });

      return successResponse(res, 200, 'AI Demand forecast generated successfully', forecast);
    } catch (error) {
      next(error);
    }
  },

  async getHistory(req, res, next) {
    try {
      const { messId, mealTypeId, isExamPeriod, limit } = req.query;
      if (!messId || !mealTypeId) {
        return errorResponse(res, 400, 'Query parameters messId and mealTypeId are required');
      }

      const history = await forecastingService.getHistoricalAttendanceData({
        messId: parseInt(messId, 10),
        mealTypeId: parseInt(mealTypeId, 10),
        isExamPeriod: isExamPeriod !== undefined ? isExamPeriod === 'true' : null,
        limit: limit ? parseInt(limit, 10) : 60,
      });

      return successResponse(res, 200, 'Historical attendance data retrieved', { history, count: history.length });
    } catch (error) {
      next(error);
    }
  }
};
