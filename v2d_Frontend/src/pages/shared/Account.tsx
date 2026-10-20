import { useState, type FormEvent } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { api } from "../../lib/api";
import { useAuthed, useSession } from "../../lib/session";
import { ROLE_LABEL } from "../../lib/format";
import { Button, ErrorNotice, PageHeader, TextField, fieldError, useToast } from "../../components/ui";

type Theme = "system" | "light" | "dark";
function applyTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("v2d.theme", t);
  } catch {
    /* ignore */
  }
}

export default function Account({ narrow = false }: { narrow?: boolean }) {
  const session = useAuthed();
  const { logout } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("v2d.theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/change", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      toast("Password changed. Other devices were signed out.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={narrow ? "stack" : "page narrow"}>
      <PageHeader title="Your account" />
      <div className="stack" style={{ ["--gap" as string]: "20px" }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Profile</h3>
          </div>
          <div className="panel-body">
            <dl className="dl">
              <dt>Name</dt>
              <dd>{session.user.fullName}</dd>
              <dt>Username</dt>
              <dd className="mono">{session.user.username}</dd>
              {session.user.email && (
                <>
                  <dt>Email</dt>
                  <dd>{session.user.email}</dd>
                </>
              )}
              {session.scopes.student && (
                <>
                  <dt>Roll number</dt>
                  <dd className="mono">{session.scopes.student.rollNumber}</dd>
                </>
              )}
              <dt>Institution</dt>
              <dd>{session.institution.name}</dd>
              <dt>Access</dt>
              <dd>
                {session.roles.map((r) => ROLE_LABEL[r]).join(", ")}
                {session.messes.length > 0 && <span className="muted"> · {session.messes.map((m) => m.name).join(", ")}</span>}
              </dd>
            </dl>
            <p className="text-sm muted" style={{ marginTop: 14 }}>
              Your name, roll number and access are managed by your institution. Ask your administrator to correct them.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Appearance</h3>
          </div>
          <div className="panel-body">
            <div className="segmented" role="radiogroup" aria-label="Colour theme">
              {(
                [
                  ["system", "System", SunMoon],
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                ] as const
              ).map(([value, label, Icon]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === value}
                    onChange={() => {
                      setTheme(value);
                      applyTheme(value);
                    }}
                  />
                  <span>
                    <Icon size={14} aria-hidden="true" />
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Change password</h3>
          </div>
          <form className="panel-body stack" onSubmit={changePassword}>
            <ErrorNotice error={error && !fieldError(error, "password") ? error : null} />
            <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters." error={fieldError(error, "password")} />
            <div>
              <Button type="submit" variant="primary" busy={busy} disabled={!current || next.length < 10}>
                Change password
              </Button>
            </div>
          </form>
        </section>

        <div>
          <Button variant="danger" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
