import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { localSignIn, localSignUp } from "@/lib/auth/auth.functions";
import { getLocalSession, setLocalSession } from "@/lib/auth/local-session";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => {
    const next =
      typeof search.next === "string" &&
      search.next.startsWith("/") &&
      !search.next.startsWith("//")
        ? search.next
        : undefined;
    return next ? { next } : {};
  },

  head: () => ({
    meta: [
      { title: "Sign in — Alpha Swarm Edge Engine" },
      {
        name: "description",
        content:
          "Sign in to your private Alpha Swarm paper trading engine: persistent trades, signals and learned edge statistics.",
      },
      { property: "og:title", content: "Sign in — Alpha Swarm Edge Engine" },
      {
        property: "og:description",
        content: "Private access to your persistent paper trading and edge-discovery engine.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const afterAuth = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("alpha_swarm_guest");
    }
    if (next) window.location.href = next;
    else navigate({ to: "/dashboard", replace: true });
  };

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (getLocalSession()) {
      if (next) window.location.href = next;
      else navigate({ to: "/dashboard", replace: true });
      return;
    }

  }, [navigate, next]);

  const enterAsGuest = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("alpha_swarm_guest", "true");
    }
    if (next) window.location.href = next;
    else navigate({ to: "/dashboard", replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const session = await localSignUp({ data: { email, password } });
        setLocalSession(session);
      } else {
        const session = await localSignIn({ data: { email, password } });
        setLocalSession(session);
      }
      afterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border/80 bg-card/95 p-6 sm:p-8 shadow-2xl backdrop-blur-sm relative overflow-hidden">
        {/* Ambient Top Glow */}
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-64 h-32 bg-primary/25 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col items-center text-center">
          <div className="relative group mb-2">
            <div className="absolute -inset-1.5 rounded-2xl bg-gradient-to-r from-emerald-500/40 via-cyan-500/40 to-teal-500/40 blur-sm opacity-80 group-hover:opacity-100 transition duration-300" />
            <img
              src="/alpha-sword-logo.png"
              alt="Alpha Swarm 3D Logo"
              className="relative h-28 w-28 sm:h-32 sm:w-32 rounded-2xl object-cover shadow-2xl border-2 border-primary/40 p-1.5 bg-black/70"
            />
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            Alpha Swarm — Edge Engine
          </h1>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">
            Autonomous multi-agent consensus trading engine & real-time edge discovery terminal.
          </p>
        </div>

        {/* Quick Demo Access CTA */}
        <div className="mt-6 p-3 rounded-lg border border-primary/30 bg-primary/5 text-center">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-primary">⚡ Quick Start / Local Dev</span>
            <span className="text-[10px] text-muted-foreground">No credentials required</span>
          </div>
          <button
            type="button"
            onClick={enterAsGuest}
            className="w-full rounded-md bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 px-3 py-2 text-xs font-semibold text-white shadow-md transition hover:brightness-110 active:scale-[0.99]"
          >
            Enter Alpha Swarm as Operator (Demo Mode)
          </button>
        </div>

        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground text-[10px] tracking-wider">
              Or Sign In with Neon
            </span>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@alphaswarm.com"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Authenticating…" : mode === "signin" ? "Sign in to Engine" : "Create Account"}
          </button>
        </form>

        {error && (
          <div className="mt-3 p-2 rounded bg-destructive/10 border border-destructive/20 text-xs text-destructive">
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-3 p-2 rounded bg-primary/10 border border-primary/20 text-xs text-foreground">
            {notice}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-4">
          <button
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="hover:text-foreground underline transition-colors"
          >
            {mode === "signin" ? "Need an account? Create one" : "Already registered? Sign in"}
          </button>
          <Link to="/" className="hover:text-foreground transition-colors">
            ← Home
          </Link>
        </div>
      </div>
    </main>
  );
}
