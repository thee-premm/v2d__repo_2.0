import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Info, Inbox, RefreshCw, X } from "lucide-react";
import { ApiError, errorMessage } from "../lib/api";
import type { SlotStatus } from "../lib/types";

/* ------------------------------------------------------------------ Button */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  block?: boolean;
  icon?: ReactNode;
}
export function Button({ variant = "secondary", size = "md", busy, block, icon, children, className = "", disabled, type = "button", ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "secondary" && `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} disabled={disabled || busy} data-busy={busy || undefined} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ Fields */
interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}
export function Field({ label, hint, error, optional, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </label>
      {children({ id, describedBy: [hintId, errId].filter(Boolean).join(" ") || undefined, invalid: Boolean(error) })}
      {hint && !error && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={errId} role="alert">
          <CircleAlert size={14} aria-hidden="true" style={{ marginTop: 2 }} />
          {error}
        </div>
      )}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; large?: boolean };
export function TextField({ label, hint, error, optional, large, className = "", ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => (
        <input id={id} className={`input ${large ? "input-lg" : ""} ${className}`} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />
      )}
    </Field>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean };
export function SelectField({ label, hint, error, optional, children, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => (
        <select id={id} className="select" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean };
export function TextAreaField({ label, hint, error, optional, ...rest }: TextAreaProps) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => <textarea id={id} className="textarea" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />}
    </Field>
  );
}

/** Pick the server's message for one field out of a validation error. */
export function fieldError(err: unknown, field: string): string | null {
  if (!(err instanceof ApiError)) return null;
  return err.fieldIssues.find((i) => i.field === field || i.field.endsWith(`.${field}`))?.message ?? null;
}

/* ------------------------------------------------------------------ Notice */
export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "danger" | "ok"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "info" ? Info : AlertTriangle;
  return (
    <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div className="stack" style={{ ["--gap" as string]: "2px", flex: 1 }}>
        {title && <div className="notice-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Renders an API error with whatever the server said, plus the request ID for support. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  const issues = api?.fieldIssues ?? [];
  return (
    <Notice
      tone="danger"
      title={errorMessage(error)}
      action={
        onRetry ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {issues.length > 0 && (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {issues.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      )}
      {api?.requestId && api.status >= 500 && <div className="text-xs muted">Reference: {api.requestId}</div>}
    </Notice>
  );
}

/* -------------------------------------------------------- Loading / empty */
export function Loading({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="stack" style={{ ["--gap" as string]: "10px" }} role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ height: i === 0 ? 22 : 14, width: `${[60, 92, 78, 85, 70][i % 5]}%` }} />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={22} aria-hidden="true" />}
      <h3>{title}</h3>
      {children && <div className="muted text-sm" style={{ maxWidth: "60ch" }}>{children}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** Standard query rendering: loading → error (with retry) → content. */
export function QueryState<T>({ query, children, lines }: { query: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (data: T) => ReactNode; lines?: number }) {
  if (query.isLoading) return <Loading lines={lines} />;
  if (query.error) return <ErrorNotice error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}

/* ------------------------------------------------------------ Page header */
export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        {back && (
          <Link to={back.to} className="crumb">
            <ArrowLeft size={14} aria-hidden="true" /> {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ Badges */
const STATUS: Record<SlotStatus, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "outline" },
  OPEN: { label: "Voting open", tone: "info" },
  LOCKED: { label: "Voting closed", tone: "accent" },
  FORECAST_READY: { label: "Awaiting approval", tone: "warn" },
  APPROVED: { label: "Target approved", tone: "brand" },
  IN_SERVICE: { label: "Serving", tone: "ok" },
  SERVICE_CLOSED: { label: "To reconcile", tone: "warn" },
  RECONCILED: { label: "Reconciled", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};
export function StatusBadge({ status }: { status: SlotStatus }) {
  const s = STATUS[status];
  return (
    <span className={`badge ${s.tone === "neutral" ? "" : `badge-${s.tone}`}`}>
      <span className="dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}
export const statusLabel = (s: SlotStatus) => STATUS[s].label;

export function IntentBadge({ intent }: { intent: "YES" | "NO" | "UNVOTED" | null | string }) {
  if (intent === "YES") return <span className="badge badge-yes">Yes</span>;
  if (intent === "NO") return <span className="badge badge-no">No</span>;
  if (intent === "UNVOTED" || intent === null) return <span className="badge badge-unvoted">No vote</span>;
  return <span className="badge">{String(intent).replace(/_/g, " ").toLowerCase()}</span>;
}

/** Where a number came from: measured, manual, estimate, derived. */
export function Kind({ kind }: { kind: string }) {
  const k = kind.toUpperCase();
  const label = k === "ESTIMATE" || k === "ESTIMATED" ? "estimate" : k === "MANUAL" ? "manual" : k === "DERIVED" ? "derived" : "measured";
  return (
    <span className={`kind ${label === "estimate" ? "kind-estimate" : ""}`} title={KIND_TITLE[label]}>
      {label}
    </span>
  );
}
const KIND_TITLE: Record<string, string> = {
  measured: "Counted or weighed records",
  manual: "Entered by a person",
  estimate: "Model output or conversion with assumed factors",
  derived: "Calculated from other values",
};

/* -------------------------------------------------------------- Stat tiles */
export function Stat({ label, value, unit, foot, kind, title }: { label: ReactNode; value: ReactNode; unit?: string; foot?: ReactNode; kind?: string; title?: string }) {
  const missing = value === null || value === undefined || value === "—";
  return (
    <div className="stat" title={title}>
      <div className="stat-label">
        {label}
        {kind && <Kind kind={kind} />}
      </div>
      <div className={`stat-value ${missing ? "missing" : ""}`}>
        {missing ? "Not recorded" : value}
        {!missing && unit && <span className="unit">{unit}</span>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialog */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      style={wide ? { width: "min(760px, calc(100vw - 32px))" } : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId} style={{ fontSize: "var(--text-lg)" }}>
              {title}
            </h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** Confirmation for consequential actions; optionally requires a reason. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  tone = "primary",
  requireReason,
  reasonLabel = "Reason",
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  requireReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  const tooShort = requireReason && reason.trim().length < 5;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={tone}
            busy={busy}
            disabled={tooShort}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
                onClose();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {body}
        {requireReason && <TextAreaField label={reasonLabel} value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 5 characters. Recorded in the audit trail." autoFocus />}
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Toasts */
interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
}
const ToastContext = createContext<(message: string, tone?: "ok" | "error") => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "error" : ""}`} role={t.tone === "error" ? "alert" : "status"}>
            {t.tone === "error" ? <AlertTriangle size={16} color="var(--danger)" aria-hidden="true" /> : <CheckCircle2 size={16} color="var(--ok)" aria-hidden="true" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

/* --------------------------------------------------------- Composition bar */
export function Composition({ yes, no, unvoted, showLegend = true }: { yes: number; no: number; unvoted: number; showLegend?: boolean }) {
  const total = yes + no + unvoted;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <div className="stack" style={{ ["--gap" as string]: "8px" }}>
      <div className="composition" role="img" aria-label={`${yes} yes, ${no} no, ${unvoted} did not vote`}>
        {yes > 0 && <span className="c-yes" style={{ flexGrow: pct(yes) }} />}
        {no > 0 && <span className="c-no" style={{ flexGrow: pct(no) }} />}
        {unvoted > 0 && <span className="c-unvoted" style={{ flexGrow: pct(unvoted) }} />}
        {total === 0 && <span style={{ flexGrow: 1, background: "var(--viz-track)" }} />}
      </div>
      {showLegend && (
        <div className="legend num">
          <span className="key">
            <span className="sw" style={{ background: "var(--yes)" }} /> Yes <strong>{yes}</strong>
          </span>
          <span className="key">
            <span className="sw" style={{ background: "var(--no)" }} /> No <strong>{no}</strong>
          </span>
          <span className="key">
            <span className="sw" style={{ background: "repeating-linear-gradient(135deg, var(--unvoted-soft) 0 3px, var(--unvoted) 3px 4px)" }} /> No vote <strong>{unvoted}</strong>
          </span>
        </div>
      )}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
