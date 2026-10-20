import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./lib/session";
import { ROLE_HOME } from "./lib/format";
import type { Role } from "./lib/types";
import { Loading } from "./components/ui";
import { AdminShell, KitchenShell, StudentShell, SupervisorShell } from "./shell/AppShell";
import Login from "./pages/auth/Login";
import { Activate, ForgotPassword, ResetPassword } from "./pages/auth/Recovery";

const StudentHome = lazy(() => import("./pages/student/StudentHome"));
const StudentMeals = lazy(() => import("./pages/student/StudentMeals"));
const StudentHistory = lazy(() => import("./pages/student/StudentHistory"));
const StudentWarnings = lazy(() => import("./pages/student/StudentWarnings"));
const Notifications = lazy(() => import("./pages/shared/Notifications"));
const Account = lazy(() => import("./pages/shared/Account"));
const SupOverview = lazy(() => import("./pages/supervisor/Overview"));
const SupMeals = lazy(() => import("./pages/supervisor/Meals"));
const SupMealDetail = lazy(() => import("./pages/supervisor/MealDetail"));
const SupCounter = lazy(() => import("./pages/supervisor/Counter"));
const SupReconcileList = lazy(() => import("./pages/supervisor/ReconcileList"));
const SupReconcile = lazy(() => import("./pages/supervisor/Reconcile"));
const SupAppeals = lazy(() => import("./pages/supervisor/Appeals"));
const Incidents = lazy(() => import("./pages/shared/Incidents"));
const Inventory = lazy(() => import("./pages/shared/Inventory"));
const Catalog = lazy(() => import("./pages/shared/Catalog"));
const MessAnalyze = lazy(() => import("./pages/analyze/MessAnalyze"));
const KitchenBoard = lazy(() => import("./pages/kitchen/KitchenBoard"));
const KitchenMeal = lazy(() => import("./pages/kitchen/KitchenMeal"));
const AdminOverview = lazy(() => import("./pages/admin/AdminOverview"));
const AdminAccounts = lazy(() => import("./pages/admin/Accounts"));
const AdminAccount = lazy(() => import("./pages/admin/AccountDetail"));
const AdminImport = lazy(() => import("./pages/admin/Import"));
const AdminStructure = lazy(() => import("./pages/admin/Structure"));
const AdminSettings = lazy(() => import("./pages/admin/Settings"));
const InstitutionAnalyze = lazy(() => import("./pages/analyze/InstitutionAnalyze"));
const AdminAudit = lazy(() => import("./pages/admin/Audit"));

function FullPageLoading() {
  return (
    <div style={{ maxWidth: 480, margin: "15vh auto", padding: 24 }}>
      <Loading lines={3} label="Loading Vote2Dine" />
    </div>
  );
}

/**
 * Route guard. It only decides which screens to render — every API call is
 * authorized by the server regardless of what this allows.
 */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <FullPageLoading />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!session.roles.includes(role)) return <Navigate to={ROLE_HOME[session.activeRole]} replace />;
  return <>{children}</>;
}

function Home() {
  const { session, loading } = useSession();
  if (loading) return <FullPageLoading />;
  return <Navigate to={session ? ROLE_HOME[session.activeRole] : "/login"} replace />;
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page"><Loading /></div>}>{children}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/activate" element={<Activate />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route path="/student" element={<RequireRole role="STUDENT"><StudentShell /></RequireRole>}>
        <Route index element={<Page><StudentHome /></Page>} />
        <Route path="meals" element={<Page><StudentMeals /></Page>} />
        <Route path="history" element={<Page><StudentHistory /></Page>} />
        <Route path="warnings" element={<Page><StudentWarnings /></Page>} />
        <Route path="notifications" element={<Page><Notifications narrow /></Page>} />
        <Route path="profile" element={<Page><Account narrow /></Page>} />
      </Route>

      <Route path="/supervisor" element={<RequireRole role="SUPERVISOR"><SupervisorShell /></RequireRole>}>
        <Route index element={<Page><SupOverview /></Page>} />
        <Route path="meals" element={<Page><SupMeals /></Page>} />
        <Route path="meals/:slotId" element={<Page><SupMealDetail /></Page>} />
        <Route path="meals/:slotId/reconcile" element={<Page><SupReconcile /></Page>} />
        <Route path="counter" element={<Page><SupCounter /></Page>} />
        <Route path="reconcile" element={<Page><SupReconcileList /></Page>} />
        <Route path="appeals" element={<Page><SupAppeals /></Page>} />
        <Route path="incidents" element={<Page><Incidents mode="supervisor" /></Page>} />
        <Route path="inventory" element={<Page><Inventory mode="supervisor" /></Page>} />
        <Route path="catalog" element={<Page><Catalog editable /></Page>} />
        <Route path="analyze" element={<Page><MessAnalyze /></Page>} />
        <Route path="notifications" element={<Page><Notifications /></Page>} />
        <Route path="account" element={<Page><Account /></Page>} />
      </Route>

      <Route path="/kitchen" element={<RequireRole role="KITCHEN_STAFF"><KitchenShell /></RequireRole>}>
        <Route index element={<Page><KitchenBoard /></Page>} />
        <Route path="meals/:slotId" element={<Page><KitchenMeal /></Page>} />
        <Route path="incidents" element={<Page><Incidents mode="kitchen" /></Page>} />
        <Route path="inventory" element={<Page><Inventory mode="kitchen" /></Page>} />
        <Route path="recipes" element={<Page><Catalog editable={false} /></Page>} />
        <Route path="notifications" element={<Page><Notifications /></Page>} />
        <Route path="account" element={<Page><Account /></Page>} />
      </Route>

      <Route path="/admin" element={<RequireRole role="INSTITUTION_ADMIN"><AdminShell /></RequireRole>}>
        <Route index element={<Page><AdminOverview /></Page>} />
        <Route path="accounts" element={<Page><AdminAccounts /></Page>} />
        <Route path="accounts/import" element={<Page><AdminImport /></Page>} />
        <Route path="accounts/:userId" element={<Page><AdminAccount /></Page>} />
        <Route path="structure" element={<Page><AdminStructure /></Page>} />
        <Route path="settings" element={<Page><AdminSettings /></Page>} />
        <Route path="catalog" element={<Page><Catalog editable /></Page>} />
        <Route path="analyze" element={<Page><InstitutionAnalyze /></Page>} />
        <Route path="analyze/mess/:messId" element={<Page><MessAnalyze /></Page>} />
        <Route path="audit" element={<Page><AdminAudit /></Page>} />
        <Route path="notifications" element={<Page><Notifications /></Page>} />
        <Route path="account" element={<Page><Account /></Page>} />
      </Route>

      <Route path="*" element={<Home />} />
    </Routes>
  );
}
