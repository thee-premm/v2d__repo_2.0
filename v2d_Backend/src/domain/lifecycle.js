import { ruleViolation } from "../lib/errors.js";

/**
 * Meal slot lifecycle. Every status change goes through `assertTransition`.
 *
 *   DRAFT → OPEN → LOCKED → FORECAST_READY → APPROVED → IN_SERVICE → SERVICE_CLOSED → RECONCILED
 *     └──────┴───────┴────────────┴──────────────┴──→ CANCELLED   (only before service starts)
 *
 * LOCKED → APPROVED is allowed for a manual target when no forecast exists.
 */
export const SLOT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  OPEN: "OPEN",
  LOCKED: "LOCKED",
  FORECAST_READY: "FORECAST_READY",
  APPROVED: "APPROVED",
  IN_SERVICE: "IN_SERVICE",
  SERVICE_CLOSED: "SERVICE_CLOSED",
  RECONCILED: "RECONCILED",
  CANCELLED: "CANCELLED",
});

const TRANSITIONS = Object.freeze({
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["LOCKED", "CANCELLED"],
  LOCKED: ["FORECAST_READY", "APPROVED", "CANCELLED"],
  FORECAST_READY: ["FORECAST_READY", "APPROVED", "CANCELLED"],
  APPROVED: ["APPROVED", "IN_SERVICE", "CANCELLED"],
  IN_SERVICE: ["SERVICE_CLOSED"],
  SERVICE_CLOSED: ["RECONCILED"],
  RECONCILED: [],
  CANCELLED: [],
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw ruleViolation(`A meal in status ${from} cannot move to ${to}`, "INVALID_TRANSITION", { from, to });
  }
}

export function assertStatus(slot, allowed, action) {
  if (!allowed.includes(slot.status)) {
    throw ruleViolation(`Cannot ${action} while the meal is ${slot.status}`, "INVALID_STATE", {
      status: slot.status,
      allowed,
    });
  }
}

// States in which the menu may still change (the preparation plan is derived on approval).
export const MENU_EDITABLE = ["DRAFT", "OPEN", "LOCKED", "FORECAST_READY"];
// States visible to students.
export const STUDENT_VISIBLE = ["OPEN", "LOCKED", "FORECAST_READY", "APPROVED", "IN_SERVICE", "SERVICE_CLOSED", "RECONCILED", "CANCELLED"];
// States in which counter verification is accepted.
export const ATTENDANCE_OPEN = ["IN_SERVICE"];
// States in which food/waste may be logged.
export const FOOD_LOG_OPEN = ["APPROVED", "IN_SERVICE", "SERVICE_CLOSED", "RECONCILED"];
