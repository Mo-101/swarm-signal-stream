import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" && search.next.startsWith("/") && !search.next.startsWith("//")
      ? search.next
      : undefined,
  }),
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
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        if (next) window.location.href = next;
        else navigate({ to: "/dashboard", replace: true });
      }
    });
  }, [navigate, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: next ? window.location.origin + next : window.location.origin,
          },
        });
        if (err) throw err;
        if (!data.session) {
          setNotice("Check your email to confirm the account, then sign in.");
          return;
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      afterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError(null);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: next ? window.location.origin + next : window.location.origin,
    });
    if (result.error) {
      setError("Google sign-in failed. Try again.");
      return;
    }
    if (result.redirected) return;
    afterAuth();
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Alpha Swarm — Edge Engine
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Your trades, signals and learned edge are stored privately to your account.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          onClick={google}
          className="mt-3 w-full rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
        >
          Continue with Google
        </button>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {notice && <p className="mt-3 text-xs text-muted-foreground">{notice}</p>}

        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="mt-4 w-full text-xs text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "Need an account? Create one" : "Already registered? Sign in"}
        </button>
      </div>
    </main>
  );
}
