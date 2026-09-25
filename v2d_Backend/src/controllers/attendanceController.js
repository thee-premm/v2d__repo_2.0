import { attendanceService } from '../services/attendanceService.js';
import { successResponse } from '../utils/responses.js';

export const attendanceController = {
  async verifyAttendance(req, res, next) {
    try {
      const { roll_number, student_id, meal_slot_id, verification_method, supervisor_notes } = req.body;
      const verifiedByUserId = req.user.userId;

      const result = await attendanceService.verifyAttendance({
        rollNumber: roll_number,
        studentId: student_id,
        mealSlotId: meal_slot_id,
        verificationMethod: verification_method || 'ROLL_NUMBER',
        supervisorNotes: supervisor_notes,
        verifiedByUserId,
      });

      return successResponse(res, 200, `Attendance verified: ${result.classification}`, result);
    } catch (error) {
      next(error);
    }
  },

  async getAttendanceBySlot(req, res, next) {
    try {
      const { slotId } = req.params;
      const records = await attendanceService.getAttendanceRecordsForSlot(slotId);
      return successResponse(res, 200, 'Attendance records retrieved', records);
    } catch (error) {
      next(error);
    }
  }
};
