import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { BellOff, CheckCheck } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import type { Notification } from "../../lib/types";
import { Button, Empty, PageHeader, QueryState } from "../../components/ui";

export default function Notifications({ narrow = false }: { narrow?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "list"], queryFn: () => api.get<{ unreadCount: number; items: Notification[] }>("/me/notifications?limit=100") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const readAll = useMutation({ mutationFn: () => api.post("/me/notifications/read-all"), onSuccess: invalidate });
  const readOne = useMutation({ mutationFn: (id: number) => api.post(`/me/notifications/${id}/read`), onSuccess: invalidate });
  return (
    <div className={narrow ? "stack" : "page narrow"}>
      <PageHeader
        title="Notifications"
        subtitle={q.data ? `${q.data.unreadCount} unread` : undefined}
        actions={
          q.data && q.data.unreadCount > 0 ? (
            <Button size="sm" icon={<CheckCheck size={15} />} busy={readAll.isPending} onClick={() => readAll.mutate()}>
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <QueryState query={q}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty icon={<BellOff size={22} aria-hidden="true" />} title="You're all caught up">
              Reminders, schedule changes and decisions about your records will appear here.
            </Empty>
          ) : (
            <ul className="panel ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.items.map((n) => (
                <li key={n.id} style={{ padding: "14px 20px", background: n.readAt ? undefined : "color-mix(in srgb, var(--accent-soft) 40%, transparent)" }}>
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <div className="stack" style={{ ["--gap" as string]: "2px", minWidth: 0, flex: 1 }}>
                      <div className="row" style={{ ["--gap" as string]: "8px" }}>
                        {!n.readAt && <span className="badge badge-accent">New</span>}
                        <strong>{n.title}</strong>
                      </div>
                      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
                        {n.body}
                      </p>
                      <span className="text-xs muted">{fmtDateTime(n.createdAt)}</span>
                    </div>
                    <div className="row" style={{ ["--gap" as string]: "4px" }}>
                      {n.link && (
                        <Link className="btn btn-sm" to={n.link} onClick={() => !n.readAt && readOne.mutate(n.id)}>
                          Open
                        </Link>
                      )}
                      {!n.readAt && (
                        <Button size="sm" variant="ghost" onClick={() => readOne.mutate(n.id)} aria-label={`Mark "${n.title}" as read`}>
                          Mark read
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </div>
  );
}
