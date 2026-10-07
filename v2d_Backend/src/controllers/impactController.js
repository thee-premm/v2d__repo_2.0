import { impactService } from "../services/impactService.js";
import { successResponse, errorResponse } from "../utils/responses.js";

export const impactController = {
  async logWaste(req, res, next) {
    try {
      const {
        meal_slot_id,
        mealSlotId,
        cooked_mass_kg,
        cookedMassKg,
        consumed_mass_kg,
        consumedMassKg,
        discarded_mass_kg,
        discardedMassKg,
        unit_cost_per_kg,
        unitCostPerKg,
        baseline_waste_kg,
        baselineWasteKg,
      } = req.body;

      const targetSlotId = meal_slot_id || mealSlotId;
      if (!targetSlotId) {
        return errorResponse(res, 400, "meal_slot_id is required");
      }

      const result = await impactService.logKitchenWaste({
        mealSlotId: parseInt(targetSlotId, 10),
        cookedMassKg:
          cooked_mass_kg !== undefined ? cooked_mass_kg : cookedMassKg,
        consumedMassKg:
          consumed_mass_kg !== undefined ? consumed_mass_kg : consumedMassKg,
        discardedMassKg:
          discarded_mass_kg !== undefined ? discarded_mass_kg : discardedMassKg,
        unitCostPerKg:
          unit_cost_per_kg !== undefined ? unit_cost_per_kg : unitCostPerKg,
        baselineWasteKg:
          baseline_waste_kg !== undefined ? baseline_waste_kg : baselineWasteKg,
        loggedByUserId: req.user?.userId,
      });

      return successResponse(
        res,
        201,
        "Kitchen waste log recorded successfully",
        result,
      );
    } catch (error) {
      next(error);
    }
  },

  async getDashboard(req, res, next) {
    try {
      const { messId, startDate, endDate, limit } = req.query;
      const dashboard = await impactService.getImpactDashboard({
        messId: messId ? parseInt(messId, 10) : undefined,
        startDate,
        endDate,
        limit: limit ? parseInt(limit, 10) : 90,
      });

      return successResponse(
        res,
        200,
        "Impact & BI Analytics Dashboard retrieved successfully",
        dashboard,
      );
    } catch (error) {
      next(error);
    }
  },
};
