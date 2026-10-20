import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Search, UserPlus } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtDateTime, ROLE_LABEL } from "../../lib/format";
import { Button, Dialog, Empty, ErrorNotice, PageHeader, QueryState, SelectField, TextField, fieldError } from "../../components/ui";
import { OneTimeCode } from "./OneTimeCode";

interface UserRow {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  lastLoginAt: string | null;
  rollNumber: string | null;
  roles: { id: number; role: string; messId: number | null; messName: string | null }[];
}
export const STATUS_TONE: Record<string, string> = { INVITED: "accent", ACTIVE: "ok", SUSPENDED: "warn", DEACTIVATED: "danger" };

export function useMesses() {
  return useQuery({ queryKey: ["org", "messes"], queryFn: () => api.get<{ id: number; name: string; code: string; hostelId: number | null }[]>("/org/messes"), staleTime: 60_000 });
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const messes = useMesses();
  const navigate = useNavigate();
  const [kind, setKind] = useState<"STUDENT" | "SUPERVISOR" | "KITCHEN_STAFF" | "INSTITUTION_ADMIN">("STUDENT");
  const [form, setForm] = useState({ fullName: "", username: "", email: "", rollNumber: "", messId: "", roomNumber: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () =>
      api.post<{ user: { id: number; username: string }; activation: { code: string; expiresAt: string } }>("/admin/users", {
        fullName: form.fullName,
        username: form.username || undefined,
        email: form.email || undefined,
        ...(kind === "STUDENT"
          ? { student: { rollNumber: form.rollNumber, messId: Number(form.messId), roomNumber: form.roomNumber || undefined } }
          : { roles: [{ role: kind, messId: kind === "INSTITUTION_ADMIN" ? undefined : Number(form.messId) }] }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  if (m.data) {
    return (
      <Dialog open onClose={onClose} title="Account created" footer={<><Button onClick={() => navigate(`/admin/accounts/${m.data!.user.id}`)}>Open account</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
        <OneTimeCode username={m.data.user.username} code={m.data.activation.code} expiresAt={m.data.activation.expiresAt} purpose="activation" />
      </Dialog>
    );
  }
  const needsMess = kind !== "INSTITUTION_ADMIN";
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a person"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!form.fullName || (needsMess && !form.messId) || (kind === "STUDENT" ? !form.rollNumber : !form.username)} onClick={() => m.mutate()}>
            Create & get activation code
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <SelectField label="Role" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} hint="Privileged roles can only be granted here, by an administrator.">
          <option value="STUDENT">Student</option>
          <option value="SUPERVISOR">Mess supervisor</option>
          <option value="KITCHEN_STAFF">Kitchen staff</option>
          <option value="INSTITUTION_ADMIN">Institution admin</option>
        </SelectField>
        <TextField label="Full name" value={form.fullName} onChange={set("fullName")} error={fieldError(m.error, "fullName")} />
        {kind === "STUDENT" && <TextField label="Roll number" value={form.rollNumber} onChange={set("rollNumber")} className="mono" hint="Also becomes the username unless you set one." error={fieldError(m.error, "rollNumber")} />}
        <div className="grid-2">
          <TextField label="Username" optional={kind === "STUDENT"} value={form.username} onChange={set("username")} autoCapitalize="none" error={fieldError(m.error, "username")} />
          <TextField label="Email" optional type="email" value={form.email} onChange={set("email")} error={fieldError(m.error, "email")} />
        </div>
        {needsMess && (
          <SelectField label={kind === "STUDENT" ? "Mess" : "Assigned mess"} value={form.messId} onChange={set("messId")}>
            <option value="">Choose…</option>
            {messes.data?.map((ms) => (
              <option key={ms.id} value={ms.id}>
                {ms.name}
              </option>
            ))}
          </SelectField>
        )}
        {kind === "STUDENT" && <TextField label="Room" optional value={form.roomNumber} onChange={set("roomNumber")} />}
      </div>
    </Dialog>
  );
}

export default function Accounts() {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const limit = 50;
  const query = useQuery({
    queryKey: ["admin", "users", q, role, status, page],
    queryFn: () => api.get<{ items: UserRow[]; total: number }>(`/admin/users${qs({ q, role, status, limit, offset: page * limit })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="page">
      <PageHeader
        title="People & access"
        subtitle="Accounts are created here or by roster import. Nobody can give themselves a role."
        actions={
          <>
            <Link className="btn" to="/admin/accounts/import">
              <FileUp size={16} aria-hidden="true" /> Import students
            </Link>
            <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setCreating(true)}>
              Add person
            </Button>
          </>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="input-affix" style={{ flex: "1 1 260px", maxWidth: 360 }}>
          <input
            className="input"
            placeholder="Search name, username, roll number…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            aria-label="Search people"
          />
          <Search size={16} className="affix muted" style={{ right: 12 }} aria-hidden="true" />
        </div>
        <select className="select" style={{ width: "auto" }} value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }} aria-label="Filter by role">
          <option value="">All roles</option>
          {Object.entries(ROLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: "auto" }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="INVITED">Not activated</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="DEACTIVATED">Deactivated</option>
        </select>
      </div>
      <QueryState query={query} lines={8}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty title="No one matches">Try a different search or filter.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Access</th>
                      <th>Status</th>
                      <th>Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link className="row-link" to={`/admin/accounts/${u.id}`}>
                            {u.fullName}
                          </Link>
                          <div className="text-xs muted mono">
                            {u.username}
                            {u.rollNumber && u.rollNumber.toLowerCase() !== u.username && ` · ${u.rollNumber}`}
                          </div>
                        </td>
                        <td className="text-sm">{u.roles.map((r) => `${ROLE_LABEL[r.role]}${r.messName ? ` · ${r.messName}` : ""}`).join(", ")}</td>
                        <td>
                          <span className={`badge badge-${STATUS_TONE[u.status]}`}>{u.status === "INVITED" ? "Not activated" : u.status.toLowerCase()}</span>
                        </td>
                        <td className="text-sm muted">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row-between" style={{ marginTop: 12 }}>
                <span className="text-sm muted">
                  {page * limit + 1}–{Math.min(d.total, (page + 1) * limit)} of {d.total}
                </span>
                <div className="row">
                  <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" disabled={(page + 1) * limit >= d.total} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )
        }
      </QueryState>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
