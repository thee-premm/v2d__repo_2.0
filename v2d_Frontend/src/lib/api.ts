/**
 * The single HTTP client. The server is the authority on every rule; this
 * module only carries the session cookie, attaches the CSRF token, and turns
 * error envelopes into typed ApiErrors the UI can render.
 */
export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  requestId?: string;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
  /** Field-level validation issues, when the server returned them. */
  get fieldIssues(): FieldIssue[] {
    return Array.isArray(this.details) ? (this.details as FieldIssue[]).filter((d) => d && typeof d.field === "string") : [];
  }
}

const BASE = "/api/v1";
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type Listener = (code: string) => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

async function refreshCsrf(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/session`, { credentials: "same-origin" });
  if (!res.ok) return false;
  const body = await res.json();
  setCsrfToken(body.data.csrfToken);
  return true;
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) return (json?.data ?? json) as T;

  const err = json?.error;
  const apiError = new ApiError(
    res.status,
    err?.code ?? `HTTP_${res.status}`,
    err?.message ?? (res.status >= 500 ? "Something went wrong on our side. Try again." : `Request failed (${res.status})`),
    err?.details,
    json?.requestId,
  );
  if (apiError.code === "CSRF_TOKEN_INVALID" && !retried && (await refreshCsrf())) {
    return request<T>(method, path, body, true);
  }
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/session")) {
    unauthorizedListeners.forEach((fn) => fn(apiError.code));
  }
  throw apiError;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body),
};

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Human message for an unknown error. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
