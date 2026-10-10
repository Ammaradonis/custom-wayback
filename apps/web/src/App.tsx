import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { SwUpdateBanner } from "@/components/SwUpdateBanner.js";

const LoginPage = lazy(() => import("./routes/LoginPage.js"));
const RegisterPage = lazy(() => import("./routes/RegisterPage.js"));
const DashboardPage = lazy(() => import("./routes/DashboardPage.js"));
const ViewerPage = lazy(() => import("./routes/ViewerPage.js"));
// Phase 5 surfaces (plan.md §15) — lazy, so the shell route stays inside its
// 60 KB gzipped budget (§2.3) and only the route that is opened pays for itself.
const SearchPage = lazy(() => import("./routes/SearchPage.js"));
const ComparePage = lazy(() => import("./routes/ComparePage.js"));

function hasToken(): boolean {
  return Boolean(localStorage.getItem("cw_token"));
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  return hasToken() ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <>
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center text-muted-foreground text-sm">
            Loading…
          </div>
        }
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <DashboardPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/search"
            element={
              <PrivateRoute>
                <SearchPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/compare"
            element={
              <PrivateRoute>
                <ComparePage />
              </PrivateRoute>
            }
          />
          {/* /a/:domain/:day/* — archive viewer */}
          <Route
            path="/a/:domain/:day/*"
            element={
              <PrivateRoute>
                <ViewerPage />
              </PrivateRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>

      {/* SW update notification — renders outside Suspense so it is never blocked */}
      <SwUpdateBanner />
    </>
  );
}
