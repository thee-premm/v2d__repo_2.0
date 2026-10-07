import { exceptionService } from '../services/exceptionService.js';
import { successResponse } from '../utils/responses.js';

export const exceptionController = {
  async reconcileNoShows(req, res, next) {
    try {
      const { slotId } = req.params;
      const result = await exceptionService.reconcileNoShows(slotId);
      return successResponse(res, 200, 'Batch no-show reconciliation completed successfully', result);
    } catch (error) {
      next(error);
    }
  },

  async submitAppeal(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const { meal_slot_id, violation_type, appeal_reason } = req.body;
      const result = await exceptionService.submitAppeal({
        studentId,
        mealSlotId: meal_slot_id,
        violationType: violation_type || 'NO_SHOW',
        appealReason: appeal_reason,
      });
      return successResponse(res, 201, 'Penalty appeal submitted successfully', result);
    } catch (error) {
      next(error);
    }
  },

  async resolveAppeal(req, res, next) {
    try {
      const { id } = req.params;
      const { status, resolution_notes } = req.body;
      const supervisorUserId = req.user.userId;
      const result = await exceptionService.resolveAppeal({
        penaltyId: id,
        status,
        resolutionNotes: resolution_notes,
        supervisorUserId,
      });
      return successResponse(res, 200, `Penalty appeal ${status.toLowerCase()} successfully`, result);
    } catch (error) {
      next(error);
    }
  },

  async getMyPenalties(req, res, next) {
    try {
      const studentId = req.user.studentId;
      const penalties = await exceptionService.getStudentPenalties(studentId);
      return successResponse(res, 200, 'Penalties and warnings retrieved', penalties);
    } catch (error) {
      next(error);
    }
  }
};
