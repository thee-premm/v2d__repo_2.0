/**
 * Formatting. Times are always rendered in the institution's timezone (from
 * the session), never the browser's, so a student travelling home still sees
 * the mess's cutoff correctly.
 */
let institutionTz = "Asia/Kolkata";
let institutionCurrency = "INR";
export function setInstitutionLocale(tz: string, currency: string) {
  institutionTz = tz;
  institutionCurrency = currency;
}
export const tz = () => institutionTz;

const LOCALE = "en-IN";
const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(opts) + institutionTz;
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(LOCALE, { timeZone: institutionTz, ...opts }));
  return cache.get(key)!;
}

export const MISSING = "—";

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return MISSING;
  return dtf({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return MISSING;
  return dtf({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
/** A service date ('YYYY-MM-DD', already local to the institution). */
export function fmtDate(date: string | null | undefined, style: "short" | "long" = "short") {
  if (!date) return MISSING;
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: style === "long" ? "long" : "short",
    ...(style === "long" ? { year: "numeric" } : {}),
  }).format(d);
}
/** Today's date in the institution timezone, as 'YYYY-MM-DD'. */
export function localToday(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: institutionTz }).format(d);
}
export function relativeDay(date: string) {
  if (date === localToday()) return "Today";
  if (date === localToday(1)) return "Tomorrow";
  if (date === localToday(-1)) return "Yesterday";
  return fmtDate(date);
}

/** "2 h 14 min" / "14 min" / "45 s" until `iso`, against a server-synced clock. */
export function fmtCountdown(ms: number) {
  if (ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min`;
  return `${s % 60} s`;
}

export function fmtNum(n: number | null | undefined, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return MISSING;
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}
export function fmtPct(n: number | null | undefined, digits = 1) {
  return n === null || n === undefined ? MISSING : `${fmtNum(n, digits)}%`;
}
export function fmtKg(n: number | null | undefined, digits = 1) {
  return n === null || n === undefined ? MISSING : `${fmtNum(n, digits)} kg`;
}
export function fmtMoney(n: number | null | undefined) {
  if (n === null || n === undefined) return MISSING;
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency: institutionCurrency, maximumFractionDigits: 0 }).format(n);
}
export function fmtSigned(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined) return MISSING;
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), digits)}`;
}

export const ROLE_LABEL: Record<string, string> = {
  STUDENT: "Student",
  SUPERVISOR: "Mess supervisor",
  KITCHEN_STAFF: "Kitchen",
  INSTITUTION_ADMIN: "Institution admin",
};
export const ROLE_HOME: Record<string, string> = {
  STUDENT: "/student",
  SUPERVISOR: "/supervisor",
  KITCHEN_STAFF: "/kitchen",
  INSTITUTION_ADMIN: "/admin",
};

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((p) => /[A-Za-z]/.test(p[0] ?? ""))
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Convert a local date + time to the "YYYY-MM-DDTHH:MM" the API expects for local datetimes. */
export function localDateTimeValue(iso: string) {
  const parts = dtf({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}
