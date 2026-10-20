import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Check, Clock3, QrCode, X } from "lucide-react";
import { api, ApiError, errorMessage } from "../../lib/api";
import { fmtCountdown, fmtTime, relativeDay } from "../../lib/format";
import type { StudentMeal } from "../../lib/types";
import { Button, Dialog, ErrorNotice, IntentBadge, Loading, useToast } from "../../components/ui";

const CLOSED_COPY: Record<string, string> = {
  VOTING_CLOSED: "Voting for this meal has closed.",
  VOTING_NOT_OPEN: "Voting for this meal hasn't opened yet.",
  MEAL_CANCELLED: "This meal was cancelled.",
};

function MealPass({ meal, open, onClose }: { meal: StudentMeal; open: boolean; onClose: () => void }) {
  const [state, setState] = useState<{ img?: string; roll?: string; error?: unknown }>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({});
    api
      .get<{ token: string; rollNumber: string }>(`/me/meals/${meal.id}/pass`)
      .then(async (p) => {
        const img = await QRCode.toDataURL(p.token, { margin: 1, width: 280, errorCorrectionLevel: "M" });
        if (alive) setState({ img, roll: p.rollNumber });
      })
      .catch((error) => alive && setState({ error }));
    return () => {
      alive = false;
    };
  }, [open, meal.id]);
  return (
    <Dialog open={open} onClose={onClose} title={`Meal pass · ${meal.mealType.name}, ${relativeDay(meal.serviceDate)}`}>
      {state.error ? (
        <ErrorNotice error={state.error} />
      ) : !state.img ? (
        <Loading />
      ) : (
        <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
          <img src={state.img} width={240} height={240} alt="Meal pass QR code for the counter" style={{ imageRendering: "pixelated", background: "#fff", padding: 8, borderRadius: 4 }} />
          <div className="mono" style={{ fontSize: "var(--text-2xl)", letterSpacing: "0.06em" }}>
            {state.roll}
          </div>
          <p className="muted text-sm" style={{ maxWidth: "36ch" }}>
            Show this at the counter, or tell them your roll number. The pass identifies you; it doesn't override the mess's walk-in rules.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** One meal as a mess token: menu on the left, the vote stub on the right. */
export function MealToken({ meal, now }: { meal: StudentMeal; now: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [passOpen, setPassOpen] = useState(false);
  const closesIn = new Date(meal.votingClosesAt).getTime() - now;
  // The server decides; this only stops a doomed click after the countdown hits zero.
  const open = meal.votingState === "OPEN" && closesIn > 0;

  const vote = useMutation({
    mutationFn: (intent: "YES" | "NO") => api.put<{ intent: "YES" | "NO"; changed: boolean }>(`/me/meals/${meal.id}/vote`, { intent }),
    onSuccess: (res) => {
      qc.setQueryData<{ meals: StudentMeal[] } | undefined>(["student", "meals"], (old) =>
        old ? { ...old, meals: old.meals.map((m) => (m.id === meal.id ? { ...m, myVote: res.intent, myVoteUpdatedAt: new Date().toISOString() } : m)) } : old,
      );
      if (res.changed) toast(`Saved: you ${res.intent === "YES" ? "will eat" : "won't eat"} ${meal.mealType.name.toLowerCase()} ${relativeDay(meal.serviceDate).toLowerCase()}.`);
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : "";
      toast(CLOSED_COPY[code] ?? errorMessage(err), "error");
      qc.invalidateQueries({ queryKey: ["student", "meals"] });
    },
  });

  const state = meal.status === "CANCELLED" ? "muted" : meal.myVote === "YES" ? "yes" : meal.myVote === "NO" ? "no" : undefined;
  const pending = vote.isPending ? vote.variables : null;
  const passAvailable = ["LOCKED", "FORECAST_READY", "APPROVED", "IN_SERVICE"].includes(meal.status) && !meal.attendedAt;

  return (
    <article className="token" data-state={state} aria-labelledby={`meal-${meal.id}`}>
      <div className="token-main">
        <div className="token-meal">
          <h3 id={`meal-${meal.id}`}>{meal.mealType.name}</h3>
          <span className="token-time">
            {relativeDay(meal.serviceDate)} · {fmtTime(meal.serviceStartsAt)}–{fmtTime(meal.serviceEndsAt)}
          </span>
          {meal.specialEvent && <span className="badge badge-accent">Special</span>}
        </div>
        {meal.status === "CANCELLED" ? (
          <p style={{ marginTop: 10 }} className="muted">
            Cancelled{meal.cancelReason ? `: ${meal.cancelReason}` : ""}
          </p>
        ) : meal.menu.length ? (
          <ul className="menu-list" aria-label="Menu">
            {meal.menu.map((d) => (
              <li key={d.name}>
                {d.isVegetarian !== null && <span className={`veg-mark ${d.isVegetarian ? "" : "nonveg"}`} title={d.isVegetarian ? "Vegetarian" : "Non-vegetarian"} aria-label={d.isVegetarian ? "Vegetarian" : "Non-vegetarian"} />}
                {d.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm" style={{ marginTop: 10 }}>
            Menu not published yet.
          </p>
        )}
        {meal.notes && <p className="text-sm" style={{ marginTop: 10, color: "var(--accent-text)" }}>{meal.notes}</p>}
      </div>

      <div className="token-stub">
        {meal.status === "CANCELLED" ? (
          <span className="muted text-sm">No vote needed</span>
        ) : open || meal.votingState === "NOT_YET_OPEN" ? (
          <>
            <div className="row-between text-sm">
              <span className="strong">Will you eat?</span>
              {meal.votingState === "NOT_YET_OPEN" ? (
                <span className="muted">Opens {fmtTime(meal.votingOpensAt)}</span>
              ) : (
                <span className="countdown" style={{ color: closesIn < 3_600_000 ? "var(--warn-text)" : "var(--ink-3)" }} aria-label={`Voting closes in ${fmtCountdown(closesIn)}`}>
                  <Clock3 size={12} aria-hidden="true" style={{ verticalAlign: -1, marginRight: 4 }} />
                  {fmtCountdown(closesIn)}
                </span>
              )}
            </div>
            <div className="vote-choice" role="group" aria-label={`Vote for ${meal.mealType.name}`}>
              {(["YES", "NO"] as const).map((intent) => (
                <button
                  key={intent}
                  type="button"
                  className={`vote-btn ${intent.toLowerCase()}`}
                  aria-pressed={meal.myVote === intent}
                  disabled={!open || vote.isPending}
                  onClick={() => meal.myVote !== intent && vote.mutate(intent)}
                >
                  <span className="row" style={{ ["--gap" as string]: "6px" }}>
                    {pending === intent ? <span className="spinner" aria-hidden="true" /> : intent === "YES" ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
                    {intent === "YES" ? "Yes" : "No"}
                  </span>
                  <small>{intent === "YES" ? "I'll eat" : "Skip"}</small>
                </button>
              ))}
            </div>
            <span className="text-xs muted">{meal.myVote ? `You can change this until ${fmtTime(meal.votingClosesAt)}.` : `Not voted yet · closes ${fmtTime(meal.votingClosesAt)}`}</span>
          </>
        ) : (
          <>
            <span className="eyebrow">Your vote at cutoff</span>
            <div className="row">
              <IntentBadge intent={meal.intentAtCutoff ?? (meal.myVote ?? "UNVOTED")} />
              {meal.attendedAt && <span className="badge badge-ok">Ate at {fmtTime(meal.attendedAt)}</span>}
            </div>
            {passAvailable && (
              <Button size="sm" icon={<QrCode size={15} />} onClick={() => setPassOpen(true)}>
                Show meal pass
              </Button>
            )}
          </>
        )}
      </div>
      {passOpen && <MealPass meal={meal} open={passOpen} onClose={() => setPassOpen(false)} />}
    </article>
  );
}
