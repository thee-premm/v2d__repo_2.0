import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Building2 } from "lucide-react";
import { useMessScope } from "../../shell/messScope";
import { Empty } from "../../components/ui";
import type { SlotListItem, SlotStatus } from "../../lib/types";

/** Renders children with the current mess id, or an explanation when the user has none. */
export function WithMess({ children }: { children: (messId: number, messName: string) => ReactNode }) {
  const { messId, messName } = useMessScope();
  if (messId === null) {
    return (
      <div className="page">
        <Empty icon={<Building2 size={22} aria-hidden="true" />} title="No mess assigned">
          Your account doesn't have a mess yet. Ask your institution administrator to assign one.
        </Empty>
      </div>
    );
  }
  return <>{children(messId, messName)}</>;
}

/** The single next thing a supervisor should do with a meal. */
export function nextAction(s: { id: number; status: SlotStatus; votingClosesAt: string }, now = Date.now()): { label: string; to: string } | null {
  const base = `/supervisor/meals/${s.id}`;
  switch (s.status) {
    case "DRAFT":
      return { label: "Review & publish", to: base };
    case "OPEN":
      return new Date(s.votingClosesAt).getTime() <= now ? { label: "Close voting", to: base } : null;
    case "LOCKED":
    case "FORECAST_READY":
      return { label: "Approve target", to: base };
    case "IN_SERVICE":
      return { label: "Open counter", to: `/supervisor/counter?meal=${s.id}` };
    case "SERVICE_CLOSED":
      return { label: "Reconcile", to: `${base}/reconcile` };
    default:
      return null;
  }
}

export function NextActionLink({ slot }: { slot: SlotListItem }) {
  const a = nextAction(slot);
  if (!a) return null;
  return (
    <Link className="btn btn-sm btn-primary" to={a.to}>
      {a.label}
    </Link>
  );
}

export function votes(slot: SlotListItem) {
  if (slot.summary.snapshot) return slot.summary.snapshot;
  return null;
}
