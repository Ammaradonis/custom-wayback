import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { auth } from "@/lib/api.js";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    setLoading(true);
    try {
      await auth.register(email, password);
      navigate("/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password <span className="text-muted-foreground">(min 12 chars)</span>
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="confirm" className="text-sm font-medium">Confirm password</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
          {error && (
            <p className="text-sm text-red-400" role="alert">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="h-11 w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="text-accent hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
