import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Alpha Swarm — Persistent Edge-Finding Paper Trading Engine" },
      {
        name: "description",
        content:
          "A paper trading swarm that streams every USDT perpetual, stores every signal and fill, and learns which agents, symbols and regimes actually carry edge.",
      },
      {
        property: "og:title",
        content: "Alpha Swarm — Persistent Edge-Finding Paper Trading Engine",
      },
      {
        property: "og:description",
        content:
          "Ingest, store and compound edge: per-agent, per-symbol, per-regime and confidence-calibrated paper trading.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    title: "Every signal is stored",
    body: "Consensus proposals stream into your private database with agent votes, price, regime and confidence bucket — nothing is lost on refresh.",
  },
  {
    title: "Every fill is an experiment",
    body: "Paper trades persist with entry, stop, target and realized outcome, so equity and history survive reloads and redeploys.",
  },
  {
    title: "Edge is measured, not assumed",
    body: "Win rate and expectancy are scored per agent, per symbol, per volatility regime and per confidence bucket.",
  },
  {
    title: "The engine reweights itself",
    body: "Profitable agents get amplified, losing symbols get suppressed, and the entry threshold recalibrates toward buckets that actually pay.",
  },
];

function Landing() {
  const handleDemoLaunch = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("alpha_swarm_guest", "true");
    }
  };

  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="mx-auto max-w-4xl relative z-10">
        {/* Header Branding */}
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-8 pb-8 border-b border-border/50">
          <div className="relative group flex-shrink-0">
            <div className="absolute -inset-2 rounded-3xl bg-gradient-to-r from-emerald-500/50 via-cyan-500/50 to-teal-500/50 blur-md opacity-80 group-hover:opacity-100 transition duration-500 animate-pulse" />
            <img
              src="/alpha-sword-logo.png"
              alt="Alpha Swarm Enigmatic 3D Logo"
              className="relative h-36 w-36 sm:h-44 sm:w-44 rounded-3xl object-cover border-2 border-primary/50 bg-black/80 shadow-2xl p-1.5"
            />
          </div>
          <div className="text-center sm:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.2em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Alpha Swarm v2.0 · Live Engine
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-5xl">
              A paper trading engine whose product is edge, not trades.
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground max-w-2xl">
              The swarm streams every Bybit USDT-M perpetual, runs four autonomous agents on every tick, and
              writes each signal and simulated fill to your store. Realized outcomes feed
              straight back into agent weights, symbol filters and confidence calibration.
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link
            to="/dashboard"
            onClick={handleDemoLaunch}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:brightness-110 active:scale-[0.98]"
          >
            <span>⚡ Launch Terminal</span>
          </Link>
          <Link
            to="/auth"
            className="inline-flex items-center rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition"
          >
            Sign In / Sync Account
          </Link>
        </div>

        {/* Features Grid */}
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <section
              key={f.title}
              className="rounded-xl border border-border/80 bg-card/60 p-5 backdrop-blur-sm hover:border-primary/40 transition-colors"
            >
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                {f.title}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
