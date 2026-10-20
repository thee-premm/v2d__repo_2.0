import { clock } from "../../src/lib/clock.js";
import { pool } from "../../src/config/db.js";

const TZ = "Asia/Kolkata";

/** 'YYYY-MM-DD' in the institution timezone, `offsetDays` from the (possibly shifted) server clock. */
export function localDate(offsetDays = 0) {
  const d = new Date(clock.now().getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Instant of a local wall-clock time, resolved by PostgreSQL (same conversion the API uses). */
export async function instantOf(date, time) {
  return (await pool.query(`SELECT ($1::date + $2::time) AT TIME ZONE $3 AS t`, [date, time, TZ])).rows[0].t;
}

/** Move the server clock to `minutesAfter` minutes past the given instant. */
export function advanceTo(instant, minutesAfter = 1) {
  const target = instant.getTime() + minutesAfter * 60_000;
  const delta = target - clock.now().getTime();
  if (delta > 0) clock.advance(delta);
}
