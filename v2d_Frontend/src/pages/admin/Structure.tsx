import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { fmtNum } from "../../lib/format";
import { Button, Dialog, ErrorNotice, PageHeader, QueryState, SelectField, TextField } from "../../components/ui";

interface Structure {
  campuses: { id: number; code: string; name: string }[];
  hostels: { id: number; campusId: number; code: string; name: string; capacity: number | null }[];
  messes: { id: number; campusId: number; hostelId: number | null; code: string; name: string; seatingCapacity: number | null; isActive: boolean; memberCount: number; supervisorCount: number; kitchenCount: number }[];
}
type Kind = "campus" | "hostel" | "mess";

function CreateDialog({ kind, s, onClose }: { kind: Kind; s: Structure; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: "", name: "", campusId: String(s.campuses[0]?.id ?? ""), hostelId: "", capacity: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      if (kind === "campus") return api.post("/admin/campuses", { code: f.code, name: f.name });
      if (kind === "hostel") return api.post("/admin/hostels", { campusId: Number(f.campusId), code: f.code, name: f.name, capacity: f.capacity ? Number(f.capacity) : undefined });
      return api.post("/admin/messes", { campusId: Number(f.campusId), hostelId: f.hostelId ? Number(f.hostelId) : null, code: f.code, name: f.name, seatingCapacity: f.capacity ? Number(f.capacity) : undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "structure"] });
      qc.invalidateQueries({ queryKey: ["org"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`New ${kind}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!f.code || f.name.length < 2} onClick={() => m.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNotice error={m.error} />
        <div className="grid-2">
          <TextField label="Code" value={f.code} onChange={set("code")} className="mono" hint="Short, unique, e.g. KAV-M" />
          <TextField label="Name" value={f.name} onChange={set("name")} />
        </div>
        {kind !== "campus" && (
          <SelectField label="Campus" value={f.campusId} onChange={set("campusId")}>
            {s.campuses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        )}
        {kind === "mess" && (
          <SelectField label="Serves hostel" optional value={f.hostelId} onChange={set("hostelId")}>
            <option value="">Central (no single hostel)</option>
            {s.hostels.filter((h) => String(h.campusId) === f.campusId).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </SelectField>
        )}
        {kind !== "campus" && <TextField label={kind === "mess" ? "Seating capacity" : "Capacity"} optional type="number" min={0} value={f.capacity} onChange={set("capacity")} />}
      </div>
    </Dialog>
  );
}

export default function StructurePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "structure"], queryFn: () => api.get<Structure>("/admin/structure") });
  const [creating, setCreating] = useState<Kind | null>(null);
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => api.patch(`/admin/messes/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "structure"] }),
  });
  return (
    <div className="page">
      <PageHeader title="Campuses & messes" subtitle="Students belong to a mess; supervisors and kitchen staff are assigned to messes." />
      <QueryState query={q}>
        {(s) => (
          <div className="stack" style={{ ["--gap" as string]: "32px" }}>
            <section className="section">
              <div className="section-title">
                <h2>Messes</h2>
                <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating("mess")} disabled={!s.campuses.length}>
                  New mess
                </Button>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Mess</th>
                      <th>Campus / hostel</th>
                      <th className="n">Seats</th>
                      <th className="n">Students</th>
                      <th className="n">Supervisors</th>
                      <th className="n">Kitchen</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.messes.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.name}</strong> <span className="mono text-xs muted">{m.code}</span>
                        </td>
                        <td className="text-sm">
                          {s.campuses.find((c) => c.id === m.campusId)?.name}
                          {m.hostelId && ` · ${s.hostels.find((h) => h.id === m.hostelId)?.name}`}
                        </td>
                        <td className="n">{fmtNum(m.seatingCapacity)}</td>
                        <td className="n">{fmtNum(m.memberCount)}</td>
                        <td className="n" style={{ color: m.supervisorCount === 0 ? "var(--danger-text)" : undefined }}>
                          {m.supervisorCount}
                        </td>
                        <td className="n">{m.kitchenCount}</td>
                        <td>
                          <Button size="sm" variant="ghost" busy={toggle.isPending && toggle.variables?.id === m.id} onClick={() => toggle.mutate({ id: m.id, isActive: !m.isActive })}>
                            {m.isActive ? "Active · deactivate" : "Inactive · activate"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="grid-2">
              <section className="section">
                <div className="section-title">
                  <h2>Hostels</h2>
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating("hostel")} disabled={!s.campuses.length}>
                    New hostel
                  </Button>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {s.hostels.map((h) => (
                        <tr key={h.id}>
                          <td>
                            {h.name} <span className="mono text-xs muted">{h.code}</span>
                          </td>
                          <td className="n text-sm">{h.capacity ? `${h.capacity} beds` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="section">
                <div className="section-title">
                  <h2>Campuses</h2>
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating("campus")}>
                    New campus
                  </Button>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {s.campuses.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.name} <span className="mono text-xs muted">{c.code}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            {creating && <CreateDialog kind={creating} s={s} onClose={() => setCreating(null)} />}
          </div>
        )}
      </QueryState>
    </div>
  );
}
