import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Building2, ChefHat, ClipboardList, Eye, EyeOff, GraduationCap } from "lucide-react";
import { AuthLayout } from "./AuthLayout";
import { Button, Notice, TextField } from "../../components/ui";
import { useSession } from "../../lib/session";
import { ApiError } from "../../lib/api";
import { ROLE_HOME, ROLE_LABEL } from "../../lib/format";
import type { Role } from "../../lib/types";

const WORKSPACES: { role: Role; label: string; icon: typeof GraduationCap }[] = [
  { role: "STUDENT", label: "Student", icon: GraduationCap },
  { role: "SUPERVISOR", label: "Supervisor", icon: ClipboardList },
  { role: "KITCHEN_STAFF", label: "Kitchen", icon: ChefHat },
  { role: "INSTITUTION_ADMIN", label: "Administrator", icon: Building2 },
];

const LAST_ROLE_KEY = "v2d.lastWorkspace";
function lastRole(): Role | "" {
  try {
    return (localStorage.getItem(LAST_ROLE_KEY) as Role) || "";
  } catch {
    return "";
  }
}

export default function Login() {
  const { session, loading, login, endedReason } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role | "">(lastRole);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [touched, setTouched] = useState(false);

  if (!loading && session) return <Navigate to={ROLE_HOME[session.activeRole]} replace />;

  const idError = touched && identifier.trim().length < 3 ? "Enter your username, roll number or email" : null;
  const pwError = touched && password.length === 0 ? "Enter your password" : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (identifier.trim().length < 3 || !password) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(identifier.trim(), password, role || undefined);
      try {
        localStorage.setItem(LAST_ROLE_KEY, s.activeRole);
      } catch {
        /* ignore */
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith(ROLE_HOME[s.activeRole]) ? from : ROLE_HOME[s.activeRole], { replace: true });
    } catch (err) {
      setError(err as Error);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const assigned = error instanceof ApiError && error.code === "ROLE_NOT_ASSIGNED" ? ((error.details as { assignedRoles?: Role[] })?.assignedRoles ?? []) : [];

  return (
    <AuthLayout>
      <form onSubmit={onSubmit} noValidate className="stack" style={{ ["--gap" as string]: "20px" }} aria-labelledby="signin-title">
        <div className="stack" style={{ ["--gap" as string]: "6px" }}>
          <h2 id="signin-title">Sign in</h2>
          <p className="muted">Use the account your institution created for you.</p>
        </div>

        {endedReason && !error && <Notice tone="info">{endedReason}</Notice>}
        {error && (
          <Notice tone="danger" title={error.message}>
            {assigned.length > 0 && (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="text-sm">Your account opens:</span>
                {assigned.map((r) => (
                  <Button key={r} size="sm" onClick={() => setRole(r)}>
                    {ROLE_LABEL[r]}
                  </Button>
                ))}
              </div>
            )}
            {error instanceof ApiError && error.code === "INVALID_CREDENTIALS" && (
              <div className="text-sm" style={{ marginTop: 4 }}>
                Check the username and password. <Link to="/forgot-password">Forgot your password?</Link>
              </div>
            )}
          </Notice>
        )}

        <TextField
          label="Username, roll number or email"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          error={idError}
          autoFocus
        />

        <div className="field">
          <div className="row-between">
            <label htmlFor="password">Password</label>
            <Link to="/forgot-password" className="text-sm">
              Forgot password?
            </Link>
          </div>
          <div className="input-affix">
            <input
              id="password"
              className="input"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={pwError ? true : undefined}
              aria-describedby={pwError ? "pw-err" : undefined}
            />
            <button type="button" className="icon-btn affix" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {pwError && (
            <div className="field-error" id="pw-err" role="alert">
              {pwError}
            </div>
          )}
        </div>

        <fieldset className="stack" style={{ ["--gap" as string]: "8px" }}>
          <legend className="field-label">
            Workspace <span className="optional muted">(optional)</span>
          </legend>
          <div className="role-picker">
            {WORKSPACES.map((w) => (
              <label key={w.role}>
                <input type="radio" name="workspace" value={w.role} checked={role === w.role} onChange={() => setRole(w.role)} />
                <span className="role-tile">
                  <w.icon size={17} aria-hidden="true" />
                  {w.label}
                </span>
              </label>
            ))}
          </div>
          <div className="hint">
            Only orients the interface — you'll get the workspaces your account is assigned.{" "}
            {role && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ minHeight: 0, padding: 0, textDecoration: "underline" }} onClick={() => setRole("")}>
                Clear choice
              </button>
            )}
          </div>
        </fieldset>

        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-sm muted">
          New student with an activation code? <Link to="/activate">Activate your account</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
