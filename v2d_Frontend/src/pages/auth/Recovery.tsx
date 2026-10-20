import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "./AuthLayout";
import { Button, ErrorNotice, Notice, TextField, fieldError } from "../../components/ui";
import { api } from "../../lib/api";

function PasswordField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor="new-password">New password</label>
      <div className="input-affix">
        <input id="new-password" className="input" type={show ? "text" : "password"} autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby="pw-hint" aria-invalid={error ? true : undefined} />
        <button type="button" className="icon-btn affix" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="hint" id="pw-hint">
          At least 10 characters. A short phrase is easier to remember than symbols.
        </div>
      )}
    </div>
  );
}

function CodeForm({ mode }: { mode: "activate" | "reset" }) {
  const [params] = useSearchParams();
  const [identifier, setIdentifier] = useState(params.get("u") ?? "");
  const [code, setCode] = useState(params.get("code") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ username: string }>(mode === "activate" ? "/auth/activate" : "/auth/password-reset/confirm", { identifier: identifier.trim(), code, password });
      setDone(res.username);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="stack">
        <CheckCircle2 size={32} color="var(--ok)" aria-hidden="true" />
        <h2>{mode === "activate" ? "Your account is ready" : "Password changed"}</h2>
        <p className="muted">
          Sign in as <strong className="mono">{done}</strong> with your new password.
          {mode === "reset" && " Any other signed-in devices were signed out."}
        </p>
        <Link className="btn btn-primary btn-lg" to="/login">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack" style={{ ["--gap" as string]: "18px" }} noValidate>
      <div className="stack" style={{ ["--gap" as string]: "6px" }}>
        <h2>{mode === "activate" ? "Activate your account" : "Set a new password"}</h2>
        <p className="muted">
          {mode === "activate"
            ? "Enter the one-time code your mess office or administrator gave you."
            : "Enter the one-time reset code from your email or your administrator."}
        </p>
      </div>
      <ErrorNotice error={error && !fieldError(error, "password") ? error : null} />
      <TextField label="Username or email" autoComplete="username" autoCapitalize="none" value={identifier} onChange={(e) => setIdentifier(e.target.value)} hint="Students: your username is usually your roll number." />
      <TextField
        label="One-time code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX-XXXX"
        autoComplete="one-time-code"
        spellCheck={false}
        className="mono"
        hint="Dashes and spaces are optional."
      />
      <PasswordField value={password} onChange={setPassword} error={fieldError(error, "password")} />
      <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? "Passwords don't match" : null} />
      <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!identifier || code.replace(/[^A-Za-z0-9]/g, "").length < 12 || password.length < 10 || mismatch}>
        {mode === "activate" ? "Activate account" : "Change password"}
      </Button>
      <Link to="/login" className="text-sm">
        Back to sign in
      </Link>
    </form>
  );
}

export function Activate() {
  return (
    <AuthLayout>
      <CodeForm mode="activate" />
    </AuthLayout>
  );
}

export function ResetPassword() {
  return (
    <AuthLayout>
      <CodeForm mode="reset" />
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ emailDelivery: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <AuthLayout>
      {result ? (
        <div className="stack">
          <h2>Check with your institution</h2>
          {result.emailDelivery === "NOT_CONFIGURED" ? (
            <Notice tone="info" title="Email isn't set up for this installation">
              Ask your mess office or institution administrator for a password reset code, then <Link to="/reset-password">enter it here</Link>.
            </Notice>
          ) : (
            <Notice tone="ok" title="If that account has an email address, a reset code is on its way.">
              The code expires in 30 minutes. <Link to={`/reset-password?u=${encodeURIComponent(identifier)}`}>Enter the code</Link>.
            </Notice>
          )}
          <Link to="/login" className="text-sm">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          className="stack"
          style={{ ["--gap" as string]: "18px" }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setResult(await api.post("/auth/password-reset/request", { identifier: identifier.trim() }));
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="stack" style={{ ["--gap" as string]: "6px" }}>
            <h2>Forgot your password?</h2>
            <p className="muted">We'll send a reset code if email is configured. Otherwise your administrator can issue one.</p>
          </div>
          <ErrorNotice error={error} />
          <TextField label="Username or email" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={identifier.trim().length < 3}>
            Request reset code
          </Button>
          <div className="row text-sm">
            <Link to="/login">Back to sign in</Link>
            <span className="muted">·</span>
            <Link to="/reset-password">I already have a code</Link>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
