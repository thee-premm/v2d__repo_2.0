import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldOff } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, fmtDateTime, localToday, ROLE_LABEL } from "../../lib/format";
import { useAuthed } from "../../lib/session";
import { Button, ConfirmDialog, Dialog, ErrorNotice, PageHeader, QueryState, SelectField, TextField, useToast } from "../../components/ui";
import { OneTimeCode } from "./OneTimeCode";
import { STATUS_TONE, useMesses } from "./Accounts";

interface Detail {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  rollNumber: string | null;
  roomNumber: string | null;
  roles: { id: number; role: string; messId: number | null; messName: string | null; grantedAt: string; revokedAt: string | null }[];
  memberships: { id: number; messId: number; messName: string; validFrom: string; validTo: string | null }[];
  pendingCodes: { purpose: string; expiresAt: string }[];
}

export default function AccountDetail() {
  const { userId } = useParams();
  const id = Number(userId);
  const me = useAuthed();
  const qc = useQueryClient();
  const toast = useToast();
  const messes = useMesses();
  const q = useQuery({ queryKey: ["admin", "user", id], queryFn: () => api.get<Detail>(`/admin/users/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin", "user", id] });
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };
  const [statusTo, setStatusTo] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Detail["roles"][number] | null>(null);
  const [granting, setGranting] = useState(false);
  const [grant, setGrant] = useState({ role: "SUPERVISOR", messId: "" });
  const [moving, setMoving] = useState(false);
  const [move, setMove] = useState({ messId: "", validFrom: localToday(1) });
  const code = useMutation({
    mutationFn: (purpose: "ACTIVATION" | "PASSWORD_RESET") => api.post<{ username: string; code: string; expiresAt: string }>(`/admin/users/${id}/codes`, { purpose }),
    onSuccess: refresh,
  });
  const grantM = useMutation({
    mutationFn: () => api.post(`/admin/users/${id}/roles`, { role: grant.role, messId: grant.role === "INSTITUTION_ADMIN" ? undefined : Number(grant.messId) }),
    onSuccess: () => {
      refresh();
      setGranting(false);
      toast("Role granted. It applies on their next request.");
    },
  });
  const moveM = useMutation({
    mutationFn: () => api.put(`/admin/users/${id}/membership`, { messId: Number(move.messId), validFrom: move.validFrom }),
    onSuccess: () => {
      refresh();
      setMoving(false);
      toast("Mess membership updated.");
    },
  });

  return (
    <div className="page">
      <QueryState query={q} lines={8}>
        {(u) => {
          const self = u.id === me.user.id;
          const activeRoles = u.roles.filter((r) => !r.revokedAt);
          return (
            <>
              <PageHeader
                back={{ to: "/admin/accounts", label: "People & access" }}
                title={u.fullName}
                subtitle={
                  <span className="row">
                    <span className="mono">{u.username}</span>
                    <span className={`badge badge-${STATUS_TONE[u.status]}`}>{u.status === "INVITED" ? "Not activated" : u.status.toLowerCase()}</span>
                  </span>
                }
                actions={
                  !self && (
                    <>
                      {u.status === "INVITED" && (
                        <Button icon={<KeyRound size={15} />} busy={code.isPending} onClick={() => code.mutate("ACTIVATION")}>
                          New activation code
                        </Button>
                      )}
                      {u.status === "ACTIVE" && (
                        <Button icon={<KeyRound size={15} />} busy={code.isPending} onClick={() => code.mutate("PASSWORD_RESET")}>
                          Issue reset code
                        </Button>
                      )}
                      {u.status === "ACTIVE" && <Button onClick={() => setStatusTo("SUSPENDED")}>Suspend</Button>}
                      {(u.status === "SUSPENDED" || u.status === "DEACTIVATED") && <Button onClick={() => setStatusTo("ACTIVE")}>Reactivate</Button>}
                      {u.status !== "DEACTIVATED" && (
                        <Button variant="danger" icon={<ShieldOff size={15} />} onClick={() => setStatusTo("DEACTIVATED")}>
                          Deactivate
                        </Button>
                      )}
                    </>
                  )
                }
              />
              <div className="split">
                <div className="stack" style={{ ["--gap" as string]: "20px" }}>
                  <section className="panel">
                    <div className="panel-head">
                      <h3>Access</h3>
                      {!self && (
                        <Button size="sm" icon={<Plus size={14} />} onClick={() => setGranting(true)}>
                          Grant role
                        </Button>
                      )}
                    </div>
                    <div className="table-wrap" style={{ border: 0 }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Role</th>
                            <th>Scope</th>
                            <th>Since</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {u.roles.map((r) => (
                            <tr key={r.id} style={{ opacity: r.revokedAt ? 0.55 : 1 }}>
                              <td>{ROLE_LABEL[r.role]}</td>
                              <td>{r.messName ?? (r.role === "INSTITUTION_ADMIN" ? "Whole institution" : "Own records")}</td>
                              <td className="text-sm">
                                {fmtDate(r.grantedAt.slice(0, 10))}
                                {r.revokedAt && <span className="muted"> → revoked {fmtDate(r.revokedAt.slice(0, 10))}</span>}
                              </td>
                              <td>
                                {!r.revokedAt && r.role !== "STUDENT" && !(self && r.role === "INSTITUTION_ADMIN") && (
                                  <Button size="sm" variant="ghost" onClick={() => setRevoking(r)}>
                                    Revoke
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  {u.rollNumber && (
                    <section className="panel">
                      <div className="panel-head">
                        <h3>Mess membership</h3>
                        <Button size="sm" onClick={() => setMoving(true)}>
                          Move to another mess
                        </Button>
                      </div>
                      <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {u.memberships.map((m) => (
                          <li key={m.id} className="row-between" style={{ padding: "10px 20px" }}>
                            <span>{m.messName}</span>
                            <span className="text-sm muted">
                              {fmtDate(m.validFrom)} – {m.validTo ? fmtDate(m.validTo) : "now"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {code.error ? <ErrorNotice error={code.error} /> : null}
                </div>
                <section className="panel">
                  <div className="panel-head">
                    <h3>Details</h3>
                  </div>
                  <div className="panel-body">
                    <dl className="dl">
                      {u.rollNumber && (
                        <>
                          <dt>Roll number</dt>
                          <dd className="mono">{u.rollNumber}</dd>
                        </>
                      )}
                      {u.roomNumber && (
                        <>
                          <dt>Room</dt>
                          <dd>{u.roomNumber}</dd>
                        </>
                      )}
                      <dt>Email</dt>
                      <dd>{u.email ?? <span className="muted">—</span>}</dd>
                      <dt>Created</dt>
                      <dd>{fmtDateTime(u.createdAt)}</dd>
                      <dt>Last sign-in</dt>
                      <dd>{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</dd>
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                        <>
                          <dt>Locked until</dt>
                          <dd style={{ color: "var(--warn-text)" }}>{fmtDateTime(u.lockedUntil)} (failed sign-ins)</dd>
                        </>
                      )}
                      {u.pendingCodes.map((c) => (
                        <div key={c.purpose} style={{ display: "contents" }}>
                          <dt>{c.purpose === "ACTIVATION" ? "Activation code" : "Reset code"}</dt>
                          <dd className="text-sm">Outstanding, expires {fmtDateTime(c.expiresAt)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </section>
              </div>

              {code.data && (
                <Dialog open onClose={() => code.reset()} title="One-time code" footer={<Button variant="primary" onClick={() => code.reset()}>Done</Button>}>
                  <OneTimeCode username={code.data.username} code={code.data.code} expiresAt={code.data.expiresAt} purpose={code.variables === "ACTIVATION" ? "activation" : "reset"} />
                </Dialog>
              )}
              <ConfirmDialog
                open={statusTo !== null}
                onClose={() => setStatusTo(null)}
                title={statusTo === "ACTIVE" ? "Reactivate this account?" : statusTo === "SUSPENDED" ? "Suspend this account?" : "Deactivate this account?"}
                body={<p className="text-sm">{statusTo === "ACTIVE" ? "They will be able to sign in again." : "They are signed out everywhere immediately. Students stop being eligible for meals."}</p>}
                confirmLabel={statusTo === "ACTIVE" ? "Reactivate" : statusTo === "SUSPENDED" ? "Suspend" : "Deactivate"}
                tone={statusTo === "ACTIVE" ? "primary" : "danger"}
                requireReason
                onConfirm={async (reason) => {
                  await api.post(`/admin/users/${id}/status`, { status: statusTo, reason });
                  refresh();
                }}
              />
              <ConfirmDialog
                open={revoking !== null}
                onClose={() => setRevoking(null)}
                title={`Revoke ${revoking ? ROLE_LABEL[revoking.role] : ""}${revoking?.messName ? ` · ${revoking.messName}` : ""}?`}
                body={<p className="text-sm">Takes effect on their next request; the history is kept.</p>}
                confirmLabel="Revoke"
                tone="danger"
                requireReason
                onConfirm={async (reason) => {
                  await api.post(`/admin/users/${id}/roles/${revoking!.id}/revoke`, { reason });
                  refresh();
                }}
              />
              {granting && (
                <Dialog
                  open
                  onClose={() => setGranting(false)}
                  title="Grant a role"
                  footer={
                    <>
                      <Button variant="ghost" onClick={() => setGranting(false)}>
                        Cancel
                      </Button>
                      <Button variant="primary" busy={grantM.isPending} disabled={grant.role !== "INSTITUTION_ADMIN" && !grant.messId} onClick={() => grantM.mutate()}>
                        Grant
                      </Button>
                    </>
                  }
                >
                  <div className="stack">
                    <ErrorNotice error={grantM.error} />
                    <SelectField label="Role" value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>
                      <option value="SUPERVISOR">Mess supervisor</option>
                      <option value="KITCHEN_STAFF">Kitchen staff</option>
                      <option value="INSTITUTION_ADMIN">Institution admin</option>
                    </SelectField>
                    {grant.role !== "INSTITUTION_ADMIN" && (
                      <SelectField label="Mess" value={grant.messId} onChange={(e) => setGrant({ ...grant, messId: e.target.value })}>
                        <option value="">Choose…</option>
                        {messes.data?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </SelectField>
                    )}
                    {activeRoles.length > 0 && <p className="text-sm muted">Currently: {activeRoles.map((r) => `${ROLE_LABEL[r.role]}${r.messName ? ` · ${r.messName}` : ""}`).join(", ")}</p>}
                  </div>
                </Dialog>
              )}
              {moving && (
                <Dialog
                  open
                  onClose={() => setMoving(false)}
                  title="Move to another mess"
                  footer={
                    <>
                      <Button variant="ghost" onClick={() => setMoving(false)}>
                        Cancel
                      </Button>
                      <Button variant="primary" busy={moveM.isPending} disabled={!move.messId} onClick={() => moveM.mutate()}>
                        Move
                      </Button>
                    </>
                  }
                >
                  <div className="stack">
                    <ErrorNotice error={moveM.error} />
                    <SelectField label="New mess" value={move.messId} onChange={(e) => setMove({ ...move, messId: e.target.value })}>
                      <option value="">Choose…</option>
                      {messes.data?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </SelectField>
                    <TextField label="From" type="date" value={move.validFrom} onChange={(e) => setMove({ ...move, validFrom: e.target.value })} hint="The current membership ends the day before." />
                  </div>
                </Dialog>
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
