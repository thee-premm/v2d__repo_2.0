import { useQuery } from "@tanstack/react-query";
import { UtensilsCrossed } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, relativeDay } from "../../lib/format";
import { useServerNow } from "../../lib/useServerClock";
import type { StudentMeal } from "../../lib/types";
import { Empty, Notice, PageHeader, QueryState } from "../../components/ui";
import { MealToken } from "./MealToken";

export function useStudentMeals() {
  return useQuery({
    queryKey: ["student", "meals"],
    queryFn: () => api.get<{ timezone: string | null; serverTime: string; meals: StudentMeal[] }>("/me/meals?days=7"),
    refetchInterval: 60_000,
  });
}

export default function StudentMeals() {
  const q = useStudentMeals();
  const now = useServerNow(q.data?.serverTime);
  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      <PageHeader title="Meals this week" subtitle="Tell the kitchen whether you'll eat. Votes close before each meal; after that the kitchen cooks to the count." />
      <QueryState query={q} lines={6}>
        {(data) => {
          if (data.timezone === null) {
            return (
              <Notice tone="warn" title="You're not assigned to a mess">
                Your mess office needs to add you to a mess before you can vote.
              </Notice>
            );
          }
          const upcoming = data.meals.filter((m) => new Date(m.serviceEndsAt).getTime() > now - 3 * 3_600_000);
          if (!upcoming.length) {
            return (
              <Empty icon={<UtensilsCrossed size={22} aria-hidden="true" />} title="No meals published yet">
                Your mess hasn't published the coming meals. You'll get a notification when voting opens.
              </Empty>
            );
          }
          const days = [...new Set(upcoming.map((m) => m.serviceDate))];
          const needVote = upcoming.filter((m) => m.votingState === "OPEN" && !m.myVote).length;
          return (
            <div className="stack" style={{ ["--gap" as string]: "28px" }}>
              {needVote > 0 && (
                <Notice tone="info">
                  <strong>{needVote}</strong> meal{needVote === 1 ? "" : "s"} still need{needVote === 1 ? "s" : ""} your vote. Not voting isn't the same as "no" — the kitchen has to guess.
                </Notice>
              )}
              {days.map((d) => (
                <section key={d} className="stack" aria-label={fmtDate(d, "long")} style={{ ["--gap" as string]: "12px" }}>
                  <h2 className="eyebrow" style={{ fontSize: "var(--text-sm)" }}>
                    {relativeDay(d)} {relativeDay(d) !== fmtDate(d) && <span className="muted">· {fmtDate(d)}</span>}
                  </h2>
                  {upcoming
                    .filter((m) => m.serviceDate === d)
                    .map((m) => (
                      <MealToken key={m.id} meal={m} now={now} />
                    ))}
                </section>
              ))}
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
