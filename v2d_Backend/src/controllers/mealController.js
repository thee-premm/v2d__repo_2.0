import { mealService } from "../services/mealService.js";
import { successResponse } from "../utils/responses.js";

export const mealController = {
  async createSlot(req, res, next) {
    try {
      const {
        mess_id,
        meal_type_id,
        slot_date,
        open_time,
        cutoff_time,
        meal_start_time,
        meal_end_time,
      } = req.body;
      const messId = mess_id || req.user.messId;
      const slot = await mealService.createMealSlot({
        messId,
        mealTypeId: meal_type_id,
        slotDate: slot_date,
        openTime: open_time,
        cutoffTime: cutoff_time,
        mealStartTime: meal_start_time,
        mealEndTime: meal_end_time,
      });
      return successResponse(res, 201, "Meal slot created successfully", slot);
    } catch (error) {
      next(error);
    }
  },

  async getTodaySlots(req, res, next) {
    try {
      const messId = req.query.messId || req.user.messId || 1;
      const studentId = req.user.studentId || null;
      const slots = await mealService.getTodayMealSlots(messId, studentId);
      return successResponse(res, 200, "Today meal slots retrieved", slots);
    } catch (error) {
      next(error);
    }
  },

  async getSlotById(req, res, next) {
    try {
      const { id } = req.params;
      const slot = await mealService.getMealSlotById(id);
      return successResponse(res, 200, "Meal slot retrieved", slot);
    } catch (error) {
      next(error);
    }
  },

  async getMenus(req, res, next) {
    try {
      const messId = req.query.messId || req.user.messId || 1;
      const date = req.query.date || new Date().toISOString().split("T")[0];
      const menus = await mealService.getMenuForMessAndDate(messId, date);
      return successResponse(res, 200, "Daily menus retrieved", menus);
    } catch (error) {
      next(error);
    }
  },
};
