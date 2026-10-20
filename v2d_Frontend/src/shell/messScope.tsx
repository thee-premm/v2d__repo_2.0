import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuthed } from "../lib/session";
import type { Role } from "../lib/types";

/**
 * The mess a supervisor or kitchen user is currently working in. Options are
 * the messes the *server* says they are assigned to; the API re-checks every
 * request, so this is navigation state only.
 */
interface MessScope {
  messId: number | null;
  messName: string;
  options: { id: number; name: string }[];
  setMessId(id: number): void;
}
const Ctx = createContext<MessScope | null>(null);

export function MessScopeProvider({ role, children }: { role: Extract<Role, "SUPERVISOR" | "KITCHEN_STAFF">; children: ReactNode }) {
  const session = useAuthed();
  const ids = role === "SUPERVISOR" ? session.scopes.supervisorMessIds : [...new Set([...session.scopes.kitchenMessIds, ...session.scopes.supervisorMessIds])];
  const options = session.messes.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, name: m.name }));
  const storageKey = `v2d.mess.${role}.${session.user.id}`;
  const [messId, setMessIdState] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (options.some((o) => o.id === saved)) return saved;
    } catch {
      /* storage unavailable */
    }
    return options[0]?.id ?? null;
  });
  useEffect(() => {
    if (messId !== null && !options.some((o) => o.id === messId)) setMessIdState(options[0]?.id ?? null);
  }, [options, messId]);
  const value = useMemo(
    () => ({
      messId,
      messName: options.find((o) => o.id === messId)?.name ?? "",
      options,
      setMessId(id: number) {
        setMessIdState(id);
        try {
          localStorage.setItem(storageKey, String(id));
        } catch {
          /* ignore */
        }
      },
    }),
    [messId, options, storageKey],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMessScope() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMessScope outside provider");
  return ctx;
}
