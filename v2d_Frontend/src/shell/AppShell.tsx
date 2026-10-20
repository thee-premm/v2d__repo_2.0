import { useEffect, useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  BookOpen,
  Boxes,
  CalendarDays,
  ChefHat,
  ClipboardCheck,
  FileClock,
  Gauge,
  History,
  Home,
  LineChart,
  LogOut,
  Menu,
  MessageSquareWarning,
  ScanLine,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Building2,
  UserRound,
  Users,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";
import { Brand } from "../components/Brand";
import { useSession, useAuthed } from "../lib/session";
import { api } from "../lib/api";
import { initials, ROLE_LABEL } from "../lib/format";
import type { Role } from "../lib/types";
import { MessScopeProvider, useMessScope } from "./messScope";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  end?: boolean;
  count?: number;
}
interface NavGroup {
  title?: string;
  items: NavItem[];
}

function useUnread() {
  return useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => api.get<{ unreadCount: number }>("/me/notifications?limit=1"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  }).data?.unreadCount;
}

function RailNav({ groups }: { groups: NavGroup[] }) {
  return (
    <nav aria-label="Workspace">
      {groups.map((g, i) => (
        <div key={i} style={{ display: "contents" }}>
          {g.title && <div className="rail-group">{g.title}</div>}
          {g.items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end}>
              <it.icon size={17} aria-hidden={true} />
              {it.label}
              {it.count ? (
                <span className="count" aria-label={`${it.count} pending`}>
                  {it.count}
                </span>
              ) : null}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function MessSwitcher() {
  const { messId, options, setMessId, messName } = useMessScope();
  if (options.length === 0) return null;
  return (
    <div className="rail-context">
      <div className="eyebrow">Mess</div>
      {options.length > 1 ? (
        <select value={messId ?? ""} onChange={(e) => setMessId(Number(e.target.value))} aria-label="Working in mess">
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <div className="value">{messName}</div>
      )}
    </div>
  );
}

function RailFoot({ role }: { role: Role }) {
  const session = useAuthed();
  const { logout, switchRole } = useSession();
  const others = session.roles.filter((r) => r !== role);
  return (
    <div className="rail-foot">
      <div className="rail-user">
        <span className="avatar" aria-hidden="true">
          {initials(session.user.fullName)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="name">{session.user.fullName}</div>
          <div className="role">{ROLE_LABEL[role]}</div>
        </div>
      </div>
      {others.length > 0 && (
        <label className="rail-context" style={{ display: "block", margin: "12px 0 0" }}>
          <span className="eyebrow">Switch workspace</span>
          <select value="" onChange={(e) => e.target.value && switchRole(e.target.value as Role)}>
            <option value="">{ROLE_LABEL[role]}</option>
            {others.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="rail-actions">
        <button className="btn btn-sm" onClick={() => logout()}>
          <LogOut size={14} aria-hidden="true" /> Sign out
        </button>
      </div>
    </div>
  );
}

function StaffFrame({ role, groups }: { role: Role; groups: NavGroup[] }) {
  const session = useAuthed();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="shell" data-nav-open={open}>
        <aside className="rail" aria-label="Navigation">
          <Brand />
          {role === "INSTITUTION_ADMIN" ? (
            <div className="rail-context">
              <div className="eyebrow">Institution</div>
              <div className="value">{session.institution.name}</div>
            </div>
          ) : (
            <MessSwitcher />
          )}
          <RailNav groups={groups} />
          <RailFoot role={role} />
        </aside>
        {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
        <div className="main">
          <header className="topbar">
            <button className="icon-btn" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
              <Menu size={20} />
            </button>
            <Brand />
          </header>
          <main id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}

function useSupervisorCounts() {
  const { messId } = useMessScope();
  return useQuery({
    queryKey: ["overview", messId],
    queryFn: () => api.get<any>(`/messes/${messId}/overview`),
    enabled: messId !== null,
    refetchInterval: 60_000,
  }).data?.attention;
}

function SupervisorFrame() {
  const attention = useSupervisorCounts();
  const unread = useUnread();
  const groups: NavGroup[] = [
    {
      items: [
        { to: "/supervisor", label: "Today", icon: Gauge, end: true },
        { to: "/supervisor/meals", label: "Meals & menus", icon: CalendarDays },
        { to: "/supervisor/counter", label: "Counter", icon: ScanLine },
        { to: "/supervisor/reconcile", label: "Reconcile", icon: ClipboardCheck, count: attention?.awaitingReconciliation?.length },
        { to: "/supervisor/appeals", label: "Appeals", icon: MessageSquareWarning, count: attention?.pendingAppeals },
      ],
    },
    {
      title: "Kitchen",
      items: [
        { to: "/supervisor/incidents", label: "Kitchen issues", icon: Wrench, count: attention?.openIncidents },
        { to: "/supervisor/inventory", label: "Stock & procurement", icon: Boxes },
        { to: "/supervisor/catalog", label: "Dishes & recipes", icon: BookOpen },
      ],
    },
    { title: "Insight", items: [{ to: "/supervisor/analyze", label: "Analyze", icon: LineChart }] },
    {
      title: "You",
      items: [
        { to: "/supervisor/notifications", label: "Notifications", icon: Bell, count: unread },
        { to: "/supervisor/account", label: "Account", icon: UserRound },
      ],
    },
  ];
  return <StaffFrame role="SUPERVISOR" groups={groups} />;
}

function KitchenFrame() {
  const unread = useUnread();
  const groups: NavGroup[] = [
    {
      items: [
        { to: "/kitchen", label: "Today's preparation", icon: ChefHat, end: true },
        { to: "/kitchen/incidents", label: "Report an issue", icon: ShieldAlert },
        { to: "/kitchen/inventory", label: "Stock", icon: Boxes },
        { to: "/kitchen/recipes", label: "Recipes", icon: BookOpen },
      ],
    },
    {
      title: "You",
      items: [
        { to: "/kitchen/notifications", label: "Notifications", icon: Bell, count: unread },
        { to: "/kitchen/account", label: "Account", icon: UserRound },
      ],
    },
  ];
  return <StaffFrame role="KITCHEN_STAFF" groups={groups} />;
}

function AdminFrame() {
  const unread = useUnread();
  const groups: NavGroup[] = [
    {
      items: [
        { to: "/admin", label: "Overview", icon: Gauge, end: true },
        { to: "/admin/analyze", label: "Analyze", icon: LineChart },
      ],
    },
    {
      title: "Manage",
      items: [
        { to: "/admin/accounts", label: "People & access", icon: Users },
        { to: "/admin/structure", label: "Campuses & messes", icon: Building2 },
        { to: "/admin/settings", label: "Policies & meals", icon: SlidersHorizontal },
        { to: "/admin/catalog", label: "Dishes & recipes", icon: UtensilsCrossed },
      ],
    },
    { title: "Governance", items: [{ to: "/admin/audit", label: "Audit trail", icon: FileClock }] },
    {
      title: "You",
      items: [
        { to: "/admin/notifications", label: "Notifications", icon: Bell, count: unread },
        { to: "/admin/account", label: "Account", icon: Settings2 },
      ],
    },
  ];
  return <StaffFrame role="INSTITUTION_ADMIN" groups={groups} />;
}

export function SupervisorShell() {
  return (
    <MessScopeProvider role="SUPERVISOR">
      <SupervisorFrame />
    </MessScopeProvider>
  );
}
export function KitchenShell() {
  return (
    <MessScopeProvider role="KITCHEN_STAFF">
      <KitchenFrame />
    </MessScopeProvider>
  );
}
export function AdminShell() {
  return <AdminFrame />;
}

// ------------------------------------------------------------------ student
export function StudentShell() {
  const session = useAuthed();
  const { logout, switchRole } = useSession();
  const unread = useUnread();
  const items = [
    { to: "/student", label: "Home", icon: Home, end: true },
    { to: "/student/meals", label: "Vote", icon: UtensilsCrossed },
    { to: "/student/history", label: "History", icon: History },
    { to: "/student/warnings", label: "Warnings", icon: ShieldAlert },
    { to: "/student/notifications", label: "Inbox", icon: Bell },
  ];
  const others = session.roles.filter((r) => r !== "STUDENT");
  return (
    <div className="student-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="student-top">
        <div className="student-top-inner">
          <Brand />
          <nav aria-label="Student">
            {items.slice(0, 4).map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end}>
                {it.label}
              </NavLink>
            ))}
          </nav>
          <span className="spacer" />
          <NavLink to="/student/notifications" className="icon-btn bell" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Bell size={19} />
            {unread ? <span className="badge-dot" /> : null}
          </NavLink>
          <NavLink to="/student/profile" className="avatar" aria-label="Your profile" style={{ textDecoration: "none" }}>
            {initials(session.user.fullName)}
          </NavLink>
          {others.length > 0 && (
            <select className="select" style={{ width: "auto", minHeight: 32 }} value="" onChange={(e) => e.target.value && switchRole(e.target.value as Role)} aria-label="Switch workspace">
              <option value="">Student</option>
              {others.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" onClick={() => logout()} aria-label="Sign out" title="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main id="main" className="student-main" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Student">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end}>
            <it.icon size={20} aria-hidden={true} />
            {it.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
