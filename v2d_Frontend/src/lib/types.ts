export type Role = "STUDENT" | "SUPERVISOR" | "KITCHEN_STAFF" | "INSTITUTION_ADMIN";
export type SlotStatus = "DRAFT" | "OPEN" | "LOCKED" | "FORECAST_READY" | "APPROVED" | "IN_SERVICE" | "SERVICE_CLOSED" | "RECONCILED" | "CANCELLED";
export type Intent = "YES" | "NO" | "UNVOTED";
export type Measurement = "MEASURED" | "ESTIMATED";

export interface Session {
  user: { id: number; username: string; fullName: string; email: string | null };
  institution: { id: number; code: string; name: string; timezone: string; currency: string; isDemo: boolean };
  roles: Role[];
  activeRole: Role;
  scopes: { supervisorMessIds: number[]; kitchenMessIds: number[]; student: { userId: number; rollNumber: string; messId: number | null } | null };
  messes: { id: number; code: string; name: string; roles: Role[] }[];
  csrfToken: string;
}

export interface MenuItem {
  dishId: number;
  name: string;
  category: string | null;
  isVegetarian: boolean | null;
  portionGrams: number | null;
  uptakeFraction: number;
  hasRecipe: boolean;
}

export interface SlotBase {
  id: number;
  messId: number;
  messName: string;
  mealType: { id: number; code: string; name: string };
  serviceDate: string;
  votingOpensAt: string;
  votingClosesAt: string;
  serviceStartsAt: string;
  serviceEndsAt: string;
  status: SlotStatus;
  notes: string | null;
  flags: { specialEvent: boolean; examPeriod: boolean; holiday: boolean };
  cancelReason: string | null;
}

export interface SlotListItem extends SlotBase {
  menu: MenuItem[];
  summary: {
    snapshot: { eligible: number; yes: number; no: number; unvoted: number } | null;
    liveYes: number;
    liveNo: number;
    recommendedServings: number | null;
    approvedServings: number | null;
    attended: number;
  };
}

export interface Forecast {
  id: number;
  version: number;
  method: string;
  modelVersion: string;
  counts: { eligible: number; yes: number; no: number; unvoted: number };
  rates: { yes: number; no: number; unvoted: number };
  predictedAttendance: number;
  interval: { low: number; high: number; level: number } | null;
  serviceLevel: number;
  recommendedServings: number;
  safetyBufferServings: number;
  historySlotCount: number;
  inputs: any;
  warnings: { code: string; message: string }[];
  generatedAt: string;
  generatedBy: number | null;
}

export interface SlotDetail extends SlotBase {
  timezone: string;
  serverTime: string;
  menu: MenuItem[];
  votes: { source: "LIVE" | "CUTOFF_SNAPSHOT"; eligible: number; yes: number; no: number; unvoted: number; lockedAt?: string } | null;
  forecast: Forecast | null;
  plan: {
    approvedServings: number;
    recommendedServings: number | null;
    isOverride: boolean;
    overrideReason: string | null;
    approvedBy: string;
    approvedAt: string;
  } | null;
  attendance: { verified: number; walk_ins: number };
  reconciliation: { reconciledAt: string; actualAttendance: number; summary: any } | null;
  prep: Partial<Record<"PENDING" | "IN_PROGRESS" | "DONE", number>>;
  foodLogs: Partial<Record<string, number>>;
  actions: string[];
}

export interface StudentMeal {
  id: number;
  messName: string;
  mealType: { code: string; name: string };
  serviceDate: string;
  votingOpensAt: string;
  votingClosesAt: string;
  serviceStartsAt: string;
  serviceEndsAt: string;
  status: SlotStatus;
  notes: string | null;
  specialEvent: boolean;
  cancelReason: string | null;
  votingState: "OPEN" | "NOT_YET_OPEN" | "CLOSED" | "CANCELLED";
  myVote: "YES" | "NO" | null;
  myVoteUpdatedAt: string | null;
  intentAtCutoff: Intent | null;
  attendedAt: string | null;
  menu: { name: string; category: string | null; isVegetarian: boolean | null }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface MetricBlock {
  value: number | null;
  meals: number;
}
