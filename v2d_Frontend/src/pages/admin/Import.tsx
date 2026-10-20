import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileUp } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { Button, ErrorNotice, Notice, PageHeader, TextAreaField } from "../../components/ui";

interface ImportResult {
  valid: boolean;
  committed: boolean;
  rowCount: number;
  errors: { line: number; rollNumber: string; errors: string[] }[];
  created?: { rollNumber: string; username: string; fullName: string; activationCode: string; expiresAt: string }[];
}

const SAMPLE = "roll_number,full_name,mess_code,email,hostel_code,room_number,year_of_study\n23ME0101,Ishaan Rao,KAV-M,,KAV,K-214,1\n";

function download(name: string, text: string) {
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export default function Import() {
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResult>("/admin/students/import", { csv, dryRun }),
    onSuccess: (r, dryRun) => {
      setChecked(r);
      if (!dryRun && r.committed) qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  const created = checked?.committed ? checked.created ?? [] : [];

  return (
    <div className="page">
      <PageHeader back={{ to: "/admin/accounts", label: "People & access" }} title="Import students" subtitle="Validate a roster first. Nothing is written unless every row is valid." />
      {created.length > 0 ? (
        <div className="stack">
          <Notice tone="ok" title={`${created.length} student accounts created`}>
            Download the activation codes now — they are shown only once. Distribute each code privately.
          </Notice>
          <div>
            <Button
              variant="primary"
              icon={<Download size={16} />}
              onClick={() =>
                download(
                  `v2d-activation-codes-${new Date().toISOString().slice(0, 10)}.csv`,
                  ["roll_number,full_name,username,activation_code,expires_at,activate_at", ...created.map((c) => [c.rollNumber, c.fullName, c.username, c.activationCode, c.expiresAt, `${window.location.origin}/activate?u=${c.username}`].map((v) => cell(String(v))).join(","))].join("\r\n"),
                )
              }
            >
              Download activation codes (CSV)
            </Button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Roll number</th>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Code</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {created.slice(0, 50).map((c) => (
                  <tr key={c.username}>
                    <td className="mono">{c.rollNumber}</td>
                    <td>{c.fullName}</td>
                    <td className="mono">{c.username}</td>
                    <td className="mono">{c.activationCode}</td>
                    <td className="text-sm">{fmtDateTime(c.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="stack">
            <div className="row">
              <label className="btn">
                <FileUp size={16} aria-hidden="true" /> Choose CSV file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setCsv(await f.text());
                      setChecked(null);
                    }
                  }}
                />
              </label>
              <span className="text-sm muted">or paste below</span>
            </div>
            <TextAreaField
              label="Roster CSV"
              rows={12}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setChecked(null);
              }}
              placeholder={SAMPLE}
              spellCheck={false}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
            />
            <ErrorNotice error={run.error} />
            {checked && !checked.valid && (
              <div className="stack" style={{ ["--gap" as string]: "8px" }}>
                <Notice tone="danger" title={`${checked.errors.length} row(s) need fixing`}>
                  Fix them in the file and check again. Nothing has been imported.
                </Notice>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="n">Line</th>
                        <th>Roll number</th>
                        <th>Problems</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checked.errors.map((e) => (
                        <tr key={e.line}>
                          <td className="n">{e.line}</td>
                          <td className="mono">{e.rollNumber}</td>
                          <td className="text-sm">{e.errors.join("; ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {checked?.valid && !checked.committed && (
              <Notice tone="ok" title={`All ${checked.rowCount} rows are valid`}>
                <CheckCircle2 size={14} style={{ verticalAlign: -2 }} aria-hidden="true" /> Import to create the accounts and their activation codes.
              </Notice>
            )}
            <div className="row">
              <Button busy={run.isPending && run.variables === true} disabled={!csv.trim()} onClick={() => run.mutate(true)}>
                Check file
              </Button>
              <Button variant="primary" busy={run.isPending && run.variables === false} disabled={!checked?.valid || checked.committed} onClick={() => run.mutate(false)}>
                Import {checked?.valid ? `${checked.rowCount} students` : ""}
              </Button>
            </div>
          </div>
          <aside className="panel panel-body stack text-sm">
            <h3>File format</h3>
            <p>Required columns:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                <code>roll_number</code> — becomes the username
              </li>
              <li>
                <code>full_name</code>
              </li>
              <li>
                <code>mess_code</code> — e.g. KAV-M (see Campuses &amp; messes)
              </li>
            </ul>
            <p>
              Optional: <code>email</code>, <code>hostel_code</code>, <code>room_number</code>, <code>program</code>, <code>year_of_study</code>, <code>username</code>.
            </p>
            <Button size="sm" icon={<Download size={14} />} onClick={() => download("v2d-roster-template.csv", SAMPLE)}>
              Download template
            </Button>
            <p className="muted">Each student activates their own account with the one-time code, choosing their own password. Codes expire after 14 days and can be re-issued.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
