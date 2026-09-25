import { voteService } from "../services/voteService.js";
import { successResponse } from "../utils/responses.js";

export const voteController = {
  async castVote(req, res, next) {
    try {
      const studentId = req.user.studentId;
      if (!studentId) {
        return res.status(403).json({
          success: false,
          message: "Only registered students can cast votes",
        });
      }

      const { meal_slot_id, vote_status, vote_channel } = req.body;
      const vote = await voteService.castVote({
        studentId,
        mealSlotId: meal_slot_id,
        voteStatus: vote_status,
        voteChannel: vote_channel || "WEB_APP",
      });
      return successResponse(res, 200, "Vote recorded successfully", vote);
    } catch (error) {
      next(error);
    }
  },

  async lockAndAggregate(req, res, next) {
    try {
      const { slotId } = req.params;
      const result = await voteService.cutoffAndAggregateSlot(slotId);
      return successResponse(
        res,
        200,
        "Meal slot locked and demand aggregated successfully",
        result,
      );
    } catch (error) {
      next(error);
    }
  },

  async getAggregate(req, res, next) {
    try {
      const { slotId } = req.params;
      const aggregate = await voteService.getAggregateForSlot(slotId);
      return successResponse(res, 200, "Demand aggregate retrieved", aggregate);
    } catch (error) {
      next(error);
    }
  },
};
