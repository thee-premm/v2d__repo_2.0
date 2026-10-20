import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bell, ShieldAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useAuthed } from "../../lib/session";
import { fmtDateTime, relativeDay, tz } from "../../lib/format";
import { useServerNow } from "../../lib/useServerClock";
import type { Notification } from "../../lib/types";
import { Empty, IntentBadge, Loading, Notice, QueryState } from "../../components/ui";
import { MealToken } from "./MealToken";
import { useStudentMeals } from "./StudentMeals";
import type { HistoryItem } from "./StudentHistory";

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz() }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function StudentHome() {
  const session = useAuthed();
  const meals = useStudentMeals();
  const now = useServerNow(meals.data?.serverTime);
  const history = useQuery({ queryKey: ["student", "history", 0], queryFn: () => api.get<{ items: HistoryItem[]; total: number }>("/me/history?limit=5") });
  const warnings = useQuery({ queryKey: ["student", "warnings"], queryFn: () => api.get<{ items: { status: string; canAppeal: boolean }[] }>("/me/warnings") });
  const inbox = useQuery({ queryKey: ["notifications", "list", "home"], queryFn: () => api.get<{ unreadCount: number; items: Notification[] }>("/me/notifications?limit=3") });

  const upcoming = (meals.data?.meals ?? []).filter((m) => new Date(m.serviceEndsAt).getTime() > now && m.status !== "CANCELLED");
  const next = upcoming[0];
  const needVote = upcoming.filter((m) => m.votingState === "OPEN" && !m.myVote);
  const appealable = (warnings.data?.items ?? []).filter((w) => w.canAppeal).length;
  const activeWarnings = (warnings.data?.items ?? []).filter((w) => ["ACTIVE", "APPEALED"].includes(w.status)).length;

  return (
    <div className="stack" style={{ ["--gap" as string]: "28px" }}>
      <header className="stack" style={{ ["--gap" as string]: "4px" }}>
        <span className="eyebrow">{session.institution.name}</span>
        <h1>
          {greeting()}, {session.user.fullName.split(" ")[0]}
        </h1>
        <p className="muted">
          Roll <span className="mono">{session.scopes.student?.rollNumber}</span>
          {session.messes[0] && <> · {session.messes[0].name}</>}
        </p>
      </header>

      {activeWarnings > 0 && (
        <Notice
          tone="warn"
          title={`You have ${activeWarnings} open warning${activeWarnings === 1 ? "" : "s"}`}
          action={
            <Link to="/student/warnings" className="btn btn-sm">
              Review
            </Link>
          }
        >
          {appealable > 0 ? `${appealable} can still be appealed.` : "Warnings never carry fines; they help the mess plan fairly."}
        </Notice>
      )}

      <section className="section">
        <div className="section-title">
          <h2>Next meal</h2>
          {needVote.length > 1 && (
            <Link to="/student/meals" className="text-sm">
              {needVote.length} meals need your vote <ArrowRight size={13} style={{ verticalAlign: -2 }} />
            </Link>
          )}
        </div>
        <QueryState query={meals}>
          {() =>
            next ? (
              <MealToken meal={next} now={now} />
            ) : (
              <Empty title="Nothing scheduled">No upcoming meals are published for your mess yet.</Empty>
            )
          }
        </QueryState>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h3>Recent meals</h3>
            <Link to="/student/history" className="text-sm">
              All history
            </Link>
          </div>
          {history.isLoading ? (
            <div className="panel-body">
              <Loading />
            </div>
          ) : history.data?.items.length ? (
            <div className="ruled">
              {history.data.items.map((h) => (
                <div key={h.slotId} className="row-between" style={{ padding: "10px 20px" }}>
                  <div>
                    <div className="strong">{h.mealType.name}</div>
                    <div className="text-sm muted">{relativeDay(h.serviceDate)}</div>
                  </div>
                  <div className="row" style={{ ["--gap" as string]: "6px" }}>
                    <IntentBadge intent={h.intentAtCutoff} />
                    {h.status === "RECONCILED" || h.attended ? (
                      <span className={`badge ${h.attended ? "badge-ok" : "badge-outline"}`}>{h.attended ? "Ate" : "Didn't eat"}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-body muted text-sm">Your meals will appear here after voting closes.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>
              <Bell size={15} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" />
              Updates
            </h3>
            <Link to="/student/notifications" className="text-sm">
              Inbox{inbox.data?.unreadCount ? ` (${inbox.data.unreadCount} new)` : ""}
            </Link>
          </div>
          {inbox.isLoading ? (
            <div className="panel-body">
              <Loading />
            </div>
          ) : inbox.data?.items.length ? (
            <div className="ruled">
              {inbox.data.items.map((n) => (
                <div key={n.id} style={{ padding: "10px 20px" }}>
                  <div className="row" style={{ ["--gap" as string]: "8px" }}>
                    {!n.readAt && <span className="badge badge-accent">New</span>}
                    <span className="strong text-sm">{n.title}</span>
                  </div>
                  <div className="text-xs muted">{fmtDateTime(n.createdAt)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-body muted text-sm">No notifications yet.</div>
          )}
        </section>
      </div>

      {upcoming.length > 0 && (
        <p className="text-sm muted">
          <ShieldAlert size={13} style={{ verticalAlign: -2 }} aria-hidden="true" /> Voted yes but can't make it? Change your vote before the cutoff. After service, a yes vote without a counter record is reviewed as a possible no-show.
        </p>
      )}
    </div>
  );
}
