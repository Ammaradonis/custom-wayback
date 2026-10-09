import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

const LoginPage = lazy(() => import("./routes/LoginPage.js"));
const RegisterPage = lazy(() => import("./routes/RegisterPage.js"));
const DashboardPage = lazy(() => import("./routes/DashboardPage.js"));
const ViewerPage = lazy(() => import("./routes/ViewerPage.js"));

function hasToken(): boolean {
  return Boolean(localStorage.getItem("cw_token"));
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  return hasToken() ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
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
  );
}
