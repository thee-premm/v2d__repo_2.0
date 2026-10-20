import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, ApiError, onUnauthorized, setCsrfToken } from "./api";
import { ROLE_HOME, setInstitutionLocale } from "./format";
import type { Role, Session } from "./types";

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  /** Set when the server ended the session (expired, revoked, account deactivated). */
  endedReason: string | null;
  login(identifier: string, password: string, role?: Role): Promise<Session>;
  logout(): Promise<void>;
  switchRole(role: Role): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

async function fetchSession(): Promise<Session | null> {
  try {
    const s = await api.get<Session>("/auth/session");
    setCsrfToken(s.csrfToken);
    setInstitutionLocale(s.institution.timezone, s.institution.currency);
    return s;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["session"], queryFn: fetchSession, staleTime: 60_000, retry: 1 });

  useEffect(
    () =>
      onUnauthorized((code) => {
        setEndedReason(code === "SESSION_EXPIRED" ? "Your session has ended. Sign in again to continue." : "Please sign in to continue.");
        qc.setQueryData(["session"], null);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
        navigate("/login", { replace: true });
      }),
    [qc, navigate],
  );

  const login = useCallback(
    async (identifier: string, password: string, role?: Role) => {
      const res = await api.post<{ csrfToken: string }>("/auth/login", { identifier, password, role });
      setCsrfToken(res.csrfToken);
      const s = await fetchSession();
      if (!s) throw new ApiError(401, "UNAUTHENTICATED", "Sign-in did not complete. Try again.");
      qc.clear();
      qc.setQueryData(["session"], s);
      setEndedReason(null);
      return s;
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(["session"], null);
      navigate("/login", { replace: true });
    }
  }, [qc, navigate]);

  const switchRole = useCallback(
    async (role: Role) => {
      await api.post("/auth/switch-role", { role });
      const s = await fetchSession();
      qc.clear();
      qc.setQueryData(["session"], s);
      navigate(ROLE_HOME[role], { replace: true });
    },
    [qc, navigate],
  );

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["session"] });
  }, [qc]);

  const value = useMemo(
    () => ({ session: data ?? null, loading: isLoading, endedReason, login, logout, switchRole, refresh }),
    [data, isLoading, endedReason, login, logout, switchRole, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** The session, asserted present (use inside authenticated routes only). */
export function useAuthed(): Session {
  const { session } = useSession();
  if (!session) throw new Error("Not signed in");
  return session;
}
